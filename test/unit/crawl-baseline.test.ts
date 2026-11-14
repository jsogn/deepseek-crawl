import { describe, expect, it } from "vitest";
import { compareCrawlBaseline, parseCrawlBaseline } from "../../src/crawl/baseline.js";
import type { CrawlPageSummary } from "../../src/crawl/types.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

function page(url: string, hash: string, status: "added" | "modified" | "unchanged") {
  return {
    index: 1,
    url,
    title: url,
    depth: 1,
    sources: ["markdown"],
    content_length: 10,
    content_hash: hash,
    content_truncated: false,
    change_status: status,
  } satisfies CrawlPageSummary;
}

describe("Crawl baseline", () => {
  it("validates and indexes content hashes", () => {
    const baseline = parseCrawlBaseline(
      {
        version: 1,
        pages: [
          { url: "https://example.com/a", content_hash: hashA },
          { url: "https://example.com/b", content_hash: hashB },
        ],
      },
      "previous/crawl.json",
    );

    expect(baseline.source).toBe("previous/crawl.json");
    expect(baseline.hashes.get("https://example.com/a")).toBe(hashA);
  });

  it("preserves page metadata and Sitemap lastmod for safe fetch skipping", () => {
    const baseline = parseCrawlBaseline(
      {
        version: 1,
        pages: [
          {
            url: "https://example.com/a",
            title: "Page A",
            depth: 1,
            sources: ["sitemap"],
            content_length: 42,
            content_hash: hashA,
            content_truncated: false,
            sitemap_lastmod: "2026-11-14T08:00:00.000Z",
          },
        ],
      },
      "previous/crawl.json",
    );

    expect(baseline.pages?.get("https://example.com/a")).toEqual({
      url: "https://example.com/a",
      title: "Page A",
      depth: 1,
      sources: ["sitemap"],
      content_length: 42,
      content_hash: hashA,
      content_truncated: false,
      sitemap_lastmod: "2026-11-14T08:00:00.000Z",
    });
  });

  it("rejects duplicate, malformed, or missing content hashes", () => {
    expect(() =>
      parseCrawlBaseline(
        {
          version: 1,
          pages: [
            { url: "https://example.com/a", content_hash: hashA },
            { url: "https://example.com/a", content_hash: hashB },
          ],
        },
        "crawl.json",
      ),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseCrawlBaseline(
        { version: 1, pages: [{ url: "https://example.com/a", content_hash: "bad" }] },
        "crawl.json",
      ),
    ).toThrow(/invalid/i);
    expect(() =>
      parseCrawlBaseline({ version: 1, pages: [{ url: "https://example.com/a" }] }, "crawl.json"),
    ).toThrow(/invalid/i);
  });

  it("classifies added, modified, unchanged, and removed pages", () => {
    const baseline = parseCrawlBaseline(
      {
        version: 1,
        pages: [
          { url: "https://example.com/a", content_hash: hashA },
          { url: "https://example.com/b", content_hash: hashB },
          { url: "https://example.com/c", content_hash: hashC },
        ],
      },
      "crawl.json",
    );
    const pages = [
      page("https://example.com/a", hashB, "modified"),
      page("https://example.com/c", hashC, "unchanged"),
      page("https://example.com/d", hashA, "added"),
    ];

    expect(
      compareCrawlBaseline(
        pages,
        new Set(["https://example.com/a", "https://example.com/c", "https://example.com/d"]),
        baseline,
      ),
    ).toEqual({
      added: [{ url: "https://example.com/d", content_hash: hashA }],
      modified: [
        {
          url: "https://example.com/a",
          content_hash: hashB,
          previous_content_hash: hashA,
        },
      ],
      unchanged: [{ url: "https://example.com/c", content_hash: hashC }],
      removed: [{ url: "https://example.com/b", content_hash: hashB }],
    });
  });
});
