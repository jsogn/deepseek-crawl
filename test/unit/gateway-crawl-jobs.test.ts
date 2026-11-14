import { describe, expect, it } from "vitest";
import type { DeepSeekGateway } from "../../src/deepseek/gateway.js";
import { CrawlJobManager } from "../../src/gateway/crawl-jobs.js";

function gateway(): DeepSeekGateway {
  return {
    async search() {
      throw new Error("Unexpected Search call.");
    },
    async fetch() {
      return {
        title: "Example",
        content: "# Example",
      };
    },
  };
}

const reader = {
  async read() {
    return {
      entries: [],
      warnings: [],
      truncated: false,
    };
  },
};

describe("CrawlJobManager", () => {
  it("completes a DeepSeek-backed Firecrawl crawl job", async () => {
    const manager = new CrawlJobManager({
      now: () => new Date("2026-11-14T00:00:00.000Z"),
      idFactory: () => "dsc_test",
    });

    const created = manager.create(
      {
        url: "https://example.com/",
        limit: 2,
        maxDiscoveryDepth: 0,
        sitemap: "skip",
      },
      gateway(),
      reader,
    );

    expect(created).toEqual({
      success: true,
      id: "dsc_test",
      url: "https://example.com/",
    });
    await manager.waitForIdle("dsc_test");

    expect(manager.status("dsc_test")).toMatchObject({
      status: "completed",
      completed: 1,
      total: 1,
      creditsUsed: 0,
      createdAt: "2026-11-14T00:00:00.000Z",
      data: [
        {
          markdown: "# Example",
          metadata: {
            title: "Example",
            sourceURL: "https://example.com/",
            url: "https://example.com/",
          },
        },
      ],
    });
    expect(manager.errors("dsc_test")).toEqual({
      errors: [],
      robotsBlocked: [],
    });
  });

  it("cancels an active DeepSeek crawl", async () => {
    const manager = new CrawlJobManager({ idFactory: () => "dsc_cancel" });
    const client: DeepSeekGateway = {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      fetch(_input, signal) {
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };

    manager.create(
      {
        url: "https://example.com/",
        limit: 1,
        maxDiscoveryDepth: 0,
        sitemap: "skip",
      },
      client,
      reader,
    );

    expect(manager.cancel("dsc_cancel")).toBe(true);
    await manager.waitForIdle("dsc_cancel");
    expect(manager.status("dsc_cancel")).toMatchObject({
      status: "cancelled",
      creditsUsed: 0,
    });
  });

  it("expires completed crawl data after 24 hours", async () => {
    let current = new Date("2026-11-14T00:00:00.000Z");
    const manager = new CrawlJobManager({
      now: () => current,
      idFactory: () => "dsc_expire",
    });

    manager.create(
      {
        url: "https://example.com/",
        limit: 1,
        maxDiscoveryDepth: 0,
        sitemap: "skip",
      },
      gateway(),
      reader,
    );
    await manager.waitForIdle("dsc_expire");
    expect(manager.status("dsc_expire")).toBeDefined();

    current = new Date("2026-11-15T00:00:00.001Z");
    expect(manager.status("dsc_expire")).toBeUndefined();
    expect(manager.errors("dsc_expire")).toBeUndefined();
  });

  it("clamps Crawl controls to the existing DeepSeek engine limits", async () => {
    const manager = new CrawlJobManager({ idFactory: () => "dsc_limits" });

    expect(() =>
      manager.create(
        {
          url: "https://example.com/",
          limit: 10_000,
          maxDiscoveryDepth: 20,
          maxConcurrency: 20,
          sitemap: "skip",
        },
        gateway(),
        reader,
      ),
    ).not.toThrow();
    await manager.waitForIdle("dsc_limits");
  });

  it.each([
    [{ scrapeOptions: { formats: ["screenshot"] } }, /markdown/i],
    [{ allowExternalLinks: true }, /external/i],
    [{ allowSubdomains: true }, /subdomain/i],
  ])("rejects an unsupported DeepSeek Crawl option %#", (options, message) => {
    const manager = new CrawlJobManager({ idFactory: () => "dsc_unsupported" });
    expect(() =>
      manager.create(
        {
          url: "https://example.com/",
          sitemap: "skip",
          ...options,
        },
        gateway(),
        reader,
      ),
    ).toThrow(message);
  });

  it("returns concurrent crawl pages in deterministic index order", async () => {
    const manager = new CrawlJobManager({ idFactory: () => "dsc_order" });
    const client: DeepSeekGateway = {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch(input) {
        if (input.url === "https://example.com/") {
          return {
            title: "Home",
            content: "[A](/a) [B](/b)",
          };
        }
        if (input.url.endsWith("/a")) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { title: "A", content: "# A" };
        }
        return { title: "B", content: "# B" };
      },
    };

    manager.create(
      {
        url: "https://example.com/",
        limit: 3,
        maxDiscoveryDepth: 1,
        maxConcurrency: 2,
        sitemap: "skip",
      },
      client,
      reader,
    );
    await manager.waitForIdle("dsc_order");

    expect(manager.status("dsc_order")?.data.map((page) => page.metadata.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("reports a failed Crawl with its seed error", async () => {
    const manager = new CrawlJobManager({ idFactory: () => "dsc_failed" });
    const client: DeepSeekGateway = {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch() {
        throw new Error("Seed unavailable");
      },
    };

    manager.create(
      {
        url: "https://example.com/",
        limit: 1,
        maxDiscoveryDepth: 0,
        sitemap: "skip",
      },
      client,
      reader,
    );
    await manager.waitForIdle("dsc_failed");

    expect(manager.status("dsc_failed")).toMatchObject({
      status: "failed",
      completed: 0,
      total: 0,
      creditsUsed: 0,
    });
    expect(manager.errors("dsc_failed")).toMatchObject({
      errors: [
        {
          url: "https://example.com/",
          error: "Seed unavailable",
        },
      ],
      robotsBlocked: [],
    });
  });
});
