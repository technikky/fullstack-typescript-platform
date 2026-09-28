/**
 * Prefixed, sortable, opaque identifiers.
 *
 * Three properties, each bought deliberately:
 *
 * - **Prefixed** (`usr_`, `wsp_`, `itm_`). An id in a log line or a bug report says what it
 *   is, and passing a board id where an item id belongs fails a cheap format check instead
 *   of returning "not found" and looking like a permissions problem.
 * - **Time-ordered.** The first 48 bits are the millisecond timestamp, so ids sort by
 *   creation and a b-tree index on the primary key stays dense rather than scattering
 *   inserts across the whole keyspace the way a v4 UUID does.
 * - **Opaque.** 80 bits of randomness follow, so an id is not guessable and does not leak a
 *   row count the way a sequential integer does.
 *
 * This is the ULID layout without the dependency. Encoding is Crockford base32, which has
 * no ambiguous characters, so an id read aloud or copied by hand survives.
 */

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

export const ID_PREFIXES = {
  user: "usr",
  workspace: "wsp",
  board: "brd",
  item: "itm",
  comment: "cmt",
  membership: "mbr",
  session: "ses",
  tokenFamily: "fam",
  refreshToken: "rft",
  audit: "aud",
  request: "req",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type Id<K extends IdKind> = string & { readonly __kind?: K };

const encodeTime = (millis: number): string => {
  let remaining = millis;
  let out = "";
  for (let position = 0; position < TIME_CHARS; position += 1) {
    out = ALPHABET[remaining % 32]! + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
};

const encodeRandom = (): string => {
  const bytes = randomBytes(RANDOM_CHARS);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % 32]!;
  return out;
};

export const newId = <K extends IdKind>(kind: K, now: number = Date.now()): Id<K> =>
  `${ID_PREFIXES[kind]}_${encodeTime(now)}${encodeRandom()}` as Id<K>;

const BODY = new RegExp(`^[${ALPHABET}]{${TIME_CHARS + RANDOM_CHARS}}$`);

export const isId = <K extends IdKind>(kind: K, value: unknown): value is Id<K> => {
  if (typeof value !== "string") return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  if (!value.startsWith(prefix)) return false;
  return BODY.test(value.slice(prefix.length));
};

/**
 * The millisecond timestamp an id was minted at.
 *
 * Useful for debugging and for asserting ordering in tests. Not a substitute for a
 * `created_at` column: a client controls nothing about this, but a caller could still mint
 * an id in advance, so the database keeps its own timestamp.
 */
export const idTime = (value: string): number | null => {
  const body = value.slice(value.indexOf("_") + 1, value.indexOf("_") + 1 + TIME_CHARS);
  if (body.length !== TIME_CHARS) return null;
  let millis = 0;
  for (const character of body) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) return null;
    millis = millis * 32 + digit;
  }
  return millis;
};
