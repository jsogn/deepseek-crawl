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

  it("validates Sitemap modes and requires a reader outside skip mode", async () => {
    const gateway = client();

    await expect(
      executeCrawl(
        gateway,
        { url: "https://example.com/" },
        {
          ...options,
          sitemapMode: "invalid" as "include",
          sitemapReader: { read: vi.fn() },
        },
      ),
    ).rejects.toThrow(/sitemapMode/i);
    await expect(
      executeCrawl(
        gateway,
        { url: "https://example.com/" },
        { ...options, sitemapMode: "include" },
      ),
    ).rejects.toThrow(/sitemap reader/i);
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
    expect(result.warnings).toEqual([]);
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

  it("applies path filters and query normalization to discovered links", async () => {
    const fetch = vi.fn(async ({ url }: { url: string }) => ({
      title: url,
      content:
        url === "https://example.com/"
          ? "[Doc one](/docs/a?utm=1) [Doc two](/docs/a?utm=2) [Blog](/blog) [Private](/docs/private/x) [API](/api/v?x=1)"
          : "No links",
    }));
    const result = await executeCrawl(
      { search: vi.fn(), fetch },
      { url: "https://example.com/?from=seed" },
      {
        ...options,
        maxDepth: 1,
        includePaths: ["/docs/*", "/api/?"],
        excludePaths: ["/docs/private/*"],
        ignoreQueryParameters: true,
      },
    );

    expect(result.seed_url).toBe("https://example.com/");
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/api/v",
      "https://example.com/docs/a",
    ]);
    expect(result.stats.discovered).toBe(3);
    expect(fetch.mock.calls.map(([input]) => input.url)).toEqual([
      "https://example.com/",
      "https://example.com/api/v",
      "https://example.com/docs/a",
    ]);
  });

  it("includes Sitemap candidates when Markdown has no links", async () => {
    const reader = {
      read: vi.fn(async () => ({
        urls: [
          new URL("https://example.com/docs/a"),
          new URL("https://example.com/docs/b"),
          new URL("https://example.com/blog/post"),
          new URL("https://other.example/docs/a"),
          new URL("https://example.com/docs/private/x"),
          new URL("https://example.com/docs/a?utm_source=sitemap"),
        ],
        warnings: [{ code: "sitemap_invalid" as const, message: "child Sitemap was invalid" }],
        truncated: false,
      })),
    };
    const result = await executeCrawl(
      {
        search: vi.fn(),
        fetch: vi.fn(async ({ url }: { url: string }) => ({ title: url, content: "No links" })),
      },
      { url: "https://example.com/" },
      {
        ...options,
        maxDepth: 1,
        discoveryLimit: 2,
        includePaths: ["/docs/*"],
        excludePaths: ["/docs/private/*"],
        ignoreQueryParameters: true,
        sitemapMode: "include",
        sitemapReader: reader,
      },
    );

    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/docs/a",
    ]);
    expect(result.settings.sitemap_mode).toBe("include");
    expect(result.stats.sitemap_candidates).toBe(2);
    expect(result.stats.discovery_limit_reached).toBe(true);
    expect(result.warnings).toEqual([
      { code: "sitemap_invalid", message: "child Sitemap was invalid" },
    ]);
    expect(reader.read.mock.calls[0]?.slice(0, 2)).toEqual([
      new URL("https://example.com/"),
      { maxDocuments: 10, maxCandidates: 2 },
    ]);
    expect(reader.read.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  });

  it("uses only Sitemap URLs in only mode", async () => {
    const result = await executeCrawl(
      {
        search: vi.fn(),
        fetch: vi.fn(async ({ url }: { url: string }) => ({
          title: url,
          content: "[Markdown](/markdown)",
        })),
      },
      { url: "https://example.com/" },
      {
        ...options,
        maxDepth: 1,
        sitemapMode: "only",
        sitemapReader: {
          read: vi.fn(async () => ({
            urls: [new URL("https://example.com/sitemap-page")],
            warnings: [],
            truncated: false,
          })),
        },
      },
    );

    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/sitemap-page",
    ]);
  });

  it("warns on Sitemap failure and continues Markdown discovery", async () => {
    const result = await executeCrawl(
      {
        search: vi.fn(),
        fetch: vi.fn(async () => ({ title: "Seed", content: "[Markdown](/markdown)" })),
      },
      { url: "https://example.com/" },
      {
        ...options,
        maxDepth: 1,
        sitemapMode: "include",
        sitemapReader: {
          read: vi.fn(async () => Promise.reject(new Error("sitemap down"))),
        },
      },
    );

    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/markdown",
    ]);
    expect(result.warnings).toEqual([
      { code: "sitemap_unavailable", message: expect.stringContaining("sitemap down") },
    ]);
  });

  it("does not read Sitemap when maxDepth is zero", async () => {
    const reader = { read: vi.fn() };
    const result = await executeCrawl(
      client(),
      { url: "https://example.com/" },
      { ...options, maxDepth: 0, sitemapMode: "include", sitemapReader: reader },
    );

    expect(reader.read).not.toHaveBeenCalled();
    expect(result.pages).toHaveLength(1);
  });

  it("propagates Sitemap cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const read = vi.fn(
      async (_seed: URL, _options: unknown, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const crawl = executeCrawl(
      {
        search: vi.fn(),
        fetch: vi.fn(async () => ({ title: "Seed", content: "No links" })),
      },
      { url: "https://example.com/" },
      {
        ...options,
        sitemapMode: "include",
        sitemapReader: { read },
      },
      undefined,
      controller.signal,
    );

    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    controller.abort(reason);
    await expect(crawl).rejects.toBe(reason);
  });

  it("does not call the Sitemap reader in skip mode", async () => {
    const reader = { read: vi.fn() };
    const result = await executeCrawl(
      client(),
      { url: "https://example.com/" },
      { ...options, sitemapMode: "skip", sitemapReader: reader },
    );

    expect(reader.read).not.toHaveBeenCalled();
    expect(result.settings.sitemap_mode).toBe("skip");
    expect(result.warnings).toEqual([]);
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
