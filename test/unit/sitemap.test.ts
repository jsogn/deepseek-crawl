import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { type SitemapFetcher, SitemapReader } from "../../src/sitemap/reader.js";

function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

function mappedFetcher(
  documents: Record<string, string>,
  failures: Record<string, Error> = {},
): { fetcher: SitemapFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: SitemapFetcher = {
    fetch: vi.fn(async (url) => {
      calls.push(url.href);
      const failure = failures[url.href];
      if (failure) {
        throw failure;
      }
      const body = documents[url.href];
      if (body === undefined) {
        throw new Error(`Missing fixture for ${url.href}`);
      }
      return { body, finalUrl: url };
    }),
  };
  return { fetcher, calls };
}

const options = { maxDocuments: 10, maxCandidates: 10_000 };

describe("SitemapReader", () => {
  it("normalizes same-origin URLs from a urlset", async () => {
    const body = await fixture("sitemap-urlset.xml");
    const { fetcher } = mappedFetcher({ "https://example.com/sitemap.xml": body });
    const reader = new SitemapReader({ fetcher });

    const result = await reader.read(new URL("https://example.com/docs"), options);

    expect(result.urls.map(String)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(result.warnings).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("captures valid lastmod values and ignores invalid dates", async () => {
    const body = `<urlset>
      <url>
        <loc>https://example.com/a</loc>
        <lastmod>2026-11-14T16:00:00+08:00</lastmod>
      </url>
      <url>
        <loc>https://example.com/b</loc>
        <lastmod>not-a-date</lastmod>
      </url>
    </urlset>`;
    const { fetcher } = mappedFetcher({ "https://example.com/sitemap.xml": body });
    const reader = new SitemapReader({ fetcher });

    const result = await reader.read(new URL("https://example.com/"), options);

    expect(result.entries).toEqual([
      {
        url: new URL("https://example.com/a"),
        lastmod: "2026-11-14T08:00:00.000Z",
      },
      { url: new URL("https://example.com/b") },
    ]);
  });

  it("follows a nested sitemap index", async () => {
    const index = await fixture("sitemap-index.xml");
    const urlset = await fixture("sitemap-urlset.xml");
    const { fetcher, calls } = mappedFetcher({
      "https://example.com/sitemap.xml": index,
      "https://example.com/sitemap-pages.xml": urlset,
    });
    const reader = new SitemapReader({ fetcher });

    const result = await reader.read(new URL("https://example.com/"), options);

    expect(result.urls.map(String)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(calls).toEqual([
      "https://example.com/sitemap.xml",
      "https://example.com/sitemap-pages.xml",
    ]);
  });

  it("fetches a cyclic sitemap document once", async () => {
    const index = `<?xml version="1.0"?>
<sitemapindex>
  <sitemap><loc>https://example.com/sitemap.xml</loc></sitemap>
  <sitemap><loc>https://example.com/pages.xml</loc></sitemap>
</sitemapindex>`;
    const urlset = await fixture("sitemap-urlset.xml");
    const { fetcher, calls } = mappedFetcher({
      "https://example.com/sitemap.xml": index,
      "https://example.com/pages.xml": urlset,
    });
    const reader = new SitemapReader({ fetcher });

    const result = await reader.read(new URL("https://example.com/"), options);

    expect(result.urls).toHaveLength(2);
    expect(calls.filter((url) => url === "https://example.com/sitemap.xml")).toHaveLength(1);
  });

  it("stops at the sitemap document limit and reports truncation", async () => {
    const nested = Array.from(
      { length: 12 },
      (_, index) => `<sitemap><loc>https://example.com/sitemap-${index}.xml</loc></sitemap>`,
    ).join("");
    const documents: Record<string, string> = {
      "https://example.com/sitemap.xml": `<sitemapindex>${nested}</sitemapindex>`,
    };
    for (let index = 0; index < 12; index += 1) {
      documents[`https://example.com/sitemap-${index}.xml`] =
        `<urlset><url><loc>https://example.com/page-${index}</loc></url></urlset>`;
    }
    const { fetcher, calls } = mappedFetcher(documents);
    const reader = new SitemapReader({ fetcher });

    const result = await reader.read(new URL("https://example.com/"), {
      maxDocuments: 2,
      maxCandidates: 100,
    });

    expect(calls).toHaveLength(2);
    expect(result.urls.map(String)).toEqual(["https://example.com/page-0"]);
    expect(result.truncated).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain("sitemap_limit_reached");
  });

  it("clamps an oversized document limit to the hard maximum", async () => {
    const nested = Array.from(
      { length: 12 },
      (_, index) => `<sitemap><loc>https://example.com/sitemap-${index}.xml</loc></sitemap>`,
    ).join("");
    const documents: Record<string, string> = {
      "https://example.com/sitemap.xml": `<sitemapindex>${nested}</sitemapindex>`,
    };
    for (let index = 0; index < 12; index += 1) {
      documents[`https://example.com/sitemap-${index}.xml`] =
        `<urlset><url><loc>https://example.com/page-${index}</loc></url></urlset>`;
    }
    const { fetcher, calls } = mappedFetcher(documents);
    const reader = new SitemapReader({ fetcher });

    const result = await reader.read(new URL("https://example.com/"), {
      maxDocuments: 12,
      maxCandidates: 100,
    });

    expect(calls).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain("sitemap_limit_reached");
  });

  it("stops at the candidate limit and reports truncation", async () => {
    const body = `<urlset>
      <url><loc>https://example.com/a</loc></url>
      <url><loc>https://example.com/c</loc></url>
      <url><loc>https://example.com/b</loc></url>
    </urlset>`;
    const { fetcher } = mappedFetcher({ "https://example.com/sitemap.xml": body });
    const reader = new SitemapReader({ fetcher });

    const result = await reader.read(new URL("https://example.com/"), {
      maxDocuments: 10,
      maxCandidates: 2,
    });

    expect(result.urls.map(String)).toEqual(["https://example.com/a", "https://example.com/c"]);
    expect(result.truncated).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain("sitemap_limit_reached");
  });

  it("clamps an oversized candidate limit to the hard maximum", async () => {
    const entries = Array.from(
      { length: 10_001 },
      (_, index) =>
        `<url><loc>https://example.com/page-${String(index).padStart(5, "0")}</loc></url>`,
    ).join("");
    const { fetcher } = mappedFetcher({
      "https://example.com/sitemap.xml": `<urlset>${entries}</urlset>`,
    });
    const reader = new SitemapReader({ fetcher });

    const result = await reader.read(new URL("https://example.com/"), {
      maxDocuments: 10,
      maxCandidates: 12_000,
    });

    expect(result.urls).toHaveLength(10_000);
    expect(result.truncated).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain("sitemap_limit_reached");
  });

  it.each([
    [0, 10],
    [1.5, 10],
    [Number.NaN, 10],
    [10, 0],
    [10, 1.5],
    [10, Number.POSITIVE_INFINITY],
  ])(
    "rejects invalid sitemap limits (%s documents, %s candidates)",
    async (documents, candidates) => {
      const { fetcher } = mappedFetcher({});
      const reader = new SitemapReader({ fetcher });

      await expect(
        reader.read(new URL("https://example.com/"), {
          maxDocuments: documents,
          maxCandidates: candidates,
        }),
      ).rejects.toThrow(/positive integer/i);
      expect(fetcher.fetch).not.toHaveBeenCalled();
    },
  );

  it("turns invalid XML into a warning", async () => {
    const { fetcher } = mappedFetcher({
      "https://example.com/sitemap.xml": "<urlset><url><loc>broken</urlset>",
    });
    const reader = new SitemapReader({ fetcher });

    const result = await reader.read(new URL("https://example.com/"), options);

    expect(result.urls).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "sitemap_invalid" })]);
  });

  it("turns root fetch failures into sitemap_unavailable", async () => {
    const { fetcher } = mappedFetcher(
      {},
      { "https://example.com/sitemap.xml": new Error("offline") },
    );
    const reader = new SitemapReader({ fetcher });

    const result = await reader.read(new URL("https://example.com/"), options);

    expect(result.urls).toEqual([]);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "sitemap_unavailable" })]);
  });

  it("continues other documents when one nested sitemap fails", async () => {
    const index = `<sitemapindex>
      <sitemap><loc>https://example.com/error.xml</loc></sitemap>
      <sitemap><loc>https://example.com/pages.xml</loc></sitemap>
    </sitemapindex>`;
    const urlset = await fixture("sitemap-urlset.xml");
    const { fetcher } = mappedFetcher(
      {
        "https://example.com/sitemap.xml": index,
        "https://example.com/pages.xml": urlset,
      },
      { "https://example.com/error.xml": new Error("failure") },
    );
    const reader = new SitemapReader({ fetcher });

    const result = await reader.read(new URL("https://example.com/"), options);

    expect(result.urls).toHaveLength(2);
    expect(result.warnings.map((warning) => warning.code)).toContain("sitemap_unavailable");
  });

  it("discards cross-origin documents and page URLs", async () => {
    const index = `<sitemapindex>
      <sitemap><loc>https://other.example/sitemap.xml</loc></sitemap>
      <sitemap><loc>https://example.com/pages.xml</loc></sitemap>
    </sitemapindex>`;
    const body = `<urlset>
      <url><loc>https://example.com/a</loc></url>
      <url><loc>https://other.example/b</loc></url>
    </urlset>`;
    const { fetcher, calls } = mappedFetcher({
      "https://example.com/sitemap.xml": index,
      "https://example.com/pages.xml": body,
    });
    const reader = new SitemapReader({ fetcher });

    const result = await reader.read(new URL("https://example.com/"), options);

    expect(result.urls.map(String)).toEqual(["https://example.com/a"]);
    expect(calls).not.toContain("https://other.example/sitemap.xml");
  });

  it("reads nested indexes and deduplicates page URLs across documents", async () => {
    const root = `<sitemapindex>
      <sitemap><loc>https://example.com/index-a.xml</loc></sitemap>
    </sitemapindex>`;
    const child = `<sitemapindex>
      <sitemap><loc>https://example.com/pages-a.xml</loc></sitemap>
      <sitemap><loc>https://example.com/pages-b.xml</loc></sitemap>
    </sitemapindex>`;
    const pagesA = `<urlset>
      <url><loc>https://example.com/a</loc></url>
      <url><loc>https://example.com/shared</loc></url>
    </urlset>`;
    const pagesB = `<urlset>
      <url><loc>https://example.com/shared#section</loc></url>
      <url><loc>https://example.com/b</loc></url>
    </urlset>`;
    const { fetcher } = mappedFetcher({
      "https://example.com/sitemap.xml": root,
      "https://example.com/index-a.xml": child,
      "https://example.com/pages-a.xml": pagesA,
      "https://example.com/pages-b.xml": pagesB,
    });
    const reader = new SitemapReader({ fetcher });

    const result = await reader.read(new URL("https://example.com/"), options);

    expect(result.urls.map(String)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/shared",
    ]);
  });

  it("propagates cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const fetcher: SitemapFetcher = {
      fetch: vi.fn(async () => {
        throw new Error("unexpected request");
      }),
    };
    const reader = new SitemapReader({ fetcher });

    await expect(
      reader.read(new URL("https://example.com/"), options, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });
});
