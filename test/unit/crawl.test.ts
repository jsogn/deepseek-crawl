import { describe, expect, it, vi } from "vitest";
import { executeCrawl, normalizeCrawlOptions } from "../../src/application/crawl.js";
import { DeepSeekError } from "../../src/deepseek/errors.js";

const options = {
  maxDepth: 2,
  maxPages: 20,
  concurrency: 2,
  delayMs: 0,
  discoveryLimit: 100,
  pageContentLimit: 1000,
};

function client() {
  return {
    search: vi.fn(),
    fetch: vi.fn(async ({ url }: { url: string }) => {
      if (url === "https://example.com/broken") {
        throw new DeepSeekError("broken", { kind: "not_found" });
      }
      return {
        title: url,
        content:
          url === "https://example.com/"
            ? "[A](/b) [B](/a) [Broken](/broken) [Outside](https://other.example/) [Hash](/a#part)"
            : "[Root](/)[Deep](/c)",
      };
    }),
  };
}

describe("executeCrawl", () => {
  it("clamps resource limits and rejects invalid options before fetching", async () => {
    expect(
      normalizeCrawlOptions({
        maxDepth: 9,
        maxPages: 500,
        concurrency: 20,
        delayMs: 20_000,
        discoveryLimit: 100_000,
        pageContentLimit: 5_000_000,
      }),
    ).toMatchObject({
      maxDepth: 5,
      maxPages: 100,
      concurrency: 5,
      delayMs: 5_000,
      discoveryLimit: 10_000,
      pageContentLimit: 1_000_000,
    });

    const gateway = client();
    await expect(
      executeCrawl(gateway, { url: "https://example.com/" }, { ...options, concurrency: 0 }),
    ).rejects.toThrow(/concurrency/i);
    await expect(
      executeCrawl(gateway, { url: "https://example.com/" }, { ...options, pageContentLimit: 0 }),
    ).rejects.toThrow(/pageContentLimit/i);
    expect(gateway.fetch).not.toHaveBeenCalled();
  });

  it("traverses deterministically, deduplicates, and records failures", async () => {
    const pages = new Map<number, string>();
    const result = await executeCrawl(
      client(),
      { url: "https://example.com/" },
      options,
      async (page) => {
        pages.set(page.index, page.url);
      },
    );

    expect(
      [...pages.entries()].sort(([left], [right]) => left - right).map(([, url]) => url),
    ).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
    expect(result.stats.failed).toBe(1);
    expect(result.failures).toEqual([
      expect.objectContaining({
        url: "https://example.com/broken",
        kind: "not_found",
      }),
    ]);
  });

  it("stops at max_pages and sets limit_reached", async () => {
    const result = await executeCrawl(
      client(),
      { url: "https://example.com/" },
      { ...options, maxPages: 2 },
    );

    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
    ]);
    expect(result.stats.limit_reached).toBe(true);
  });

  it("sets discovery_limit_reached when more in-scope URLs remain", async () => {
    const result = await executeCrawl(
      client(),
      { url: "https://example.com/" },
      { ...options, maxDepth: 1, discoveryLimit: 2 },
    );

    expect(result.stats.discovered).toBe(2);
    expect(result.stats.discovery_limit_reached).toBe(true);
  });

  it("retains the lexicographically smallest links across concurrent pages", async () => {
    const fetch = vi.fn(async ({ url }: { url: string }) => {
      const content =
        url === "https://example.com/"
          ? "[Z](/z) [A](/a)"
          : url === "https://example.com/a"
            ? "[N](/n) [C](/c)"
            : url === "https://example.com/z"
              ? "[M](/m) [B](/b)"
              : "";
      return { title: url, content };
    });
    const gateway = { search: vi.fn(), fetch };

    const result = await executeCrawl(
      gateway,
      { url: "https://example.com/" },
      {
        ...options,
        concurrency: 2,
        discoveryLimit: 5,
      },
    );

    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/z",
      "https://example.com/b",
      "https://example.com/c",
    ]);
    expect(fetch.mock.calls.map(([input]) => input.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/z",
      "https://example.com/b",
      "https://example.com/c",
    ]);
    expect(result.stats.discovered).toBe(5);
    expect(result.stats.discovery_limit_reached).toBe(true);
  });

  it("records content truncation metadata", async () => {
    const result = await executeCrawl(
      client(),
      { url: "https://example.com/" },
      { ...options, pageContentLimit: 5 },
    );

    expect(result.stats.content_truncated).toBeGreaterThan(0);
    expect(result.pages[0]).toMatchObject({
      content_length: 5,
      content_truncated: true,
    });
    expect(result.pages[0]?.content_original_length).toBeGreaterThan(5);
  });

  it("propagates page callback failures and does not visit children", async () => {
    const gateway = client();

    await expect(
      executeCrawl(gateway, { url: "https://example.com/" }, options, async (page) => {
        if (page.depth === 0) {
          throw new Error("write failed");
        }
      }),
    ).rejects.toThrow("write failed");
    expect(gateway.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails when the seed page fails", async () => {
    const gateway = {
      search: vi.fn(),
      fetch: vi.fn(async () => Promise.reject(new Error("seed"))),
    };

    await expect(executeCrawl(gateway, { url: "https://example.com/" }, options)).rejects.toThrow(
      "seed",
    );
  });
});
