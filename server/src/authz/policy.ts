/**
 * Authorization, as data.
 *
 * The permission matrix is a table, not a scattering of `if (role === "admin")`. Three things
 * follow from that, and they are the reason this file exists at all:
 *
 * 1. **One enforcement point, two transports.** REST handlers and GraphQL resolvers call the
 *    same `authorize`. The classic failure is a route that checks a role and a resolver over
 *    the same data that forgets to -- so the GraphQL surface becomes a way around the REST
 *    permissions. A parity test asserts both surfaces reach the same decision for the same
 *    actor and action.
 *
 * 2. **Adding an action forces a decision.** `PERMISSIONS` is typed as
 *    `Record<Role, Record<Action, boolean>>`, so a new `Action` is a compile error in all four
 *    role rows until it is answered. There is no default, because every default is wrong: deny
 *    silently breaks a feature, and allow silently opens a hole.
 *
 * 3. **Role alone is not the decision.** Half the interesting rules are about the resource, not
 *    the actor: a member may edit their own item but not someone else's, nobody may remove the
 *    last owner, and an admin of one workspace has no standing in another. Those live in
 *    `authorize`, which takes the resource context, and each has its own test.
 *
 * Roles are read from the database on every request and are deliberately **not** in the access
 * token. Encoding them would mean a demoted admin keeps admin until their token expires, and
 * shortening token lifetime to paper over that just trades a security hole for latency. See
 * `docs/authorization.md`.
 */

export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Higher binds tighter. Used only for "can this actor act on that member", never for reads. */
const RANK: Record<Role, number> = { owner: 4, admin: 3, member: 2, viewer: 1 };

export const ACTIONS = [
  "workspace:read",
  "workspace:update",
  "workspace:delete",
  "member:list",
  "member:invite",
  "member:role:change",
  "member:remove",
  "board:create",
  "board:read",
  "board:update",
  "board:delete",
  "item:create",
  "item:read",
  "item:update:any",
  "item:update:own",
  "item:assign",
  "item:delete:any",
  "item:delete:own",
  "comment:create",
  "comment:delete:any",
  "comment:delete:own",
  "audit:read",
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * The matrix. Every cell is written out; none is inherited.
 *
 * Role inheritance ("admin gets everything member gets, plus…") reads well and hides
 * mistakes: a permission added to `member` silently appears on `admin` and `owner` too, which
 * is sometimes right and sometimes a privilege escalation nobody reviewed. Spelling out 88
 * booleans makes every grant visible in a diff.
 */
export const PERMISSIONS: Record<Role, Record<Action, boolean>> = {
  owner: {
    "workspace:read": true,
    "workspace:update": true,
    "workspace:delete": true,
    "member:list": true,
    "member:invite": true,
    "member:role:change": true,
    "member:remove": true,
    "board:create": true,
    "board:read": true,
    "board:update": true,
    "board:delete": true,
    "item:create": true,
    "item:read": true,
    "item:update:any": true,
    "item:update:own": true,
    "item:assign": true,
    "item:delete:any": true,
    "item:delete:own": true,
    "comment:create": true,
    "comment:delete:any": true,
    "comment:delete:own": true,
    "audit:read": true,
  },
  admin: {
    "workspace:read": true,
    "workspace:update": true,
    // Deleting the workspace stays with the owner. An admin is added to help run a workspace,
    // not to be able to destroy it.
    "workspace:delete": false,
    "member:list": true,
    "member:invite": true,
    "member:role:change": true,
    "member:remove": true,
    "board:create": true,
    "board:read": true,
    "board:update": true,
    "board:delete": true,
    "item:create": true,
    "item:read": true,
    "item:update:any": true,
    "item:update:own": true,
    "item:assign": true,
    "item:delete:any": true,
    "item:delete:own": true,
    "comment:create": true,
    "comment:delete:any": true,
    "comment:delete:own": true,
    "audit:read": true,
  },
  member: {
    "workspace:read": true,
    "workspace:update": false,
    "workspace:delete": false,
    "member:list": true,
    "member:invite": false,
    "member:role:change": false,
    "member:remove": false,
    "board:create": true,
    "board:read": true,
    "board:update": false,
    "board:delete": false,
    "item:create": true,
    "item:read": true,
    // The distinction the whole matrix exists for: a member edits their own work.
    "item:update:any": false,
    "item:update:own": true,
    // Assignment is a coordination act, not an editing one: letting members reassign each
    // other's work is how an item ends up owned by whoever touched it last.
    "item:assign": false,
    "item:delete:any": false,
    "item:delete:own": true,
    "comment:create": true,
    "comment:delete:any": false,
    "comment:delete:own": true,
    // The audit log records who changed whose role. That is administrative information.
    "audit:read": false,
  },
  viewer: {
    "workspace:read": true,
    "workspace:update": false,
    "workspace:delete": false,
    "member:list": true,
    "member:invite": false,
    "member:role:change": false,
    "member:remove": false,
    "board:create": false,
    "board:read": true,
    "board:update": false,
    "board:delete": false,
    "item:create": false,
    "item:read": true,
    "item:update:any": false,
    "item:update:own": false,
    "item:assign": false,
    "item:delete:any": false,
    "item:delete:own": false,
    // A read-only role that can write comments is not read-only. Whether a commenter role
    // should exist is a product question; conflating it with `viewer` is a bug.
    "comment:create": false,
    "comment:delete:any": false,
    "comment:delete:own": false,
    "audit:read": false,
  },
};

export const can = (role: Role, action: Action): boolean => PERMISSIONS[role][action];

export interface Actor {
  readonly userId: string;
  /** The actor's role in the workspace being acted on, or null if they are not a member. */
  readonly role: Role | null;
}

export interface ResourceContext {
  /** Who created the resource being acted on, when that matters. */
  readonly ownerId?: string;
  /** For member operations: the role of the member being acted on. */
  readonly targetRole?: Role;
  /** For member operations: who is being acted on. */
  readonly targetUserId?: string;
  /** For the last-owner rule: how many owners the workspace currently has. */
  readonly ownerCount?: number;
}

export type Decision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

const allow: Decision = { allowed: true };
const deny = (reason: string): Decision => ({ allowed: false, reason });

/**
 * The single authorization entry point.
 *
 * Resource-sensitive rules are applied *before* the matrix where they are stricter than it,
 * and the `:own` / `:any` pairs are resolved here rather than by the caller -- a caller that
 * has to pick between `item:update:own` and `item:update:any` is a caller that can pick wrong.
 */
export const authorize = (
  actor: Actor,
  action: Action,
  resource: ResourceContext = {},
): Decision => {
  const { role } = actor;
  if (role === null) {
    // Not a member. Indistinguishable, from here, from a workspace that does not exist -- and
    // it should stay that way at the transport boundary, which returns 404 rather than 403 for
    // this case so membership is not an existence oracle.
    return deny("not a member of this workspace");
  }

  // `:own` / `:any` pairs. If the actor holds the `:any` form, ownership is irrelevant;
  // otherwise they need the `:own` form AND to actually own the resource.
  const ownership = OWNERSHIP_PAIRS[action];
  if (ownership !== undefined) {
    if (can(role, ownership.any)) return allow;
    if (!can(role, ownership.own)) return deny(`role ${role} cannot ${action}`);
    if (resource.ownerId === undefined) {
      // A programming error, not a permissions one: the caller asked an ownership-sensitive
      // question without saying who owns the resource. Failing closed here has caught this
      // twice in this codebase.
      return deny(`${action} requires the resource owner to be known`);
    }
    return resource.ownerId === actor.userId
      ? allow
      : deny(`role ${role} may only ${action} its own resources`);
  }

  if (!can(role, action)) return deny(`role ${role} cannot ${action}`);

  // --- rules that survive having the permission -----------------------------------

  if (action === "member:role:change" || action === "member:remove") {
    const target = resource.targetRole;
    const selfTargeted = resource.targetUserId === actor.userId;

    // Nobody may act on an owner except an owner. Without this an admin can demote or remove
    // the owner who appointed them, which is the most common RBAC escalation there is.
    if (target === "owner" && role !== "owner") {
      return deny("only an owner may change or remove another owner");
    }

    // The last owner cannot be demoted or removed, by anyone including themselves. A workspace
    // with no owner cannot be administered again: `workspace:delete` and owner-level member
    // operations would be unreachable forever.
    if (target === "owner" && (resource.ownerCount ?? 0) <= 1) {
      return deny("a workspace must keep at least one owner");
    }

    // Acting on a peer of equal or higher rank is refused, except on yourself. Two admins
    // removing each other is a race with no correct winner.
    if (!selfTargeted && target !== undefined && RANK[target] >= RANK[role] && role !== "owner") {
      return deny(`role ${role} may not act on a ${target}`);
    }
  }

  return allow;
};

/**
 * Actions that come in `:own` / `:any` pairs, keyed by BOTH members of the pair so a caller may
 * name either and get the same resolution.
 */
const OWNERSHIP_PAIRS: Partial<Record<Action, { own: Action; any: Action }>> = {
  "item:update:own": { own: "item:update:own", any: "item:update:any" },
  "item:update:any": { own: "item:update:own", any: "item:update:any" },
  "item:delete:own": { own: "item:delete:own", any: "item:delete:any" },
  "item:delete:any": { own: "item:delete:own", any: "item:delete:any" },
  "comment:delete:own": { own: "comment:delete:own", any: "comment:delete:any" },
  "comment:delete:any": { own: "comment:delete:own", any: "comment:delete:any" },
};

/**
 * Leaving a workspace is not `member:remove`.
 *
 * Any member may leave, and no role grants `member:remove` to `member` or `viewer` -- so
 * routing "leave" through the removal permission would trap everyone in every workspace they
 * joined. The only constraint is the last-owner rule, which applies to leaving as much as to
 * being removed.
 */
export const canLeave = (actor: Actor, ownerCount: number): Decision => {
  if (actor.role === null) return deny("not a member of this workspace");
  if (actor.role === "owner" && ownerCount <= 1) {
    return deny("a workspace must keep at least one owner");
  }
  return allow;
};

/** Every action a role holds. Used by the API so a client can render its UI truthfully. */
export const permissionsFor = (role: Role | null): Action[] =>
  role === null ? [] : ACTIONS.filter((action) => PERMISSIONS[role][action]);
