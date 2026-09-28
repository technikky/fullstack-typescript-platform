# Authorization

The permission model, and why each decision is the way it is.

## The matrix is data

`server/src/authz/policy.ts` holds a `Record<Role, Record<Action, boolean>>` — 4 roles × 22 actions,
88 booleans, every one written out. Three consequences follow, and they are the reason it is a table
rather than a scattering of `if (role === "admin")`.

**Adding an action is a compile error until it is answered.** The type demands a decision in all four
role rows. There is no default, because every default is wrong: deny silently breaks a feature, allow
silently opens a hole.

**Every grant is visible in a diff.** Role inheritance — "admin gets everything member gets, plus…" —
reads better and hides mistakes: a permission added to `member` silently appears on `admin` and
`owner` too, which is sometimes right and sometimes a privilege escalation nobody reviewed.

**The matrix is asserted against an independent copy.** `tests/policy.test.ts` walks all 88 cells
against a list written from the intended policy rather than derived from `PERMISSIONS`. A test that
reads the matrix to check the matrix proves nothing.

| Action | owner | admin | member | viewer |
| --- | :-: | :-: | :-: | :-: |
| `workspace:read` | ✓ | ✓ | ✓ | ✓ |
| `workspace:update` | ✓ | ✓ | | |
| `workspace:delete` | ✓ | | | |
| `member:list` | ✓ | ✓ | ✓ | ✓ |
| `member:invite` | ✓ | ✓ | | |
| `member:role:change` | ✓ | ✓ | | |
| `member:remove` | ✓ | ✓ | | |
| `board:create` | ✓ | ✓ | ✓ | |
| `board:read` | ✓ | ✓ | ✓ | ✓ |
| `board:update` | ✓ | ✓ | | |
| `board:delete` | ✓ | ✓ | | |
| `item:create` | ✓ | ✓ | ✓ | |
| `item:read` | ✓ | ✓ | ✓ | ✓ |
| `item:update:any` | ✓ | ✓ | | |
| `item:update:own` | ✓ | ✓ | ✓ | |
| `item:assign` | ✓ | ✓ | | |
| `item:delete:any` | ✓ | ✓ | | |
| `item:delete:own` | ✓ | ✓ | ✓ | |
| `comment:create` | ✓ | ✓ | ✓ | |
| `comment:delete:any` | ✓ | ✓ | | |
| `comment:delete:own` | ✓ | ✓ | ✓ | |
| `audit:read` | ✓ | ✓ | | |

A few of these are judgement calls worth stating:

- **An admin cannot delete the workspace.** They are added to help run it, not to be able to destroy
  it.
- **A viewer cannot comment.** A read-only role that writes comments is not read-only. Whether a
  separate commenter role should exist is a product question; conflating it with `viewer` is a bug.
- **A member cannot reassign work, even their own item.** Assignment is a coordination act, not an
  editing one. Letting members reassign is how an item ends up owned by whoever touched it last.
- **A member can create boards.** Boards are cheap and organisational; requiring an admin for one
  makes the tool annoying without making it safer.

## Roles are not in the token

The access token carries `sub`, `sid` and `jti`, and no roles. `tests/auth.test.ts` asserts the exact
claim set, so a future change that adds one fails.

The reason: a role in a token is a role that cannot be revoked until the token expires. Demote an
admin and they keep admin for up to ten minutes — through a window that includes deleting boards and
removing members. Shortening token lifetime to paper over it trades a security hole for latency.

So authorization reads membership from the database on every request. The cost is one indexed
lookup on `(workspace_id, user_id)`, which is a primary-key-shaped query. The benefit is a test that
would otherwise be impossible:

```
it("a demotion takes effect on the very next request", …)
```

Same token, no refresh, no re-login: an admin renames the workspace, is demoted to viewer, and the
next rename returns 403.

## Role alone is not the decision

Half the interesting rules are about the resource, not the actor. These live in `authorize`, which
takes a `ResourceContext`, and each has its own test.

### Ownership: `:own` versus `:any`

A member may edit their own item and not someone else's. The matrix cannot express that, so the
action comes in a pair and `authorize` resolves it:

```ts
if (can(role, ownership.any)) return allow;            // admin: ownership irrelevant
if (!can(role, ownership.own)) return deny(…);          // viewer: no edit at all
return resource.ownerId === actor.userId ? allow : deny(…);
```

Two details that are deliberate:

- **The caller does not choose between the forms.** Both `item:update:own` and `item:update:any`
  resolve identically, because a caller that has to pick can pick wrong.
- **A missing `ownerId` denies.** That is a programming error, not a permissions one, and failing
  closed has caught a call site that forgot to pass it twice in this codebase.

### The last owner

Nobody may demote or remove the last owner — not an admin, not the owner themselves. A workspace with
no owner can never be administered again: `workspace:delete` and owner-level member operations become
unreachable forever.

The count is read **inside the transaction, with `for update` on the owner rows**. Reading it outside
would make this a race: two concurrent demotions of the two remaining owners would each see a count
of two and both succeed.

### Rank between peers

An admin may not remove another admin, except themselves. Two admins removing each other is a race
with no correct winner. And nobody may act on an owner except an owner, which closes the most common
RBAC escalation there is: an admin demoting the owner who appointed them.

### Leaving is not being removed

No role below admin holds `member:remove`, so routing "leave" through that permission would trap
every member in every workspace they ever joined. Self-removal takes `canLeave`, which enforces only
the last-owner rule.

## Cross-tenant isolation

Every method resolves the actor's role in **that resource's** workspace, in the same query that finds
the resource:

```sql
select i.*, b.workspace_id, m.role
  from items i
  join boards b on b.id = i.board_id
  left join memberships m on m.workspace_id = b.workspace_id and m.user_id = $2
 where i.id = $1
```

The bug this makes unwritable: taking a `workspaceId` from the request body and checking the role
against *that*. A caller could pass their own workspace id alongside someone else's item id and pass
the check against the wrong tenant. Because the workspace is derived from the item, there is nothing
to pass.

`tests/api.test.ts` asserts an owner of one workspace gets 404 on another's board, item, item update
and item creation.

## 404 versus 403

A non-member gets **404**, not 403. "Forbidden" confirms the resource exists, which is a slow
enumeration oracle over a guessable id space. A member who lacks a specific permission does get 403,
because they can already see the resource and need to know why the action failed.

A test asserts that "workspace that does not exist" and "workspace you are not in" produce the same
status and the same code.

## Two surfaces, one enforcement point

REST handlers and GraphQL resolvers both call the same service method. Resolvers contain no
authorization logic at all — they unwrap arguments and map errors.

`tests/parity.test.ts` runs a table of 6 operations × 5 actors (four roles plus a non-member) through
both transports and asserts the **decisions** match, normalising away the transport conventions:
REST says 403 with `error.code`, GraphQL says 200 with `errors[0].extensions.code`.

This is the test the two-surface design exists to make possible. The bug it guards against — a REST
route that checks a permission and a resolver over the same data that does not — is easy to write,
hard to notice, and turns the GraphQL endpoint into a documented way around the permission system.

## The client's copy is advisory

Every workspace response includes the actor's permission list, and the UI uses it to decide what to
render. That is presentation, not security: the server checks every request regardless, and the test
suite calls forbidden endpoints directly with a viewer's token to prove that hiding a button is not a
permission.

It is still worth sending, because a UI that offers actions which always fail is worse than one that
does not offer them — and taking the list from the server means it cannot drift from the server's own
matrix the way a hard-coded copy in the client would.

## What this model does not do

- **No field-level permissions.** A role that can read an item reads all of it. Redacting individual
  fields per role needs a different shape entirely — a projection per role rather than a boolean per
  action.
- **No custom roles.** Four fixed roles. Per-workspace custom roles mean the matrix becomes a
  database table, and then it needs its own editor, its own validation, and a migration path for
  every change.
- **No delegation or sharing.** A resource is visible to workspace members and to nobody else. There
  is no per-item ACL and no share link.
- **No organisation tier above workspaces.** Workspaces are flat. An enterprise-shaped product needs
  an org above them with its own roles, and that is a schema change rather than a policy change.
