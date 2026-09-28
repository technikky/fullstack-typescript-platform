# Authentication

Password storage, tokens, rotation, and the trade-offs that were chosen rather than defaulted into.

## Passwords: scrypt, and why not argon2id

Argon2id is the better algorithm and is what I would reach for with a free hand. It is not in Node's
standard library, and every binding is either a native module that must compile on the host or a
prebuilt binary per platform. For a repository whose point is that a reader can clone it and have the
tests pass, that is a real cost.

scrypt is memory-hard, is in `node:crypto`, is on OWASP's list of acceptable password hashes, and
needs no toolchain. The parameters are OWASP's scrypt baseline: **N = 2¹⁷, r = 8, p = 1**, 64-byte
output.

This is a trade-off, not a claim that scrypt is better. If the deployment can carry a native
dependency, argon2id at OWASP's parameters is the upgrade — and the stored-parameter format below is
what makes that migration possible without locking anyone out.

### The stored format carries its parameters

```
scrypt$131072$8$1$64$<salt-base64url>$<hash-base64url>
```

Parameters get raised as hardware improves. A store that encodes only the digest cannot verify old
passwords afterwards, so either everyone is locked out or the parameters can never change. Carrying
them per row means `needsRehash` can spot an outdated hash **at login**, when the plaintext is briefly
available, and upgrade it silently. That rehash is best-effort: a failure to write it must not fail a
valid login.

### Three details

- **`maxmem` is raised explicitly.** Node's default is 32 MiB and N = 2¹⁷ exceeds it, so hashing
  throws without it. This is the kind of thing that works in a test at low parameters and fails in
  production at real ones.
- **`timingSafeEqual`, not `===`.** Buffer comparison with `===` returns as soon as the buffers
  differ, so it takes longer the more leading bytes match — measurable over enough requests.
- **A corrupt stored value returns false rather than throwing.** One bad row fails one login instead
  of taking the endpoint down for everyone. Eight malformed shapes are tested, including an `N` that
  is not a power of two.

### Password rules

Length only: at least 12 characters, at most 200, not all whitespace. No composition rules, because
they push users toward `Password1!` and length is the only requirement that measurably helps. The
upper bound exists because scrypt's cost scales with input length, so an unbounded password is a cheap
way to make the server do unbounded work.

## Login does not reveal whether an account exists

A wrong password and an unknown address produce the identical message and take comparable time.

The message alone is not enough. An unknown address would return in microseconds while a known one
pays the full scrypt cost, and that difference answers the question through timing. So when the email
is not found, the code verifies the supplied password against a **decoy hash** — a real scrypt hash of
a value nobody knows, computed once at startup rather than per request.

`tests/api.test.ts` asserts the two messages are byte-identical.

## Access token: short-lived, stateless, no roles

A 10-minute HS256 JWT carrying `sub` (user), `sid` (session) and `jti`. Stateless so establishing
*who* is calling needs no database round trip.

**It carries no roles.** See [authorization.md](authorization.md) — a role in a token cannot be
revoked until the token expires.

Verification order matters: signature and claims first, denylist second. Checking the denylist first
would let an unauthenticated caller probe for valid `jti` values.

## Refresh token: opaque, hashed, rotated

32 random bytes, base64url. Not a JWT, because a refresh token must be revocable and a signed bearer
token is not.

Stored as **SHA-256**, never in plaintext: a database leak then yields no usable credential. SHA-256
is correct here and would be wrong for a password — the input is 256 bits of entropy, so there is
nothing to brute-force and nothing a slow hash would buy.

Every refresh issues a successor and marks the predecessor used, recording `replaced_by` so a family
is a traceable chain.

## Reuse detection

If a token that has already been used is presented again, either the client replayed it or an attacker
stole it — and those are indistinguishable from the server. The safe reading is theft, so the entire
**family** (every descendant of one login) is revoked and both parties must log in again.

That turns a stolen refresh token from indefinite access into at most one extra request. Without it, a
stolen token rotates happily alongside the victim's forever.

### This was a bug before it was a feature

The first implementation validated the presented token in one transaction and marked it used in a
second. The `for update` lock was released at the first commit, so two concurrent refreshes of the
same token both read `used_at is null` and **both succeeded** — which is precisely the case reuse
detection exists to catch.

The test that caught it:

```
it("only one of two simultaneous refreshes of the same token succeeds", …)
```

The fix: validation, marking used, and inserting the successor all happen in one transaction under
`for update` on the token row. The second caller blocks on the lock, then sees `used_at` set and trips
detection.

One subtlety in that transaction: the outcome is *returned* rather than thrown from inside it. The
reuse case must **commit** the family revocation before the caller sees an error, and throwing there
would roll the revocation back and leave the stolen token working.

### No grace interval, deliberately

A legitimate double-submit — two browser tabs refreshing at once — is treated as theft and logs both
out. A short reuse window (Auth0 calls it a reuse interval) is the usual mitigation, and it is
deliberately not implemented here: a token replayed inside the window would be honoured, which is the
exact attack the mechanism exists to stop.

The mitigation belongs in the client instead, and is implemented there: the API client shares **one
in-flight refresh promise** across every caller that needs one, so a burst of parallel 401s produces a
single refresh. `web/tests/api.test.ts` asserts that four concurrent requests trigger exactly one.

If the multi-tab case still proves painful in practice, a reuse interval of a few seconds is the
change to make — with the understanding of what it costs.

## Logout is immediate

Revoking the refresh family is not enough: the access token would keep working for up to ten minutes,
which is exactly what someone logging out of a shared machine does not want.

So logout also writes `denylist:access:<jti>` to Redis with a TTL of the token's **remaining**
lifetime. The denylist is therefore bounded by logouts per access-token lifetime, not by total
sessions — it cannot grow without limit.

A password change revokes every session for the user. A password change usually means the old one is
compromised, and leaving refresh tokens valid means the attacker keeps their access while the user
believes they have locked them out.

## Token storage in the browser: the honest version

`web/src/lib/api.ts` keeps the access token **in memory only** and the refresh token in
`localStorage`.

- The access token is not persisted because it lives ten minutes and storing it widens the XSS window
  for no benefit: a reload obtains a fresh one from the refresh token in a single request.
- The refresh token in `localStorage` **is a compromise**. It is readable by any script on the origin,
  so an XSS gets a 30-day credential.

The better answer is an httpOnly, Secure, SameSite cookie, which script cannot read at all. That needs
the API and the client on the same site, or a cookie-issuing proxy in front of both — a deployment
decision rather than a client one, and this repository deploys them on separate hostnames precisely so
that an XSS in the client does not inherit the API's origin.

So: `localStorage` is a known weakness, stated rather than hidden. Moving to cookies is the first
change I would make for a deployment handling real accounts, and it changes the client and the
deployment topology together.

## Rate limiting on the auth endpoints

Register, login and refresh get their own, much tighter budget: 10 requests per minute per IP against
300 for the general API.

This is the credential-stuffing surface and the one endpoint class where the caller has no identity to
key on yet, so the limit is keyed on IP and set low. Sharing the general budget would allow hundreds
of password guesses a minute. A test asserts that exhausting the auth budget leaves the general API
untouched.

## WebSocket authentication

The token arrives in the **first message**, not the query string. A URL carrying a credential ends up
in access logs, proxy logs and browser history. The browser WebSocket API cannot set headers, so the
alternatives are the subprotocol field or a first message; a first message keeps the credential out of
the handshake URL entirely.

An unauthenticated socket is closed after 10 seconds, so it cannot sit there consuming a connection
slot. The denylist is consulted here too, so a logout closes the socket's ability to reconnect as well
as its HTTP access.

## What is not implemented

- **No cookie-based sessions.** See above.
- **No multi-factor authentication.** TOTP enrolment, recovery codes and a step-up flow are a feature,
  not a configuration change.
- **No password reset.** It needs email delivery, single-use time-limited tokens, and the same
  no-enumeration discipline as login. Half of it would be worse than none.
- **No account lockout.** Rate limiting bounds the attempt rate; lockout after N failures is a
  denial-of-service vector against a known address, so it needs care rather than a counter.
- **No OAuth or SSO.** SAML and OIDC are the resume claim this repository does *not* cover.
- **No email verification.** An address is accepted as given; nothing proves the registrant controls
  it.
