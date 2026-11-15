import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYLESS_COOLDOWN_MS,
  isKeylessEnabled,
  isKeylessRoute,
  KeylessCooldown,
  parseRetryAfter,
} from "../../src/gateway/keyless.js";

describe("Firecrawl Keyless policy", () => {
  it("enables Keyless only for local firecrawl-first gateways", () => {
    expect(isKeylessEnabled({ allowRemote: false, providerMode: "firecrawl-first" })).toBe(true);
    expect(isKeylessEnabled({ allowRemote: false })).toBe(true);
    expect(isKeylessEnabled({ allowRemote: true, providerMode: "firecrawl-first" })).toBe(false);
    expect(isKeylessEnabled({ allowRemote: false, providerMode: "deepseek-first" })).toBe(false);
    expect(isKeylessEnabled({ allowRemote: false, providerMode: "no-fallback" })).toBe(false);
  });

  it("matches only documented Keyless routes", () => {
    for (const [method, path] of [
      ["POST", "/v2/scrape"],
      ["POST", "/v2/search"],
      ["POST", "/v2/parse"],
      ["POST", "/v2/parse/upload-url"],
      ["POST", "/v2/scrape/job_1/interact"],
      ["DELETE", "/v2/scrape/job_1/interact"],
      ["POST", "/v1/scrape"],
      ["POST", "/v1/search"],
      ["POST", "/v2/search/developer"],
      ["POST", "/v2/search/research"],
      ["POST", "/v2/search/government"],
      ["POST", "/v2/search/gov"],
    ] as const) {
      expect(isKeylessRoute(method, path)).toBe(true);
    }

    for (const [method, path] of [
      ["POST", "/v2/crawl"],
      ["POST", "/v2/map"],
      ["POST", "/v2/extract"],
      ["POST", "/v2/batch/scrape"],
      ["POST", "/v2/agent"],
      ["GET", "/v2/crawl/id"],
      ["POST", "/v2/interact"],
      ["GET", "/v2/scrape"],
    ] as const) {
      expect(isKeylessRoute(method, path)).toBe(false);
    }
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-11-15T00:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Sun, 15 Nov 2026 00:02:00 GMT", now)).toBe(120_000);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("-1", now)).toBeUndefined();
    expect(parseRetryAfter("invalid", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it("applies and expires the default Keyless cooldown", () => {
    const cooldown = new KeylessCooldown();
    cooldown.block(1_000, null);
    expect(cooldown.remainingMs(1_000)).toBe(DEFAULT_KEYLESS_COOLDOWN_MS);
    expect(cooldown.retryAfterSeconds(2_000)).toBe(899);
    expect(cooldown.remainingMs(1_000 + DEFAULT_KEYLESS_COOLDOWN_MS)).toBe(0);
  });

  it("uses Retry-After when blocking", () => {
    const cooldown = new KeylessCooldown();
    cooldown.block(1_000, "30");
    expect(cooldown.remainingMs(1_000)).toBe(30_000);
    expect(cooldown.retryAfterSeconds(20_000)).toBe(11);
  });
});
