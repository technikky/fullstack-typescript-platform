/**
 * Password hashing with scrypt.
 *
 * **Why scrypt and not argon2id.** Argon2id is the better choice on merit and is what I would
 * reach for with a free hand. It is not in the standard library, and every Node binding for it
 * is either a native module that has to compile on the host or a prebuilt binary per platform.
 * For a repository whose point is that a reader can clone it and have the tests pass, that is
 * a real cost. scrypt is memory-hard, is in `node:crypto`, is on OWASP's list of acceptable
 * password hashes, and needs no toolchain. The parameters below are OWASP's scrypt baseline.
 * `docs/auth.md` records the trade-off so it is a decision rather than an omission.
 *
 * **Why the parameters are in the stored string.** A hash is stored as
 * `scrypt$N$r$p$keylen$salt$hash`. Parameters get raised as hardware improves, and a store
 * that encodes only the digest cannot verify old passwords afterwards -- so either everyone is
 * locked out or the parameters can never change. Carrying them per row means `needsRehash`
 * can spot an outdated hash at login, when the plaintext is briefly available, and upgrade it
 * silently.
 *
 * **Why `timingSafeEqual`.** `===` on two buffers returns as soon as they differ, so the
 * comparison takes longer the more leading bytes match. That is measurable over enough
 * requests. `timingSafeEqual` always reads both buffers fully.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export interface ScryptParams {
  /** CPU/memory cost. Must be a power of two. */
  readonly N: number;
  /** Block size. */
  readonly r: number;
  /** Parallelisation. */
  readonly p: number;
  readonly keylen: number;
}

/** OWASP's scrypt baseline: N=2^17, r=8, p=1. */
export const DEFAULT_PARAMS: ScryptParams = { N: 131_072, r: 8, p: 1, keylen: 64 };

const SALT_BYTES = 16;
const PREFIX = "scrypt";

/**
 * scrypt needs roughly `128 * N * r` bytes. Node's default `maxmem` is 32 MiB, which N=2^17
 * exceeds, so it must be raised explicitly or hashing throws. Twice the requirement leaves
 * room for the implementation's own overhead.
 */
const maxmemFor = (params: ScryptParams): number => 256 * params.N * params.r;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Reject the passwords that are actually dangerous, and nothing else.
 *
 * Length is the only requirement that measurably helps. Composition rules ("one uppercase, one
 * digit, one symbol") push users toward `Password1!` and are not enforced here. The upper bound
 * exists because scrypt's cost scales with input length and an unbounded password is a cheap
 * way to make the server do unbounded work.
 */
export const validatePassword = (password: string): string | null => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  if (password.trim().length === 0) return "password must not be only whitespace";
  return null;
};

export const hashPassword = async (
  password: string,
  params: ScryptParams = DEFAULT_PARAMS,
): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params),
  });
  return [
    PREFIX,
    params.N,
    params.r,
    params.p,
    params.keylen,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
};

interface Parsed {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

const parse = (stored: string): Parsed | null => {
  const parts = stored.split("$");
  if (parts.length !== 7) return null;
  const [prefix, n, r, p, keylen, salt, hash] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (prefix !== PREFIX) return null;

  const params: ScryptParams = {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    keylen: Number(keylen),
  };
  if (!Number.isInteger(params.N) || params.N < 2 || (params.N & (params.N - 1)) !== 0) return null;
  if (!Number.isInteger(params.r) || params.r < 1) return null;
  if (!Number.isInteger(params.p) || params.p < 1) return null;
  if (!Number.isInteger(params.keylen) || params.keylen < 16 || params.keylen > 512) return null;

  return {
    params,
    salt: Buffer.from(salt, "base64url"),
    hash: Buffer.from(hash, "base64url"),
  };
};

/**
 * Verify a password against a stored hash.
 *
 * Returns false for a malformed stored value rather than throwing: a corrupt row must fail the
 * login, not take down the endpoint for everyone.
 */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parsed = parse(stored);
  if (parsed === null) return false;

  const derived = await scryptAsync(password, parsed.salt, parsed.params.keylen, {
    N: parsed.params.N,
    r: parsed.params.r,
    p: parsed.params.p,
    maxmem: maxmemFor(parsed.params),
  });
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
};

/** True if the stored hash used weaker parameters than the current defaults. */
export const needsRehash = (stored: string, params: ScryptParams = DEFAULT_PARAMS): boolean => {
  const parsed = parse(stored);
  if (parsed === null) return true;
  return (
    parsed.params.N < params.N ||
    parsed.params.r < params.r ||
    parsed.params.p < params.p ||
    parsed.params.keylen < params.keylen
  );
};
