/**
 * Configuration, validated once at startup.
 *
 * The rule this file enforces: **a misconfigured process must not start.** Reading
 * `process.env.JWT_SECRET` at the point of use means a missing secret surfaces as a signing
 * error on the first login, in production, minutes after the deploy looked successful. Parsing
 * everything up front turns that into a refusal to boot with a message naming the variable.
 *
 * The secret has no default. A development fallback is the single most common way a production
 * service ends up signing tokens with a value that is in the repository -- and once one
 * deployment has it, rotating is a coordinated outage. `openssl rand -base64 48` is in
 * `.env.example` and in the README.
 */

import { z } from "zod";

const secret = z
  .string()
  // 32 bytes of entropy is the floor for HS256: a shorter key is padded, so the effective
  // strength is whatever was supplied, not what the algorithm suggests.
  .min(32, "JWT_SECRET must be at least 32 characters; generate one with: openssl rand -base64 48");

const durationSeconds = (fallback: number) =>
  z.coerce.number().int().positive().max(60 * 60 * 24 * 365).default(fallback);

export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().default("0.0.0.0"),

  JWT_SECRET: secret,
  JWT_ISSUER: z.string().min(1).default("fullstack-typescript-platform"),
  JWT_AUDIENCE: z.string().min(1).default("platform-api"),
  ACCESS_TOKEN_TTL_SECONDS: durationSeconds(600),
  REFRESH_TOKEN_TTL_SECONDS: durationSeconds(60 * 60 * 24 * 30),

  /**
   * Absent means the in-process PostgreSQL engine, which is what makes `npm run dev` work with
   * nothing installed. Not a default for production: `NODE_ENV=production` without a URL is
   * rejected below, because an in-memory database that vanishes on restart is not a thing to
   * discover from a support ticket.
   */
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),

  RATE_LIMIT_WINDOW_SECONDS: durationSeconds(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().max(100_000).default(300),
  /** Login and registration get a much tighter budget: this is the credential-stuffing path. */
  AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().max(10_000).default(10),

  /**
   * Comma-separated. No wildcard default: `*` with credentials is rejected by browsers anyway,
   * and a permissive default is how a development convenience reaches production.
   */
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Requests larger than this are rejected before being buffered. */
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(256 * 1024),
});

export type RawConfig = z.infer<typeof configSchema>;

export interface Config {
  readonly nodeEnv: RawConfig["NODE_ENV"];
  readonly port: number;
  readonly host: string;
  readonly jwt: {
    readonly secret: Uint8Array;
    readonly issuer: string;
    readonly audience: string;
    readonly accessTtlMillis: number;
    readonly refreshTtlMillis: number;
  };
  readonly databaseUrl: string | null;
  readonly redisUrl: string | null;
  readonly rateLimit: {
    readonly windowSeconds: number;
    readonly maxRequests: number;
    readonly authMaxRequests: number;
  };
  readonly corsOrigins: readonly string[];
  readonly logLevel: RawConfig["LOG_LEVEL"];
  readonly bodyLimitBytes: number;
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  const raw = parsed.data;

  // Cross-field rules. These are the ones a per-variable schema cannot express, and they are the
  // ones that matter: each describes a combination that is individually valid and jointly wrong.
  const problems: string[] = [];
  if (raw.NODE_ENV === "production") {
    if (raw.DATABASE_URL === undefined) {
      problems.push("DATABASE_URL is required in production; the in-process database is not durable");
    }
    if (raw.REDIS_URL === undefined) {
      problems.push(
        "REDIS_URL is required in production; the in-memory key-value store is per-process, " +
          "so rate limits and token revocation would not be shared between replicas",
      );
    }
    if (raw.CORS_ORIGINS.includes("localhost")) {
      problems.push("CORS_ORIGINS still contains localhost in production");
    }
  }
  if (raw.ACCESS_TOKEN_TTL_SECONDS >= raw.REFRESH_TOKEN_TTL_SECONDS) {
    problems.push("ACCESS_TOKEN_TTL_SECONDS must be shorter than REFRESH_TOKEN_TTL_SECONDS");
  }
  if (problems.length > 0) throw new ConfigError(problems);

  const origins = raw.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    nodeEnv: raw.NODE_ENV,
    port: raw.PORT,
    host: raw.HOST,
    jwt: {
      secret: new TextEncoder().encode(raw.JWT_SECRET),
      issuer: raw.JWT_ISSUER,
      audience: raw.JWT_AUDIENCE,
      accessTtlMillis: raw.ACCESS_TOKEN_TTL_SECONDS * 1000,
      refreshTtlMillis: raw.REFRESH_TOKEN_TTL_SECONDS * 1000,
    },
    databaseUrl: raw.DATABASE_URL ?? null,
    redisUrl: raw.REDIS_URL ?? null,
    rateLimit: {
      windowSeconds: raw.RATE_LIMIT_WINDOW_SECONDS,
      maxRequests: raw.RATE_LIMIT_MAX_REQUESTS,
      authMaxRequests: raw.AUTH_RATE_LIMIT_MAX_REQUESTS,
    },
    corsOrigins: origins,
    logLevel: raw.LOG_LEVEL,
    bodyLimitBytes: raw.BODY_LIMIT_BYTES,
  };
};
