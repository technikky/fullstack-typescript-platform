/**
 * Domain events, and the channel they travel on.
 *
 * Every event is scoped to a workspace, and the channel name encodes that:
 * `ws:events:<workspaceId>`. That is not cosmetic -- it is the authorization boundary. A single
 * global channel would mean every replica receives every workspace's events and each socket has
 * to be filtered individually, so one missing filter leaks another tenant's data. Per-workspace
 * channels mean a socket that is not subscribed cannot receive the message at all.
 *
 * Events are published **after** the transaction commits, never inside it. Publishing inside
 * would announce a change that a subsequent rollback undoes, and subscribers have no way to
 * take it back. The trade-off is the other direction: a crash between commit and publish loses
 * the notification. That is the right way round -- a missed live update is a stale screen until
 * the next fetch, while a phantom update is a client showing data that never existed.
 * `docs/realtime.md` records this.
 */

export type EventType =
  | "board.created"
  | "board.updated"
  | "board.deleted"
  | "item.created"
  | "item.updated"
  | "item.deleted"
  | "comment.created"
  | "comment.deleted"
  | "member.added"
  | "member.role.changed"
  | "member.removed"
  | "workspace.updated";

export interface DomainEvent {
  readonly type: EventType;
  readonly workspaceId: string;
  /** The id of the thing that changed. */
  readonly subjectId: string;
  /** Who caused it. Clients use this to skip echoing their own action. */
  readonly actorId: string;
  /** Milliseconds since the epoch, from the injected clock. */
  readonly at: number;
  /**
   * The changed entity, already shaped for the API.
   *
   * Included so a client does not have to re-fetch on every notification, which would turn one
   * write into N reads. Omitted for deletions, where there is nothing left to send.
   */
  readonly payload?: Record<string, unknown>;
}

export const workspaceChannel = (workspaceId: string): string => `ws:events:${workspaceId}`;

/**
 * Events that change who may see a workspace.
 *
 * The realtime hub re-checks membership when it sees one of these, because a socket
 * authorised at subscribe time is not authorised forever: a member removed mid-session must
 * stop receiving events immediately, not at the next reconnect. This list is what triggers
 * that re-check.
 */
export const MEMBERSHIP_EVENTS: ReadonlySet<EventType> = new Set([
  "member.removed",
  "member.role.changed",
]);

export const encodeEvent = (event: DomainEvent): string => JSON.stringify(event);

/**
 * Parse a message off the broker.
 *
 * Returns null rather than throwing on anything unrecognised. A broker is shared
 * infrastructure: another process, an old deployment mid-rollout, or a stray `redis-cli
 * publish` can put something unexpected on the channel, and that must not take down the
 * socket pump for everyone connected to this replica.
 */
export const decodeEvent = (message: string): DomainEvent | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const candidate = parsed as Partial<DomainEvent>;
  if (
    typeof candidate.type !== "string" ||
    typeof candidate.workspaceId !== "string" ||
    typeof candidate.subjectId !== "string" ||
    typeof candidate.actorId !== "string" ||
    typeof candidate.at !== "number"
  ) {
    return null;
  }
  return candidate as DomainEvent;
};

/**
 * Collects events during a unit of work and flushes them after the commit.
 *
 * Handlers append; the transport flushes. Keeping the two apart is what makes "publish only
 * what committed" the default rather than something each handler has to remember.
 */
export class EventBuffer {
  readonly #events: DomainEvent[] = [];

  add(event: DomainEvent): void {
    this.#events.push(event);
  }

  get pending(): readonly DomainEvent[] {
    return this.#events;
  }

  drain(): DomainEvent[] {
    return this.#events.splice(0, this.#events.length);
  }
}
