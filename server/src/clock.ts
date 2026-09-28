/**
 * Time as a dependency.
 *
 * Every expiry, every rate-limit window and every token lifetime in this codebase reads the
 * clock through here. That is what makes those behaviours testable at all: a sliding-window
 * rate limiter verified with `setTimeout` is a slow flaky test that asserts roughly the
 * right thing, while the same limiter over a controllable clock is instant and exact.
 *
 * Nothing outside this module calls `Date.now()`.
 */

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock that only moves when a test moves it. */
export class TestClock implements Clock {
  #millis: number;

  constructor(start: number | Date = 0) {
    this.#millis = start instanceof Date ? start.getTime() : start;
  }

  now(): number {
    return this.#millis;
  }

  advance(millis: number): this {
    if (millis < 0) throw new Error("a clock does not run backwards");
    this.#millis += millis;
    return this;
  }

  advanceSeconds(seconds: number): this {
    return this.advance(seconds * 1000);
  }

  set(millis: number): this {
    this.#millis = millis;
    return this;
  }
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
