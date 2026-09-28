/**
 * UI permission checks.
 *
 * **This is presentation, not security.** The server checks every request against the same
 * permission matrix, reading the actor's role from the database; this only decides whether to render
 * a button. The platform's test suite calls forbidden endpoints directly with a viewer's token
 * precisely to prove that hiding a control is not a permission.
 *
 * Why do it at all, then: a UI that offers actions which always fail is worse than one that does
 * not offer them. The permission list comes from the server on every workspace fetch, so it cannot
 * drift from the server's own matrix the way a hard-coded copy of the rules would.
 */

import type { ItemStatus, Role, WorkspaceView } from "./api.js";

export const can = (view: Pick<WorkspaceView, "permissions">, action: string): boolean =>
  view.permissions.includes(action);

/**
 * Whether this actor may edit that item.
 *
 * Mirrors the server's `:own` / `:any` resolution: `item:update:any` covers everything, otherwise
 * `item:update:own` applies only to the actor's own item. Getting this wrong in the UI is cosmetic;
 * it is written out rather than approximated because "can I edit this" is asked per row and a vague
 * answer shows up as buttons that do nothing.
 */
export const canEditItem = (
  view: Pick<WorkspaceView, "permissions">,
  item: { createdBy: string },
  userId: string,
): boolean => {
  if (can(view, "item:update:any")) return true;
  return can(view, "item:update:own") && item.createdBy === userId;
};

export const canDeleteItem = (
  view: Pick<WorkspaceView, "permissions">,
  item: { createdBy: string },
  userId: string,
): boolean => {
  if (can(view, "item:delete:any")) return true;
  return can(view, "item:delete:own") && item.createdBy === userId;
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

export const STATUS_LABELS: Record<ItemStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

export const STATUS_ORDER: readonly ItemStatus[] = ["open", "in_progress", "blocked", "done"];
