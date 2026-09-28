/**
 * One error taxonomy, mapped once per transport.
 *
 * The alternative -- throwing strings, or constructing HTTP responses deep in the domain --
 * is how a REST surface and a GraphQL surface over the same logic end up disagreeing about
 * what went wrong. Here the domain throws `AppError`, and each transport maps the same set
 * of codes to its own conventions: HTTP status codes for REST, `extensions.code` for GraphQL.
 * A test asserts both surfaces report the same code for the same cause.
 */

export type ErrorCode =
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "version_conflict"
  | "rate_limited"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  version_conflict: 409,
  rate_limited: 429,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  /** Safe to serialise: these fields are shown to the caller. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError("bad_request", message, details);

export const unauthenticated = (message = "authentication required"): AppError =>
  new AppError("unauthenticated", message);

/**
 * Deliberately vague by default.
 *
 * "forbidden" without naming the resource is the right answer when the caller may not know
 * the resource exists: a precise message is an existence oracle. Where the caller can
 * already see the resource, the call site passes `details` explicitly.
 */
export const forbidden = (message = "not permitted", details?: Record<string, unknown>): AppError =>
  new AppError("forbidden", message, details);

export const notFound = (resource: string, id?: string): AppError =>
  new AppError("not_found", `${resource} not found`, id === undefined ? {} : { id });

export const conflict = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError("conflict", message, details);

export const versionConflict = (currentVersion: number): AppError =>
  new AppError("version_conflict", "the resource was modified by someone else", {
    currentVersion,
  });

export const rateLimited = (retryAfterSeconds: number): AppError =>
  new AppError("rate_limited", "too many requests", { retryAfterSeconds });

export const isAppError = (value: unknown): value is AppError => value instanceof AppError;

/**
 * Turn anything thrown into an `AppError`.
 *
 * An unrecognised throw becomes `internal` with a fixed message: the original text may
 * contain a connection string, a query or a stack path, and none of that belongs in a
 * response body. The real error is logged by the caller.
 */
export const toAppError = (thrown: unknown): AppError => {
  if (isAppError(thrown)) return thrown;
  return new AppError("internal", "internal error");
};
