/**
 * The permission matrix, asserted exhaustively.
 *
 * Two kinds of test here, and the split is deliberate.
 *
 * The **exhaustive** tests walk every (role, action) cell -- 4 x 22 = 88 -- and assert the whole
 * grid at once against a table written independently of `PERMISSIONS`. A test that reads the
 * matrix to check the matrix proves nothing; this one would fail if a cell were flipped in either
 * place.
 *
 * The **rule** tests cover what a matrix cannot express: ownership, the last owner, rank between
 * peers, and leaving versus being removed. Each of those is a real escalation if it is wrong.
 */

import { describe, expect, it } from "vitest";

import {
  ACTIONS,
  PERMISSIONS,
  ROLES,
  authorize,
  can,
  canLeave,
  permissionsFor,
  type Action,
  type Role,
} from "../src/authz/policy.js";

/**
 * The expected grid, as a list of the actions each role holds.
 *
 * Written out from the intended policy rather than derived from `PERMISSIONS`, so the two are
 * independent statements of the same thing and a change to either without the other fails.
 */
const EXPECTED: Record<Role, readonly Action[]> = {
  owner: [...ACTIONS],
  admin: ACTIONS.filter((action) => action !== "workspace:delete"),
  member: [
    "workspace:read",
    "member:list",
    "board:create",
    "board:read",
    "item:create",
    "item:read",
    "item:update:own",
    "item:delete:own",
    "comment:create",
    "comment:delete:own",
  ],
  viewer: ["workspace:read", "member:list", "board:read", "item:read"],
};

describe("the matrix is complete", () => {
  it("has a cell for every role and action", () => {
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        expect(
          PERMISSIONS[role][action],
          `PERMISSIONS.${role} is missing a decision for ${action}`,
        ).toBeTypeOf("boolean");
      }
    }
  });

  it("has exactly 88 cells", () => {
    // If this number changes, a role or an action was added -- which is a policy decision that
    // should be reviewed, not absorbed silently.
    expect(ROLES.length * ACTIONS.length).toBe(88);
  });

  it.each(ROLES)("%s holds exactly the expected actions", (role) => {
    expect(new Set(permissionsFor(role))).toEqual(new Set(EXPECTED[role]));
  });

  it.each(ROLES.flatMap((role) => ACTIONS.map((action) => [role, action] as const)))(
    "%s / %s",
    (role, action) => {
      expect(can(role, action)).toBe(EXPECTED[role].includes(action));
    },
  );
});

describe("the matrix is ordered", () => {
  it("owner holds everything", () => {
    expect(permissionsFor("owner")).toHaveLength(ACTIONS.length);
  });

  it("only the owner may delete the workspace", () => {
    expect(can("owner", "workspace:delete")).toBe(true);
    for (const role of ["admin", "member", "viewer"] as const) {
      expect(can(role, "workspace:delete")).toBe(false);
    }
  });

  it("each role holds a subset of the one above it", () => {
    // Not how the matrix is written -- every cell is spelled out -- but a property it should
    // nonetheless have. A role that gains something its senior lacks is almost always a typo.
    const ordered: Role[] = ["viewer", "member", "admin", "owner"];
    for (let index = 0; index + 1 < ordered.length; index += 1) {
      const junior = new Set(permissionsFor(ordered[index]!));
      const senior = new Set(permissionsFor(ordered[index + 1]!));
      for (const action of junior) {
        expect(senior.has(action), `${ordered[index + 1]} lacks ${action} that ${ordered[index]} has`).toBe(true);
      }
    }
  });

  it("a viewer cannot write anything at all", () => {
    for (const action of permissionsFor("viewer")) {
      expect(action).toMatch(/:read$|:list$/);
    }
  });

  it("a viewer cannot comment", () => {
    // A read-only role that can write comments is not read-only. Whether a commenter role should
    // exist is a product question; conflating it with viewer is a bug.
    expect(can("viewer", "comment:create")).toBe(false);
  });
});

describe("a non-member is denied everything", () => {
  it.each(ACTIONS)("%s", (action) => {
    const decision = authorize({ userId: "usr_a", role: null }, action, {
      ownerId: "usr_a",
      targetRole: "member",
      ownerCount: 2,
    });
    expect(decision.allowed).toBe(false);
  });

  it("says why, without confirming the workspace exists", () => {
    const decision = authorize({ userId: "usr_a", role: null }, "workspace:read");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("not a member");
  });
});

describe("ownership-sensitive actions", () => {
  const member = { userId: "usr_member", role: "member" as Role };
  const admin = { userId: "usr_admin", role: "admin" as Role };

  it("a member may update their own item", () => {
    expect(authorize(member, "item:update:own", { ownerId: "usr_member" }).allowed).toBe(true);
  });

  it("a member may not update someone else's item", () => {
    const decision = authorize(member, "item:update:own", { ownerId: "usr_other" });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("own resources");
  });

  it("an admin may update anyone's item", () => {
    expect(authorize(admin, "item:update:own", { ownerId: "usr_other" }).allowed).toBe(true);
  });

  it("naming either half of the pair resolves the same way", () => {
    // A caller should not have to choose between `:own` and `:any`, because a caller that has to
    // choose can choose wrong.
    for (const action of ["item:update:own", "item:update:any"] as const) {
      expect(authorize(member, action, { ownerId: "usr_member" }).allowed).toBe(true);
      expect(authorize(member, action, { ownerId: "usr_other" }).allowed).toBe(false);
      expect(authorize(admin, action, { ownerId: "usr_other" }).allowed).toBe(true);
    }
  });

  it("fails closed when ownership was not supplied", () => {
    // A programming error, not a permissions one -- and the safe direction is deny. This has
    // caught a missing `ownerId` at a call site twice.
    const decision = authorize(member, "item:update:own", {});
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("owner to be known");
  });

  it("applies to comments and deletions too", () => {
    expect(authorize(member, "comment:delete:own", { ownerId: "usr_member" }).allowed).toBe(true);
    expect(authorize(member, "comment:delete:own", { ownerId: "usr_other" }).allowed).toBe(false);
    expect(authorize(member, "item:delete:own", { ownerId: "usr_other" }).allowed).toBe(false);
    expect(authorize(admin, "item:delete:own", { ownerId: "usr_other" }).allowed).toBe(true);
  });

  it("a viewer owning an item still cannot edit it", () => {
    // Ownership grants nothing on its own: the role must hold the `:own` permission first.
    const viewer = { userId: "usr_viewer", role: "viewer" as Role };
    expect(authorize(viewer, "item:update:own", { ownerId: "usr_viewer" }).allowed).toBe(false);
  });
});

describe("acting on other members", () => {
  const owner = { userId: "usr_owner", role: "owner" as Role };
  const admin = { userId: "usr_admin", role: "admin" as Role };

  it("an admin may not demote an owner", () => {
    // The most common RBAC escalation there is: an admin removing the owner who appointed them.
    const decision = authorize(admin, "member:role:change", {
      targetRole: "owner",
      targetUserId: "usr_owner",
      ownerCount: 2,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("only an owner");
  });

  it("an admin may not remove an owner", () => {
    expect(
      authorize(admin, "member:remove", {
        targetRole: "owner",
        targetUserId: "usr_owner",
        ownerCount: 2,
      }).allowed,
    ).toBe(false);
  });

  it("an owner may demote another owner when more than one remains", () => {
    expect(
      authorize(owner, "member:role:change", {
        targetRole: "owner",
        targetUserId: "usr_other_owner",
        ownerCount: 2,
      }).allowed,
    ).toBe(true);
  });

  it("the last owner cannot be demoted, even by themselves", () => {
    // A workspace with no owner can never be administered again: `workspace:delete` and
    // owner-level member operations become unreachable forever.
    const decision = authorize(owner, "member:role:change", {
      targetRole: "owner",
      targetUserId: "usr_owner",
      ownerCount: 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("at least one owner");
  });

  it("the last owner cannot be removed", () => {
    expect(
      authorize(owner, "member:remove", {
        targetRole: "owner",
        targetUserId: "usr_owner",
        ownerCount: 1,
      }).allowed,
    ).toBe(false);
  });

  it("an admin may not remove a peer admin", () => {
    const decision = authorize(admin, "member:remove", {
      targetRole: "admin",
      targetUserId: "usr_other_admin",
      ownerCount: 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("may not act on a admin");
  });

  it("an admin may remove themselves despite the peer rule", () => {
    expect(
      authorize(admin, "member:remove", {
        targetRole: "admin",
        targetUserId: "usr_admin",
        ownerCount: 1,
      }).allowed,
    ).toBe(true);
  });

  it("an admin may remove a member or a viewer", () => {
    for (const targetRole of ["member", "viewer"] as const) {
      expect(
        authorize(admin, "member:remove", {
          targetRole,
          targetUserId: "usr_target",
          ownerCount: 1,
        }).allowed,
      ).toBe(true);
    }
  });

  it("an owner may act on a peer admin", () => {
    expect(
      authorize(owner, "member:remove", {
        targetRole: "admin",
        targetUserId: "usr_admin",
        ownerCount: 1,
      }).allowed,
    ).toBe(true);
  });

  it("a member may not change anyone's role", () => {
    expect(
      authorize({ userId: "usr_m", role: "member" }, "member:role:change", {
        targetRole: "viewer",
        targetUserId: "usr_v",
        ownerCount: 1,
      }).allowed,
    ).toBe(false);
  });
});

describe("leaving is not being removed", () => {
  it("a member may leave although no role below admin can remove", () => {
    // Routing "leave" through `member:remove` would trap every member in every workspace they
    // ever joined, because `member` does not hold that permission.
    expect(can("member", "member:remove")).toBe(false);
    expect(canLeave({ userId: "usr_m", role: "member" }, 1).allowed).toBe(true);
  });

  it("a viewer may leave", () => {
    expect(canLeave({ userId: "usr_v", role: "viewer" }, 1).allowed).toBe(true);
  });

  it("the last owner may not leave", () => {
    const decision = canLeave({ userId: "usr_o", role: "owner" }, 1);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("at least one owner");
  });

  it("an owner may leave when another owner remains", () => {
    expect(canLeave({ userId: "usr_o", role: "owner" }, 2).allowed).toBe(true);
  });

  it("a non-member cannot leave", () => {
    expect(canLeave({ userId: "usr_x", role: null }, 2).allowed).toBe(false);
  });
});

describe("permissionsFor", () => {
  it("returns nothing for a non-member", () => {
    expect(permissionsFor(null)).toEqual([]);
  });

  it("returns actions in the declared order, so a client can render stably", () => {
    const listed = permissionsFor("member");
    const indices = listed.map((action) => ACTIONS.indexOf(action));
    expect(indices).toEqual([...indices].sort((left, right) => left - right));
  });
});
