import { describe, expect, it } from "vitest";
import {
  AdvancedSessionStore,
  isPageSiftSessionId,
  readPageSiftScrapeId,
  rewritePageSiftScrapeId,
} from "../../src/gateway/advanced-sessions.js";

describe("advanced sessions", () => {
  it("reserves, commits, resolves, and removes a ps_ session", () => {
    const now = 1_000;
    const sessions = new AdvancedSessionStore({
      now: () => now,
      randomHex: () => "a".repeat(32),
    });
    const lease = sessions.reserve();
    const publicId = lease.commit("pagesift-upstream-id");

    expect(publicId).toBe("ps_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(isPageSiftSessionId(publicId)).toBe(true);
    expect(sessions.resolve(publicId)).toBe("pagesift-upstream-id");
    expect(sessions.remove(publicId)).toBe(true);
    expect(sessions.resolve(publicId)).toBeUndefined();
    expect(sessions.size()).toBe(0);
  });

  it("does not refresh TTL on resolve", () => {
    let now = 1_000;
    const sessions = new AdvancedSessionStore({ now: () => now });
    const publicId = sessions.reserve().commit("upstream");
    now += 599_999;
    expect(sessions.resolve(publicId)).toBe("upstream");
    now += 1;
    expect(sessions.resolve(publicId)).toBeUndefined();
  });

  it("rejects new reservations at capacity and releases failed reservations", () => {
    const sessions = new AdvancedSessionStore({ maxSessions: 1 });
    const first = sessions.reserve();
    expect(() => sessions.reserve()).toThrow(
      expect.objectContaining({
        code: "advanced_session_capacity",
        statusCode: 503,
        retryAfterSeconds: 1,
      }),
    );
    first.release();
    expect(sessions.reserve().commit("upstream")).toMatch(/^ps_[0-9a-f]{32}$/);
  });

  it("reads and rewrites the PageSift scrape ID", () => {
    const value = {
      success: true,
      data: { markdown: "# Example", metadata: { scrapeId: "upstream-id" } },
    };
    expect(readPageSiftScrapeId(value)).toBe("upstream-id");
    expect(rewritePageSiftScrapeId(value, "ps_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toMatchObject({
      data: { metadata: { scrapeId: "ps_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
    });
  });
});
