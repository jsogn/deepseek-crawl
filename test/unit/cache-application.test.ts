import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeCrawl } from "../../src/application/crawl.js";
import { executeCrawlPlan } from "../../src/application/crawl-plan.js";
import { executeCrawlRetry } from "../../src/application/crawl-retry.js";
import { CachedFetchGateway } from "../../src/cache/cached-gateway.js";
import { FileFetchCache } from "../../src/cache/file-cache.js";
import type { DeepSeekGateway } from "../../src/deepseek/gateway.js";

const now = () => new Date("2026-11-14T01:00:00.000Z");

async function cachedGateway(fetch: DeepSeekGateway["fetch"], cache: FileFetchCache) {
  return new CachedFetchGateway({ search: vi.fn(), fetch }, cache, {
    ttlMs: 60_000,
    fresh: false,
    now,
  });
}

describe("cache-aware application results", () => {
  it("reuses a Crawl seed from cache and exposes cache stats", async () => {
    const cache = new FileFetchCache(
      join(await mkdtemp(join(tmpdir(), "deepseek-app-cache-")), "cache"),
    );
    const fetch = vi.fn(async () => ({ title: "Seed", content: "No links" }));
    const first = await executeCrawl(
      await cachedGateway(fetch, cache),
      { url: "https://example.com/" },
      {
        maxDepth: 0,
        maxPages: 1,
        concurrency: 1,
        delayMs: 0,
        discoveryLimit: 100,
        pageContentLimit: 1000,
        sitemapMode: "skip",
      },
    );
    const second = await executeCrawl(
      await cachedGateway(fetch, cache),
      { url: "https://example.com/" },
      {
        maxDepth: 0,
        maxPages: 1,
        concurrency: 1,
        delayMs: 0,
        discoveryLimit: 100,
        pageContentLimit: 1000,
        sitemapMode: "skip",
      },
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(first.pages[0]?.retrieved_from).toBe("api");
    expect(first.stats).toMatchObject({ cache_hits: 0, cache_misses: 1 });
    expect(second.pages[0]?.retrieved_from).toBe("cache");
    expect(second.stats).toMatchObject({ cache_hits: 1, cache_misses: 0 });
  });

  it("reuses a Crawl Plan seed from cache", async () => {
    const cache = new FileFetchCache(
      join(await mkdtemp(join(tmpdir(), "deepseek-app-cache-")), "cache"),
    );
    await cache.write(
      "https://example.com/",
      { title: "Cached seed", content: "No links" },
      now().toISOString(),
    );
    const fetch = vi.fn();
    const plan = await executeCrawlPlan(
      await cachedGateway(fetch, cache),
      { url: "https://example.com/" },
      {
        maxDepth: 0,
        maxPages: 1,
        concurrency: 1,
        delayMs: 0,
        discoveryLimit: 100,
        pageContentLimit: 1000,
        sitemapMode: "skip",
      },
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(plan.seed.retrieved_from).toBe("cache");
    expect(plan.stats).toMatchObject({ cache_hits: 1, cache_misses: 0 });
  });

  it("retries a failed Crawl page from cache without an API request", async () => {
    const cache = new FileFetchCache(
      join(await mkdtemp(join(tmpdir(), "deepseek-app-cache-")), "cache"),
    );
    await cache.write(
      "https://example.com/retry",
      { title: "Cached retry", content: "cached" },
      now().toISOString(),
    );
    const fetch = vi.fn();
    const result = await executeCrawlRetry(
      await cachedGateway(fetch, cache),
      {
        version: 1,
        seed_url: "https://example.com/",
        settings: {
          max_depth: 2,
          max_pages: 5,
          concurrency: 1,
          delay_ms: 0,
          sitemap_mode: "include",
        },
        failures: [
          {
            index: 2,
            url: "https://example.com/retry",
            depth: 1,
            sources: ["markdown"],
            kind: "timeout",
            message: "timed out",
          },
        ],
      },
      "crawl.json",
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(result.pages[0]?.retrieved_from).toBe("cache");
    expect(result.stats).toMatchObject({ cache_hits: 1, cache_misses: 0 });
  });
});
