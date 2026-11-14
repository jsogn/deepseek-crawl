import { describe, expect, it } from "vitest";
import { AuthFailureLimiter } from "../../src/gateway/auth-limiter.js";

describe("AuthFailureLimiter", () => {
  it("blocks a client after repeated failures and clears on success", () => {
    let now = 1_000;
    const limiter = new AuthFailureLimiter({
      failureLimit: 2,
      windowMs: 60_000,
      blockMs: 30_000,
      now: () => now,
    });

    expect(limiter.check("client").allowed).toBe(true);
    expect(limiter.failure("client").allowed).toBe(true);
    expect(limiter.failure("client")).toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    });
    expect(limiter.check("client")).toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    });

    now += 30_000;
    expect(limiter.check("client").allowed).toBe(true);
    limiter.failure("client");
    limiter.success("client");
    expect(limiter.check("client").allowed).toBe(true);
  });

  it("expires failures outside the observation window", () => {
    let now = 0;
    const limiter = new AuthFailureLimiter({
      failureLimit: 2,
      windowMs: 10_000,
      blockMs: 30_000,
      now: () => now,
    });

    limiter.failure("client");
    now = 10_001;
    expect(limiter.failure("client").allowed).toBe(true);
  });
});
