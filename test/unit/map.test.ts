import { describe, expect, it, vi } from "vitest";
import { executeMap } from "../../src/application/map.js";
import { DeepSeekError } from "../../src/deepseek/errors.js";
import type { SitemapReadOptions } from "../../src/sitemap/reader.js";

const now = () => new Date("2026-11-13T12:00:00.000Z");

function reader(result: {
  urls: URL[];
  warnings?: Array<{
    code: "sitemap_unavailable" | "sitemap_invalid" | "sitemap_limit_reached" | "seed_page_failed";
    message: string;
  }>;
  truncated?: boolean;
}) {
  return {
    read: vi.fn(async (_seed: URL, _options: SitemapReadOptions) => ({
      entries: result.urls.map((url) => ({ url })),
      warnings: result.warnings ?? [],
      truncated: result.truncated ?? false,
    })),
  };
}

function gateway(content: string) {
  return {
    search: vi.fn(),
    fetch: vi.fn(async () => ({ title: "Seed", content })),
  };
}

describe("executeMap", () => {
  it("merges Sitemap and seed-page sources deterministically", async () => {
    const sitemapReader = reader({
      urls: [new URL("https://example.com/b"), new URL("https://example.com/a")],
    });
    const client = gateway("[Home](/a) [Docs](/docs) [Outside](https://other.example/)");

    const result = await executeMap(
      client,
      sitemapReader,
      { url: "https://example.com/" },
      { limit: 10, discoveryLimit: 100, now },
    );

    expect(result).toEqual({
      version: 1,
      seed_url: "https://example.com/",
      generated_at: "2026-11-13T12:00:00.000Z",
      limit: 10,
      total: 4,
      truncated: false,
      urls: [
        { url: "https://example.com/", sources: ["seed_url"] },
        { url: "https://example.com/a", sources: ["seed_page", "sitemap"] },
        { url: "https://example.com/b", sources: ["sitemap"] },
        { url: "https://example.com/docs", sources: ["seed_page"] },
      ],
      warnings: [],
    });
    expect(sitemapReader.read).toHaveBeenCalledWith(
      new URL("https://example.com/"),
      { maxDocuments: 10, maxCandidates: 100 },
      undefined,
    );
  });

  it("keeps seed-page results and warns when Sitemap discovery fails", async () => {
    const sitemapReader = {
      read: vi.fn(async () => {
        throw new Error("sitemap down");
      }),
    };
    const client = gateway("[Docs](/docs)");

    const result = await executeMap(
      client,
      sitemapReader,
      { url: "https://example.com/" },
      { limit: 10, discoveryLimit: 100 },
    );

    expect(result.urls).toEqual([
      { url: "https://example.com/", sources: ["seed_url"] },
      { url: "https://example.com/docs", sources: ["seed_page"] },
    ]);
    expect(result.warnings).toEqual([
      {
        code: "sitemap_unavailable",
        message: expect.stringContaining("sitemap down"),
      },
    ]);
  });

  it("keeps Sitemap results and warns when seed-page discovery fails", async () => {
    const sitemapReader = reader({ urls: [new URL("https://example.com/from-sitemap")] });
    const client = {
      search: vi.fn(),
      fetch: vi.fn(async () => {
        throw new DeepSeekError("seed unavailable", { kind: "network" });
      }),
    };

    const result = await executeMap(
      client,
      sitemapReader,
      { url: "https://example.com/" },
      { limit: 10, discoveryLimit: 100 },
    );

    expect(result.urls).toEqual([
      { url: "https://example.com/", sources: ["seed_url"] },
      { url: "https://example.com/from-sitemap", sources: ["sitemap"] },
    ]);
    expect(result.warnings[0]).toEqual({
      code: "seed_page_failed",
      message: expect.stringContaining("seed unavailable"),
    });
  });

  it("throws when both sources fail", async () => {
    const sitemapReader = {
      read: vi.fn(async () => {
        throw new Error("sitemap down");
      }),
    };
    const client = {
      search: vi.fn(),
      fetch: vi.fn(async () => {
        throw new DeepSeekError("seed down", { kind: "network" });
      }),
    };

    await expect(
      executeMap(
        client,
        sitemapReader,
        { url: "https://example.com/" },
        { limit: 10, discoveryLimit: 100 },
      ),
    ).rejects.toThrow(/neither|both|Sitemap|seed/i);
  });

  it("treats an unreadable Sitemap warning as no source when the seed page fails", async () => {
    const sitemapReader = reader({
      urls: [],
      warnings: [{ code: "sitemap_invalid", message: "invalid root Sitemap" }],
    });
    const client = {
      search: vi.fn(),
      fetch: vi.fn(async () => {
        throw new DeepSeekError("seed down", { kind: "network" });
      }),
    };

    await expect(
      executeMap(
        client,
        sitemapReader,
        { url: "https://example.com/" },
        { limit: 10, discoveryLimit: 100 },
      ),
    ).rejects.toThrow(/could not read either/i);
  });

  it("applies the limit to lexicographically sorted candidates", async () => {
    const sitemapReader = reader({
      urls: [
        new URL("https://example.com/c"),
        new URL("https://example.com/a"),
        new URL("https://example.com/b"),
      ],
    });
    const client = gateway("");

    const result = await executeMap(
      client,
      sitemapReader,
      { url: "https://example.com/" },
      { limit: 2, discoveryLimit: 100 },
    );

    expect(result.urls).toEqual([
      { url: "https://example.com/", sources: ["seed_url"] },
      { url: "https://example.com/a", sources: ["sitemap"] },
    ]);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("succeeds with only the seed URL when the seed page has no links", async () => {
    const sitemapReader = reader({ urls: [] });
    const client = gateway("");

    const result = await executeMap(
      client,
      sitemapReader,
      { url: "https://example.com/" },
      { limit: 10, discoveryLimit: 100 },
    );

    expect(result.urls).toEqual([{ url: "https://example.com/", sources: ["seed_url"] }]);
    expect(result.truncated).toBe(false);
  });

  it("always retains the seed URL when sorting would otherwise exclude it", async () => {
    const sitemapReader = reader({
      urls: [new URL("https://example.com/a"), new URL("https://example.com/b")],
    });

    const result = await executeMap(
      gateway(""),
      sitemapReader,
      { url: "https://example.com/zzz" },
      { limit: 1, discoveryLimit: 100 },
    );

    expect(result.urls).toEqual([{ url: "https://example.com/zzz", sources: ["seed_url"] }]);
    expect(result.truncated).toBe(true);
  });

  it("applies the discovery cap after retaining the mandatory seed URL", async () => {
    const sitemapReader = reader({
      urls: [new URL("https://example.com/b"), new URL("https://example.com/a")],
    });

    const result = await executeMap(
      gateway(""),
      sitemapReader,
      { url: "https://example.com/" },
      { limit: 10, discoveryLimit: 2 },
    );

    expect(result.urls).toEqual([
      { url: "https://example.com/", sources: ["seed_url"] },
      { url: "https://example.com/a", sources: ["sitemap"] },
    ]);
    expect(result.truncated).toBe(true);
  });

  it("keeps excessive seed-page links within the discovery cap", async () => {
    const links = Array.from(
      { length: 20_000 },
      (_, index) => `[Page ${index}](/p${index.toString().padStart(5, "0")})`,
    ).join(" ");
    const sitemapReader = reader({ urls: [] });

    const result = await executeMap(
      gateway(links),
      sitemapReader,
      { url: "https://example.com/" },
      { limit: 10, discoveryLimit: 4 },
    );

    expect(result.urls).toEqual([
      { url: "https://example.com/", sources: ["seed_url"] },
      { url: "https://example.com/p00000", sources: ["seed_page"] },
      { url: "https://example.com/p00001", sources: ["seed_page"] },
      { url: "https://example.com/p00002", sources: ["seed_page"] },
    ]);
    expect(result.total).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it("uses the 1,000,000-code-point seed-page extraction default", async () => {
    const sitemapReader = reader({ urls: [] });
    const content = `${"x".repeat(1_000_000)}[Late](/late)`;

    const result = await executeMap(
      gateway(content),
      sitemapReader,
      { url: "https://example.com/" },
      { limit: 500, discoveryLimit: 10_000 },
    );

    expect(result.urls).toEqual([{ url: "https://example.com/", sources: ["seed_url"] }]);
  });

  it("preserves Sitemap warnings and truncation metadata", async () => {
    const sitemapReader = reader({
      urls: [new URL("https://example.com/a")],
      warnings: [{ code: "sitemap_invalid", message: "bad child Sitemap" }],
      truncated: true,
    });

    const result = await executeMap(
      gateway(""),
      sitemapReader,
      { url: "https://example.com/" },
      { limit: 10, discoveryLimit: 100 },
    );

    expect(result.warnings).toEqual([{ code: "sitemap_invalid", message: "bad child Sitemap" }]);
    expect(result.truncated).toBe(true);
  });

  it("clamps public Map limits to their hard maxima", async () => {
    const sitemapReader = reader({ urls: [new URL("https://example.com/a")] });

    const result = await executeMap(
      gateway(""),
      sitemapReader,
      { url: "https://example.com/" },
      { limit: 5_000, discoveryLimit: 20_000, pageContentLimit: 5_000_000 },
    );

    expect(result.limit).toBe(1_000);
    expect(sitemapReader.read.mock.calls[0]?.[1]).toEqual({
      maxDocuments: 10,
      maxCandidates: 10_000,
    });
  });

  it("rejects invalid Map resource options before reading", async () => {
    const sitemapReader = reader({ urls: [] });

    await expect(
      executeMap(
        gateway(""),
        sitemapReader,
        { url: "https://example.com/" },
        { limit: 0, discoveryLimit: 100 },
      ),
    ).rejects.toThrow(/limit/i);
    expect(sitemapReader.read).not.toHaveBeenCalled();
  });

  it("filters Map URLs case-insensitively before applying the limit", async () => {
    const sitemapReader = reader({
      urls: [
        new URL("https://example.com/docs/reference"),
        new URL("https://example.com/blog/post"),
      ],
    });
    const client = gateway("[Docs](/docs/start) [API](/docs/api) [Blog](/blog)");

    const result = await executeMap(
      client,
      sitemapReader,
      { url: "https://example.com/" },
      { limit: 2, discoveryLimit: 100, search: "  DOCS  ", now },
    );

    expect(result.search).toBe("DOCS");
    expect(result.urls).toEqual([
      { url: "https://example.com/docs/api", sources: ["seed_page"] },
      { url: "https://example.com/docs/reference", sources: ["sitemap"] },
    ]);
    expect(result.truncated).toBe(true);
  });

  it("returns an empty successful Map when search has no matches", async () => {
    const result = await executeMap(
      gateway("[Docs](/docs)"),
      reader({ urls: [new URL("https://example.com/docs")] }),
      { url: "https://example.com/" },
      { limit: 10, discoveryLimit: 100, search: "missing", now },
    );

    expect(result.urls).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("keeps the seed in search results when it matches", async () => {
    const result = await executeMap(
      gateway("[Docs](/docs)"),
      reader({ urls: [new URL("https://example.com/docs")] }),
      { url: "https://example.com/docs" },
      { limit: 10, discoveryLimit: 100, search: "docs", now },
    );

    expect(result.urls[0]?.url).toBe("https://example.com/docs");
    expect(result.search).toBe("docs");
  });

  it("rejects an empty Map search before reading either source", async () => {
    const sitemapReader = reader({ urls: [] });
    const client = gateway("");

    await expect(
      executeMap(
        client,
        sitemapReader,
        { url: "https://example.com/" },
        { limit: 10, discoveryLimit: 100, search: "   " },
      ),
    ).rejects.toThrow(/search/i);
    expect(sitemapReader.read).not.toHaveBeenCalled();
    expect(client.fetch).not.toHaveBeenCalled();
  });
});
