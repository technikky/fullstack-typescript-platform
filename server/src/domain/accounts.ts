/**
 * Registration, login and the current user.
 *
 * Two behaviours here are security properties rather than conveniences, and both are tested:
 *
 * **Login does not say whether the email exists.** A wrong password and an unknown address both
 * produce the same message. Otherwise the login form is a membership oracle: try an address, and
 * the error tells you whether that person has an account.
 *
 * **Login hashes even when the user is missing.** An unknown address would otherwise return in
 * microseconds while a known one takes the full scrypt cost, and that difference is measurable
 * over enough attempts -- so the identical error message would leak the answer through timing
 * anyway. A dummy verification against a fixed hash keeps the two paths comparable.
 */

import type { Clock } from "../clock.js";
import { badRequest, conflict, unauthenticated } from "../errors.js";
import { newId } from "../ids.js";
import type { Database } from "../ports/database.js";
import { isUniqueViolation } from "../ports/database.js";
import {
  hashPassword,
  needsRehash,
  validatePassword,
  verifyPassword,
} from "../auth/password.js";
import type { TokenPair, TokenService } from "../auth/tokens.js";
import {
  normaliseEmail,
  toUser,
  toUserWithSecret,
  type User,
  type UserRow,
} from "./types.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 254;

/**
 * Email validation, kept deliberately loose.
 *
 * RFC 5322 permits addresses that no provider accepts, and every regex claiming to implement it
 * rejects valid ones. The only reliable proof that an address works is sending mail to it. This
 * checks the shape that catches typos -- one `@`, a dot in the domain, no whitespace -- and
 * enforces the 254-character limit from RFC 5321, which is a real bound.
 */
export const validateEmail = (email: string): string | null => {
  if (email.length === 0) return "email is required";
  if (email.length > MAX_EMAIL_LENGTH) return `email must be at most ${MAX_EMAIL_LENGTH} characters`;
  if (!EMAIL_PATTERN.test(email)) return "email is not a valid address";
  return null;
};

export const validateName = (name: string): string | null => {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "name is required";
  if (trimmed.length > 200) return "name must be at most 200 characters";
  return null;
};

export interface RegisterInput {
  readonly email: string;
  readonly name: string;
  readonly password: string;
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export interface Authenticated {
  readonly user: User;
  readonly tokens: TokenPair;
}

export class AccountService {
  readonly #database: Database;
  readonly #tokens: TokenService;
  readonly #clock: Clock;
  /**
   * A real scrypt hash of a value nobody knows, verified against when the email is unknown so
   * the two paths cost the same. Computed once at startup rather than per request: it is
   * constant, and paying for it on every failed login would double the cost of the attack it
   * exists to prevent.
   */
  #decoyHash: Promise<string> | null = null;

  constructor(options: { database: Database; tokens: TokenService; clock: Clock }) {
    this.#database = options.database;
    this.#tokens = options.tokens;
    this.#clock = options.clock;
  }

  #decoy(): Promise<string> {
    this.#decoyHash ??= hashPassword(newId("user"));
    return this.#decoyHash;
  }

  async register(input: RegisterInput): Promise<Authenticated> {
    const email = normaliseEmail(input.email);
    const name = input.name.trim();

    for (const problem of [
      validateEmail(email),
      validateName(name),
      validatePassword(input.password),
    ]) {
      if (problem !== null) throw badRequest(problem);
    }

    const passwordHash = await hashPassword(input.password);
    const id = newId("user", this.#clock.now());

    let row: UserRow | undefined;
    try {
      const inserted = await this.#database.query<UserRow>(
        `insert into users (id, email, name, password_hash, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $5)
         returning id, email, name, password_hash, created_at`,
        [id, email, name, passwordHash, new Date(this.#clock.now())],
      );
      row = inserted.rows[0];
    } catch (thrown) {
      // The unique index is what decides, not a prior SELECT: two simultaneous registrations
      // with the same address would both pass a check-then-insert.
      if (isUniqueViolation(thrown)) throw conflict("an account with that email already exists");
      throw thrown;
    }
    if (row === undefined) throw new Error("insert returned no row");

    return { user: toUser(row), tokens: await this.#tokens.issue(row.id) };
  }

  async login(credentials: Credentials): Promise<Authenticated> {
    const email = normaliseEmail(credentials.email);
    const found = await this.#database.query<UserRow>(
      `select id, email, name, password_hash, created_at from users where lower(email) = $1`,
      [email],
    );
    const row = found.rows[0];

    if (row === undefined) {
      // Same cost, same message. Both halves are needed: identical wording with different
      // timing still answers the question.
      await verifyPassword(credentials.password, await this.#decoy());
      throw unauthenticated("email or password is incorrect");
    }

    const user = toUserWithSecret(row);
    if (!(await verifyPassword(credentials.password, user.passwordHash))) {
      throw unauthenticated("email or password is incorrect");
    }

    // The one moment the plaintext is available, so the one moment a parameter upgrade is
    // possible. Done after authentication succeeds, and failures are swallowed: a rehash that
    // cannot be written must not fail a valid login.
    if (needsRehash(user.passwordHash)) {
      await this.#rehash(user.id, credentials.password).catch(() => undefined);
    }

    return { user: toUser(row), tokens: await this.#tokens.issue(row.id) };
  }

  async #rehash(userId: string, password: string): Promise<void> {
    const hash = await hashPassword(password);
    await this.#database.query(
      `update users set password_hash = $1, updated_at = $2 where id = $3`,
      [hash, new Date(this.#clock.now()), userId],
    );
  }

  async byId(userId: string): Promise<User | null> {
    const found = await this.#database.query<UserRow>(
      `select id, email, name, password_hash, created_at from users where id = $1`,
      [userId],
    );
    const row = found.rows[0];
    return row === undefined ? null : toUser(row);
  }

  async byEmail(email: string): Promise<User | null> {
    const found = await this.#database.query<UserRow>(
      `select id, email, name, password_hash, created_at from users where lower(email) = $1`,
      [normaliseEmail(email)],
    );
    const row = found.rows[0];
    return row === undefined ? null : toUser(row);
  }

  /**
   * Change a password, then revoke every session.
   *
   * Revocation is the point. A password change usually means the old one is compromised, and
   * leaving existing refresh tokens valid means the attacker keeps their access while the user
   * believes they have locked them out.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ revokedSessions: number }> {
    const problem = validatePassword(newPassword);
    if (problem !== null) throw badRequest(problem);

    const found = await this.#database.query<UserRow>(
      `select id, email, name, password_hash, created_at from users where id = $1`,
      [userId],
    );
    const row = found.rows[0];
    if (row === undefined) throw unauthenticated("account no longer exists");
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      throw unauthenticated("current password is incorrect");
    }
    if (await verifyPassword(newPassword, row.password_hash)) {
      throw badRequest("the new password must differ from the current one");
    }

    await this.#rehash(userId, newPassword);
    return { revokedSessions: await this.#tokens.revokeAllForUser(userId) };
  }
}
