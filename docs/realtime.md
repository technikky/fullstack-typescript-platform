# Realtime

WebSocket delivery: the protocol, the fan-out, the authorization, and the reconnection.

## The protocol

One socket per client, on `/ws`, sharing the HTTP port. JSON frames.

| Client → server | |
| --- | --- |
| `{type:"authenticate", token}` | Must be first. 10-second deadline. |
| `{type:"subscribe", workspaceId}` | Authorised against membership. |
| `{type:"unsubscribe", workspaceId}` | |
| `{type:"ping"}` | Answered before authentication too, so a slow client is not dropped as idle. |

| Server → client | |
| --- | --- |
| `{type:"ready", userId}` | Authenticated. |
| `{type:"subscribed", workspaceId}` | |
| `{type:"unsubscribed", workspaceId, reason?}` | `reason: "access revoked"` when the server dropped it. |
| `{type:"event", event}` | A domain event, with the changed entity. |
| `{type:"error", code, message}` | |
| `{type:"pong"}` | |

Close codes in the 4000–4999 application range: `4001` invalid token, `4002` authentication timeout,
`4003` protocol violation. The client treats all three as "do not retry" — a bad token will still be
bad in 500 ms, and retrying burns the rate limit while delaying the sign-in prompt the user needs.

## The token is in the first message, not the URL

A handshake URL carrying a credential ends up in access logs, proxy logs and browser history. The
browser WebSocket API cannot set headers, so the options are the subprotocol field or a first message;
a first message keeps the credential out of the URL entirely.

An unauthenticated socket is closed after 10 seconds so it cannot sit there consuming a slot, and its
timer is `unref`'d so it does not hold the process open during shutdown.

## Fan-out goes through the broker

The hub publishes to `ws:events:<workspaceId>` and subscribes per socket. It never iterates its own
connection list.

That distinction is the whole design. Iterating local sockets works perfectly on one replica and
silently breaks on two: a client connected to pod A never sees a change made on pod B. The failure is
invisible in development, because there is only ever one process — which is exactly why it needs a
test rather than a code review.

`tests/realtime.test.ts` asserts it with **two hubs sharing one broker**, the same topology as two
pods sharing one Redis:

```
it("an event published on one hub reaches a subscriber on another", …)
```

`RedisBroker` uses two connections, because a Redis connection in subscribe mode cannot issue other
commands. Sharing one would make `publish` fail as soon as anything subscribed — a bug that only
appears once a second feature starts using the broker.

## The channel is the authorization boundary

Per-workspace channels, not one global channel with per-socket filtering. A socket that is not
subscribed cannot receive another workspace's events **at all**, rather than receiving them and being
filtered — one missing filter would leak another tenant's data.

Subscribing is authorised against membership, and a workspace the caller cannot see produces the same
`not_found` as one that does not exist. A socket must not be a cheaper membership oracle than the HTTP
API.

## Access is re-checked on delivery

A socket authorised at subscribe time stays open for hours. A member removed in minute two must stop
receiving events in minute two, not at their next reconnect.

So membership-changing events (`member.removed`, `member.role.changed`) trigger a re-check before
delivery. If the actor is no longer a member, the hub sends
`{type:"unsubscribed", reason:"access revoked"}`, drops the subscription, and **does not deliver the
event** — it describes a workspace they can no longer see.

Only those events trigger it. Re-checking on every event would mean a database query per event per
socket, turning one busy board into a query storm; membership events are the only ones that can revoke
access, and they are rare. There is a test for that distinction specifically: a board event is
delivered with the membership row deleted behind the hub's back, and the next membership event cuts
the socket off.

A **demotion** keeps the subscription. The check asks whether they are still a member, not whether
their role changed: a demotion narrows what they may do, not what they may see.

## Events are published after the commit, and only on success

Handlers append to an `EventBuffer`; the `onResponse` hook drains it and publishes only when the status
is below 400.

- Publishing **inside** the transaction would announce a change a rollback then undoes, and
  subscribers cannot take it back.
- Publishing **before the status is known** would announce changes a later error means did not happen.

The trade-off runs the other way, deliberately: a crash between commit and publish loses the
notification. A missed live update is a stale screen until the next fetch; a phantom update is a client
showing data that never existed. For the same reason a broker outage is logged and the request still
returns its 2xx — the write committed, and failing the response would be a lie in the other direction.

Both surfaces feed the same buffer, so realtime is not a REST-only feature. A test asserts a GraphQL
mutation publishes the same event.

## Events carry the entity and the actor

`payload` holds the changed entity, already shaped for the API, so a client does not re-fetch on every
notification — otherwise one write becomes N reads across every connected client. Deletions carry no
payload, because there is nothing left to send.

`actorId` lets a client skip its own echo. The response to its own request already carried the
authoritative row; applying the event too would replace it and flicker, and can discard an in-flight
optimistic update. `web/tests/components.test.tsx` asserts both the merge of another user's event and
the ignoring of one's own.

A malformed message on the channel is ignored rather than fatal. A broker is shared infrastructure:
another process, an old deployment mid-rollout, or a stray `redis-cli publish` must not take down the
socket pump for everyone on this replica.

## Reconnection

In `web/src/lib/realtime.ts`.

**Exponential backoff, 500 ms to 30 s, with full jitter.** The jitter is the part that matters. Without
it, clients that disconnected together stay in lockstep and retry together forever — the backoff curve
changes but the thundering herd does not. Full jitter draws uniformly from `[delay/2, delay]`, so a
fleet that dropped together returns spread out.

**Subscriptions are replayed on `ready`.** A client that reconnects but forgets what it was watching
shows data that silently stops updating, which is worse than a visible disconnection.

**The attempt counter resets on `ready`, not on `open`.** A socket that opens and is then rejected has
not succeeded; resetting on `open` would turn a rejection loop into a tight retry loop.

**A subscription the server dropped is forgotten.** Otherwise the next reconnect asks again, is refused
again, and the cycle repeats.

**A deliberate close cancels any pending retry.** Otherwise a client that signed out reconnects a
moment later with a token it no longer has.

The UI surfaces all of this through a connection badge that says *"what you see may be out of date"*
whenever the socket is not ready. A user who cannot tell "nothing changed" from "I stopped being told
about changes" will trust stale data.

## Deployment notes

- **Session affinity.** The `Service` uses `ClientIP` so a client stays on the pod it authenticated
  against for the life of the connection. Blunt — it also pins HTTP requests — but the alternative is a
  reconnect every time the session moves.
- **Ingress timeouts.** nginx's default 60-second read timeout would close every idle socket once a
  minute and the whole fleet would reconnect on that cadence. Raised to an hour, with the client's
  `ping` as the keepalive.
- **Scale-down is slow on purpose.** The HPA waits five minutes before removing a pod: every removed
  pod drops its sockets, those clients reconnect onto the remaining pods, and that raises their CPU —
  which would scale back up. Prompt scale-in looks efficient and causes flapping.

## What is not implemented

- **No message history or replay.** A client that was disconnected misses what happened; it refetches
  on reconnect. Durable per-workspace streams (Redis Streams, or a log) would be the upgrade.
- **No delivery guarantee.** At-most-once. A crash between commit and publish loses the notification,
  by choice.
- **No GraphQL subscriptions.** The transport is this protocol. Wrapping it in
  `graphql-ws` would add a spec and a library without changing what is delivered.
- **No presence or typing indicators.** No "who else is here" — that needs its own ephemeral state and
  its own expiry story.
- **No per-socket backpressure.** A client that stops reading has its frames queued by `ws` and the
  kernel; a slow consumer is not detected or disconnected.
