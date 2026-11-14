import { describe, expect, it } from "vitest";
import type { DeepSeekGateway } from "../../src/deepseek/gateway.js";
import { CrawlJobManager } from "../../src/gateway/crawl-jobs.js";
import { GatewayCapacityError } from "../../src/gateway/errors.js";

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
  it("rejects a retained job capacity below the running job limit", () => {
    expect(
      () =>
        new CrawlJobManager({
          maxRunningJobs: 2,
          maxRetainedJobs: 1,
        }),
    ).toThrow(/retained.*running|running.*retained/i);
  });

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

  it("does not start a crawl when its start signal aborts after creation", async () => {
    let calls = 0;
    const manager = new CrawlJobManager({ idFactory: () => "dsc_start_abort" });
    const controller = new AbortController();

    manager.create(
      { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
      {
        async search() {
          throw new Error("Unexpected Search call.");
        },
        async fetch() {
          calls += 1;
          return { title: "Example", content: "# Example" };
        },
      },
      reader,
      controller.signal,
    );
    controller.abort(new Error("Create response disconnected."));
    await manager.waitForIdle("dsc_start_abort");

    expect(calls).toBe(0);
    expect(manager.status("dsc_start_abort")).toMatchObject({
      status: "cancelled",
      completed: 0,
      data: [],
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

  it("sweeps expired jobs without waiting for client access", async () => {
    let current = new Date("2026-11-14T00:00:00.000Z");
    const manager = new CrawlJobManager({
      now: () => current,
      idFactory: () => "dsc_sweep",
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
    await manager.waitForIdle("dsc_sweep");

    current = new Date("2026-11-15T00:00:00.001Z");
    expect(manager.sweepExpired()).toBe(1);
    expect(manager.status("dsc_sweep")).toBeUndefined();
  });

  it("limits running crawl jobs without counting completed jobs", async () => {
    const manager = new CrawlJobManager({
      idFactory: (() => {
        let index = 0;
        return () => `dsc_running_${++index}`;
      })(),
      maxRunningJobs: 1,
    });
    let release!: () => void;
    const blockingClient: DeepSeekGateway = {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      fetch() {
        return new Promise((resolve) => {
          release = () => resolve({ title: "Example", content: "# Example" });
        });
      },
    };

    manager.create(
      { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
      blockingClient,
      reader,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(() =>
      manager.create(
        { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
        gateway(),
        reader,
      ),
    ).toThrow(GatewayCapacityError);

    release();
    await manager.waitForIdle("dsc_running_1");
    expect(() =>
      manager.create(
        { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
        gateway(),
        reader,
      ),
    ).not.toThrow();
  });

  it("evicts the oldest terminal crawl job before rejecting retained capacity", async () => {
    let index = 0;
    const manager = new CrawlJobManager({
      idFactory: () => `dsc_retained_${++index}`,
      maxRunningJobs: 1,
      maxRetainedJobs: 1,
    });
    manager.create(
      { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
      gateway(),
      reader,
    );
    await manager.waitForIdle("dsc_retained_1");

    manager.create(
      { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
      gateway(),
      reader,
    );
    await manager.waitForIdle("dsc_retained_2");

    expect(manager.status("dsc_retained_1")).toBeUndefined();
    expect(manager.status("dsc_retained_2")).toMatchObject({
      status: "completed",
      completed: 1,
    });
  });

  it("fails a crawl without retaining a page that exceeds the byte budget", async () => {
    const manager = new CrawlJobManager({
      idFactory: () => "dsc_bytes_fail",
      maxRetainedBytes: 1,
    });

    manager.create(
      { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
      gateway(),
      reader,
    );
    await manager.waitForIdle("dsc_bytes_fail");

    expect(manager.status("dsc_bytes_fail")).toMatchObject({
      status: "failed",
      completed: 0,
      data: [],
    });
    expect(manager.errors("dsc_bytes_fail")?.errors).toMatchObject([
      { error: expect.stringMatching(/storage is full/i) },
    ]);
  });

  it("evicts terminal crawl data to recover retained byte capacity", async () => {
    let index = 0;
    const manager = new CrawlJobManager({
      idFactory: () => `dsc_bytes_${++index}`,
      maxRetainedBytes: 119,
    });

    manager.create(
      { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
      gateway(),
      reader,
    );
    await manager.waitForIdle("dsc_bytes_1");

    manager.create(
      { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
      gateway(),
      reader,
    );
    await manager.waitForIdle("dsc_bytes_2");

    expect(manager.status("dsc_bytes_1")).toBeUndefined();
    expect(manager.status("dsc_bytes_2")).toMatchObject({
      status: "completed",
      completed: 1,
    });
  });

  it("evicts terminal pages when the next page would exceed the byte budget", async () => {
    let index = 0;
    const manager = new CrawlJobManager({
      idFactory: () => `dsc_bytes_reclaim_${++index}`,
      maxRunningJobs: 4,
      maxRetainedJobs: 100,
      maxRetainedBytes: 629,
    });
    const byteGateway: DeepSeekGateway = {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch() {
        return { title: "Example", content: "x".repeat(100) };
      },
    };

    for (let job = 1; job <= 3; job += 1) {
      manager.create(
        { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
        byteGateway,
        reader,
      );
      await manager.waitForIdle(`dsc_bytes_reclaim_${job}`);
    }

    expect(manager.status("dsc_bytes_reclaim_1")).toBeUndefined();
    expect(manager.status("dsc_bytes_reclaim_2")).toMatchObject({
      status: "completed",
      completed: 1,
    });
    expect(manager.status("dsc_bytes_reclaim_3")).toMatchObject({
      status: "completed",
      completed: 1,
    });
  });

  it("releases retained byte capacity when a job expires", async () => {
    let current = new Date("2026-11-14T00:00:00.000Z");
    let index = 0;
    const manager = new CrawlJobManager({
      now: () => current,
      idFactory: () => `dsc_bytes_expire_${++index}`,
      maxRetainedBytes: 119,
    });

    manager.create(
      { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
      gateway(),
      reader,
    );
    await manager.waitForIdle("dsc_bytes_expire_1");

    current = new Date("2026-11-15T00:00:00.001Z");
    expect(manager.sweepExpired()).toBe(1);

    manager.create(
      { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
      gateway(),
      reader,
    );
    await manager.waitForIdle("dsc_bytes_expire_2");

    expect(manager.status("dsc_bytes_expire_2")).toMatchObject({
      status: "completed",
      completed: 1,
    });
  });

  it("rejects a new crawl when every retained slot is still active", async () => {
    const manager = new CrawlJobManager({
      idFactory: (() => {
        let index = 0;
        return () => `dsc_retained_active_${++index}`;
      })(),
      maxRunningJobs: 2,
      maxRetainedJobs: 2,
    });
    const client: DeepSeekGateway = {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      fetch(_input, signal) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };

    manager.create(
      { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
      client,
      reader,
    );
    manager.create(
      { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
      client,
      reader,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(() =>
      manager.create(
        { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
        client,
        reader,
      ),
    ).toThrow(GatewayCapacityError);

    manager.cancel("dsc_retained_active_1");
    manager.cancel("dsc_retained_active_2");
    await manager.waitForIdle("dsc_retained_active_1");
    await manager.waitForIdle("dsc_retained_active_2");
  });

  it("does not account pages from a removed job after its Provider call returns", async () => {
    let calls = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markChildStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    let releaseChild!: () => void;
    const childCanFinish = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const client: DeepSeekGateway = {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch(input) {
        calls += 1;
        if (calls === 1) {
          markStarted();
          await firstCanFinish;
          return { title: "Example", content: "x" };
        }
        if (calls === 2) {
          return { title: "Example", content: "# Example" };
        }
        if (calls === 3) {
          return { title: "Example", content: "[Child](/child)" };
        }
        if (calls === 4 && input.url.endsWith("/child")) {
          markChildStarted();
          await childCanFinish;
          return { title: "Example", content: "child" };
        }
        throw new Error(`Unexpected Fetch call: ${input.url}`);
      },
    };
    let index = 0;
    const manager = new CrawlJobManager({
      idFactory: () => `dsc_removed_${++index}`,
      maxRunningJobs: 1,
      maxRetainedJobs: 1,
      maxRetainedBytes: 360,
    });

    manager.create(
      { url: "https://example.com/", limit: 1, maxDiscoveryDepth: 0, sitemap: "skip" },
      client,
      reader,
    );
    await started;
    manager.cancel("dsc_removed_1");

    manager.create(
      {
        url: "https://example.com/",
        limit: 2,
        maxDiscoveryDepth: 1,
        maxConcurrency: 1,
        sitemap: "skip",
      },
      client,
      reader,
    );
    await manager.waitForIdle("dsc_removed_2");

    manager.create(
      {
        url: "https://example.com/",
        limit: 2,
        maxDiscoveryDepth: 1,
        maxConcurrency: 1,
        sitemap: "skip",
      },
      client,
      reader,
    );
    await childStarted;
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseChild();
    await manager.waitForIdle("dsc_removed_3");

    expect(manager.status("dsc_removed_3")).toMatchObject({
      status: "completed",
      completed: 2,
    });
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
