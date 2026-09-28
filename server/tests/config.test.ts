/**
 * Configuration validation.
 *
 * The rule under test: a misconfigured process must not start. Reading `process.env` at the point
 * of use means a missing secret surfaces as a signing failure on the first login, in production,
 * minutes after the deploy looked green. These tests assert the failure happens at boot instead,
 * with the offending variable named.
 *
 * The production cross-field rules are the interesting half. Each describes a combination that is
 * individually valid and jointly wrong -- and each is a real outage: an in-memory database that
 * vanishes on restart, rate limits that are per-replica rather than shared, a CORS allow list that
 * still trusts localhost.
 */

import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

const VALID_SECRET = "a-secret-that-is-comfortably-over-32-characters";

const env = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  JWT_SECRET: VALID_SECRET,
  ...overrides,
});

const problems = (overrides: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(env(overrides));
    return [];
  } catch (thrown) {
    if (thrown instanceof ConfigError) return [...thrown.problems];
    throw thrown;
  }
};

describe("defaults", () => {
  it("loads with only a secret set", () => {
    const config = loadConfig(env());
    expect(config.nodeEnv).toBe("development");
    expect(config.port).toBe(4000);
    expect(config.jwt.accessTtlMillis).toBe(600_000);
    expect(config.jwt.refreshTtlMillis).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("falls back to the in-process database and in-memory store outside production", () => {
    // This is what makes `npm run dev` and the whole test suite work with nothing installed.
    const config = loadConfig(env());
    expect(config.databaseUrl).toBeNull();
    expect(config.redisUrl).toBeNull();
  });

  it("encodes the secret as bytes, not a string", () => {
    const config = loadConfig(env());
    expect(config.jwt.secret).toBeInstanceOf(Uint8Array);
    expect(config.jwt.secret.length).toBeGreaterThanOrEqual(32);
  });

  it("splits and trims the CORS list, dropping empties", () => {
    const config = loadConfig(
      env({ CORS_ORIGINS: " http://a.test , http://b.test ,, http://c.test " }),
    );
    expect(config.corsOrigins).toEqual(["http://a.test", "http://b.test", "http://c.test"]);
  });

  it("has no wildcard CORS default", () => {
    // `*` with credentials is rejected by every browser anyway, and a permissive default is how a
    // development convenience reaches production.
    expect(loadConfig(env()).corsOrigins).not.toContain("*");
  });
});

describe("the secret", () => {
  it("is required, with no development fallback", () => {
    // The single most common way a production service ends up signing tokens with a value that is
    // in the repository. Once one deployment has it, rotating is a coordinated outage.
    expect(problems({ JWT_SECRET: undefined })).toEqual([
      expect.stringContaining("JWT_SECRET"),
    ]);
  });

  it("must be long enough for HS256", () => {
    // A shorter key is padded, so the effective strength is whatever was supplied rather than what
    // the algorithm name suggests.
    const reported = problems({ JWT_SECRET: "too-short" });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("at least 32 characters");
    expect(reported[0]).toContain("openssl rand");
  });
});

describe("numeric and enum coercion", () => {
  it("coerces numbers from strings", () => {
    const config = loadConfig(env({ PORT: "8080", RATE_LIMIT_MAX_REQUESTS: "42" }));
    expect(config.port).toBe(8080);
    expect(config.rateLimit.maxRequests).toBe(42);
  });

  it("rejects a non-numeric port, a port out of range, and a negative limit", () => {
    expect(problems({ PORT: "not-a-number" })).toHaveLength(1);
    expect(problems({ PORT: "0" })).toHaveLength(1);
    expect(problems({ PORT: "70000" })).toHaveLength(1);
    expect(problems({ RATE_LIMIT_MAX_REQUESTS: "-1" })).toHaveLength(1);
    expect(problems({ RATE_LIMIT_MAX_REQUESTS: "0" })).toHaveLength(1);
  });

  it("rejects an unknown NODE_ENV or log level", () => {
    expect(problems({ NODE_ENV: "staging" })).toHaveLength(1);
    expect(problems({ LOG_LEVEL: "verbose" })).toHaveLength(1);
  });

  it("names the variable in the message", () => {
    // A boot failure that does not say which variable is wrong costs more than no validation.
    expect(problems({ PORT: "nope" })[0]).toContain("PORT");
  });

  it("reports every problem at once, rather than one per restart", () => {
    const reported = problems({ PORT: "nope", LOG_LEVEL: "verbose", NODE_ENV: "staging" });
    expect(reported).toHaveLength(3);
  });
});

describe("cross-field rules", () => {
  it("rejects an access token that outlives its refresh token", () => {
    const reported = problems({
      ACCESS_TOKEN_TTL_SECONDS: "3600",
      REFRESH_TOKEN_TTL_SECONDS: "600",
    });
    expect(reported).toEqual([expect.stringContaining("must be shorter than")]);
  });

  it("rejects equal lifetimes too", () => {
    // Equal makes the refresh token pointless: it expires exactly when the thing it would refresh
    // does.
    expect(
      problems({ ACCESS_TOKEN_TTL_SECONDS: "600", REFRESH_TOKEN_TTL_SECONDS: "600" }),
    ).toHaveLength(1);
  });
});

describe("production requires real infrastructure", () => {
  const production = (overrides: Record<string, string | undefined> = {}) =>
    problems({
      NODE_ENV: "production",
      CORS_ORIGINS: "https://app.example.com",
      DATABASE_URL: "postgres://user:pass@db:5432/platform",
      REDIS_URL: "redis://cache:6379",
      ...overrides,
    });

  it("accepts a complete production configuration", () => {
    expect(production()).toEqual([]);
  });

  it("refuses to start without a database URL", () => {
    // An in-memory database that vanishes on restart is not a thing to discover from a support
    // ticket.
    expect(production({ DATABASE_URL: undefined })).toEqual([
      expect.stringContaining("DATABASE_URL is required in production"),
    ]);
  });

  it("refuses to start without Redis", () => {
    // The in-memory store is per-process, so with two replicas a rate limit would be twice as
    // permissive as configured and a logout would only revoke the token on one of them.
    const reported = production({ REDIS_URL: undefined });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("REDIS_URL is required in production");
    expect(reported[0]).toContain("replicas");
  });

  it("refuses a production CORS list that still trusts localhost", () => {
    const reported = production({ CORS_ORIGINS: "https://app.example.com,http://localhost:3000" });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("localhost");
    // The message names the opt-out, so the fix is discoverable from the failure alone.
    expect(reported[0]).toContain("ALLOW_LOCALHOST_CORS");
  });

  it("permits localhost in production when it is opted into explicitly", () => {
    // The `docker compose` stack runs the production build for a browser on the host, which is
    // legitimate. "Production mode" and "reachable from the internet" are not the same thing, and
    // the process cannot tell them apart -- so the distinction is made by an explicit flag rather
    // than by weakening the rule.
    expect(
      production({
        CORS_ORIGINS: "http://localhost:3000",
        ALLOW_LOCALHOST_CORS: "true",
      }),
    ).toEqual([]);
  });

  it("treats any value other than true as not opted in", () => {
    // A typo must fail closed. Only the literal "true" opts in; "1", "yes" and "TRUE" do not,
    // and an unrecognised value is a configuration error rather than a silent false.
    for (const value of ["1", "yes", "TRUE", "on"]) {
      expect(
        production({ CORS_ORIGINS: "http://localhost:3000", ALLOW_LOCALHOST_CORS: value }),
        value,
      ).not.toEqual([]);
    }
  });

  it("does not require the opt-out outside production", () => {
    expect(problems({ CORS_ORIGINS: "http://localhost:3000" })).toEqual([]);
  });

  it("exposes the flag on the parsed config", () => {
    expect(loadConfig(env()).allowLocalhostCors).toBe(false);
    expect(loadConfig(env({ ALLOW_LOCALHOST_CORS: "true" })).allowLocalhostCors).toBe(true);
  });

  it("reports every production problem together", () => {
    expect(
      production({ DATABASE_URL: undefined, REDIS_URL: undefined, CORS_ORIGINS: "http://localhost:3000" }),
    ).toHaveLength(3);
  });

  it("imposes none of those rules outside production", () => {
    // Development must stay zero-setup, which is the whole reason the fallbacks exist.
    expect(problems({ NODE_ENV: "development" })).toEqual([]);
    expect(problems({ NODE_ENV: "test" })).toEqual([]);
  });
});

describe("ConfigError", () => {
  it("lists every problem in its message", () => {
    try {
      loadConfig(env({ PORT: "nope", LOG_LEVEL: "verbose" }));
      throw new Error("expected loadConfig to throw");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(ConfigError);
      const error = thrown as ConfigError;
      expect(error.message).toContain("invalid configuration");
      for (const problem of error.problems) expect(error.message).toContain(problem);
    }
  });
});
