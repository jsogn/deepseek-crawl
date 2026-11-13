import { describe, expect, it } from "vitest";
import { DeepSeekError } from "../../src/deepseek/errors.js";

describe("DeepSeekError", () => {
  it("retains stable metadata", () => {
    const error = new DeepSeekError("rate limited", {
      kind: "rate_limit",
      status: 429,
      requestId: "req-1",
    });
    expect(error.name).toBe("DeepSeekError");
    expect(error.kind).toBe("rate_limit");
    expect(error.status).toBe(429);
    expect(error.requestId).toBe("req-1");
  });

  it("preserves a cause", () => {
    const cause = new Error("socket closed");
    const error = new DeepSeekError("network failed", { kind: "network", cause });
    expect(error.cause).toBe(cause);
  });
});
