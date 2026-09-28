"use client";

/**
 * The live-connection indicator.
 *
 * Small, and it earns its place: a client whose socket has dropped shows data that silently stops
 * updating, and nothing on screen says so. A user who cannot tell the difference between "nothing
 * has changed" and "I stopped being told about changes" will trust stale data.
 *
 * `aria-live="polite"` so a screen reader announces a state change without interrupting, and
 * `role="status"` so it is announced at all.
 */

import type { ConnectionState } from "@/lib/realtime";

const LABELS: Record<ConnectionState, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  authenticating: "Authenticating…",
  ready: "Live",
  reconnecting: "Reconnecting…",
  closed: "Offline",
};

/** Whether what is on screen can still be trusted to be current. */
const STALE: ReadonlySet<ConnectionState> = new Set(["idle", "reconnecting", "closed"]);

export interface ConnectionBadgeProps {
  readonly state: ConnectionState;
  /** Shown when reconnecting, so the wait is visible rather than mysterious. */
  readonly attempts?: number;
}

export const ConnectionBadge = ({ state, attempts = 0 }: ConnectionBadgeProps): React.JSX.Element => (
  <span className={`badge badge-${state}`} role="status" aria-live="polite">
    <span aria-hidden="true" className="dot" />
    {LABELS[state]}
    {state === "reconnecting" && attempts > 1 ? ` (attempt ${attempts})` : ""}
    {STALE.has(state) && (
      <span className="muted"> — what you see may be out of date</span>
    )}
  </span>
);
