import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/content/hash.js";
import type { CrawlPage, CrawlPlanResult, CrawlRunResult } from "../../src/crawl/types.js";
import {
  createCrawlOutputWriter,
  formatCrawlHuman,
  formatCrawlPlanHuman,
} from "../../src/output/crawl.js";

function page(overrides: Partial<CrawlPage> = {}): CrawlPage {
  return {
    index: 1,
    url: "https://example.com/",
    title: "Example",
    depth: 0,
    content: "# Example",
    content_hash: contentHash("# Example"),
    sources: ["seed_url"],
    content_truncated: false,
    content_original_length: 9,
    ...overrides,
  };
}

function result(overrides: Partial<CrawlRunResult> = {}): CrawlRunResult {
  return {
    version: 1,
    seed_url: "https://example.com/",
    started_at: "2026-11-13T00:00:00.000Z",
    finished_at: "2026-11-13T00:00:01.000Z",
    settings: {
      max_depth: 2,
      max_pages: 20,
      concurrency: 2,
      delay_ms: 250,
    },
    stats: {
      discovered: 2,
      fetched: 1,
      failed: 1,
      content_truncated: 0,
      limit_reached: true,
      discovery_limit_reached: false,
    },
    pages: [
      {
        index: 1,
        url: "https://example.com/",
        title: "Example",
        depth: 0,
        sources: ["seed_url"],
        content_length: 9,
        content_hash: contentHash("# Example"),
        content_truncated: false,
      },
    ],
    failures: [
      {
        url: "https://example.com/missing",
        depth: 1,
        kind: "not_found",
        message: "Missing",
      },
    ],
    warnings: [],
    ...overrides,
  };
}

describe("createCrawlOutputWriter", () => {
  it("stages pages and renames the completed directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-output-"));
    const output = join(root, "result");
    const writer = await createCrawlOutputWriter(output);

    expect(await writer.writePage(page())).toBe("pages/0001-page.md");
    const structured = await writer.finish(result());

    const pageFile = await readFile(join(output, "pages", "0001-page.md"), "utf8");
    expect(pageFile).toBe("# Example\n\nSource: https://example.com/\n\n# Example\n");
    const manifest = JSON.parse(await readFile(join(output, "crawl.json"), "utf8"));
    expect(manifest.pages[0].path).toBe("pages/0001-page.md");
    expect(structured.pages[0]?.path).toBe("pages/0001-page.md");
    expect(await readdir(root)).toEqual(["result"]);
  });

  it("rejects an existing output path before creating staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-output-"));
    const output = join(root, "result");
    await mkdir(output);

    await expect(createCrawlOutputWriter(output)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("removes its staging directory when aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-output-"));
    const output = join(root, "result");
    const writer = await createCrawlOutputWriter(output);
    await writer.writePage(page());

    await writer.abort();

    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual([]);
    await writer.abort();
  });

  it("allows only one concurrent writer to publish and leaves no artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-output-"));
    const output = join(root, "result");
    const first = await createCrawlOutputWriter(output);
    const second = await createCrawlOutputWriter(output);
    await first.writePage(page());
    await second.writePage(page());

    const settled = await Promise.allSettled([first.finish(result()), second.finish(result())]);

    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.filter((item) => item.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "EEXIST" },
    });
    expect(await readdir(root)).toEqual(["result"]);
  });

  it("recovers a publication lock left by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-output-"));
    const output = join(root, "result");
    const writer = await createCrawlOutputWriter(output);
    await writer.writePage(page());
    await writeFile(join(root, ".result.lock"), JSON.stringify({ pid: 99_999_999 }), "utf8");

    await expect(writer.finish(result())).resolves.toMatchObject({
      pages: [{ path: "pages/0001-page.md" }],
    });
    expect(await readdir(root)).toEqual(["result"]);
  });
});

describe("formatCrawlPlanHuman", () => {
  it("summarizes the bounded plan and its output file", () => {
    const plan: CrawlPlanResult = {
      version: 1,
      seed_url: "https://example.com/",
      generated_at: "2026-11-14T00:00:00.000Z",
      settings: {
        max_depth: 2,
        max_pages: 3,
        concurrency: 2,
        delay_ms: 250,
        sitemap_mode: "include",
      },
      seed: {
        url: "https://example.com/",
        title: "Example",
        depth: 0,
        content_length: 100,
        content_hash: contentHash("seed"),
        content_truncated: false,
      },
      urls: [
        { url: "https://example.com/a", sources: ["markdown"] },
        { url: "https://example.com/b", sources: ["sitemap"] },
      ],
      deferred: [
        {
          url: "https://example.com/c",
          sources: ["sitemap"],
          reason: "page_limit",
        },
      ],
      filtered: [
        {
          url: "https://other.example/",
          sources: ["markdown"],
          reason: "cross_origin",
        },
      ],
      stats: {
        candidates: 4,
        eligible: 3,
        selected: 2,
        deferred: 1,
        filtered: 1,
        planned_pages: 3,
        page_limit_reached: true,
        discovery_limit_reached: false,
        sitemap_candidates: 2,
      },
      diagnostics_truncated: false,
      warnings: [{ code: "sitemap_invalid", message: "one child Sitemap failed" }],
    };

    const output = formatCrawlPlanHuman(plan, "crawl-plan.json");
    expect(output).toContain("Planned pages including seed: 3");
    expect(output).toContain("Deferred by page limit: 1");
    expect(output).toContain("Filtered: 1");
    expect(output).toContain("sitemap_invalid: one child Sitemap failed");
    expect(output).toContain("Output: crawl-plan.json");
  });
});

describe("formatCrawlHuman", () => {
  it("reports limits, counts, truncation, and output path", () => {
    expect(formatCrawlHuman(result(), "crawl-output")).toContain("Output: crawl-output");
    expect(formatCrawlHuman(result(), "crawl-output")).toContain("Fetched: 1");
    expect(formatCrawlHuman(result(), "crawl-output")).toContain("Failed: 1");
    expect(formatCrawlHuman(result(), "crawl-output")).toContain("Page limit reached: yes");
    expect(formatCrawlHuman(result(), "crawl-output")).toContain("Page limit: 20");
  });

  it("reports pages skipped by unchanged Sitemap lastmod", () => {
    const withSkips = result();
    withSkips.stats.sitemap_lastmod_skipped = 2;

    expect(formatCrawlHuman(withSkips, "crawl-output")).toContain("Sitemap lastmod skips: 2");
  });

  it("reports fetched page discovery sources", () => {
    const output = formatCrawlHuman(
      result({
        pages: [
          {
            index: 1,
            url: "https://example.com/",
            title: "Example",
            depth: 0,
            sources: ["seed_url"],
            content_length: 9,
            content_hash: contentHash("# Example"),
            content_truncated: false,
          },
          {
            index: 2,
            url: "https://example.com/docs",
            title: "Docs",
            depth: 1,
            sources: ["markdown", "sitemap"],
            content_length: 20,
            content_hash: contentHash("docs"),
            content_truncated: false,
          },
        ],
      }),
      "crawl-output",
    );

    expect(output).toContain("Markdown-sourced pages: 1");
    expect(output).toContain("Sitemap-sourced pages: 1");
  });

  it("reports retry provenance in the human summary", () => {
    const output = formatCrawlHuman(
      result({
        retry_of: {
          source: "crawl.json",
          original_failures: 4,
          attempted: 2,
          deduplicated: 0,
          skipped: [],
          truncated: false,
        },
      }),
      "retry-output",
    );

    expect(output).toContain("Retry of: crawl.json");
    expect(output).toContain("Retry attempted: 2 of 4 original failures");
    expect(output).toContain("Retry deduplicated: 0");
  });

  it("reports cache statistics in the human summary", () => {
    const output = formatCrawlHuman(
      result({
        stats: {
          ...result().stats,
          cache_hits: 2,
          cache_misses: 1,
          cache_errors: 0,
        },
      }),
      "crawl-output",
    );

    expect(output).toContain("Cache hits: 2");
    expect(output).toContain("Cache misses: 1");
  });

  it("reports incremental change counts against a baseline", () => {
    const output = formatCrawlHuman(
      result({
        baseline: { source: "previous/crawl.json" },
        changes: {
          added: [{ url: "https://example.com/new", content_hash: "a".repeat(64) }],
          modified: [],
          unchanged: [],
          removed: [],
        },
        stats: {
          ...result().stats,
          added: 1,
          modified: 0,
          unchanged: 0,
          removed: 0,
        },
      }),
      "changes",
    );

    expect(output).toContain("Baseline: previous/crawl.json");
    expect(output).toContain("Changes: +1 ~0 =0 -0");
  });

  it("reports Sitemap mode, candidates, and warnings when present", () => {
    const output = formatCrawlHuman(
      result({
        settings: {
          max_depth: 2,
          max_pages: 20,
          concurrency: 2,
          delay_ms: 250,
          sitemap_mode: "include",
        },
        stats: {
          discovered: 2,
          fetched: 1,
          failed: 1,
          content_truncated: 0,
          limit_reached: true,
          discovery_limit_reached: false,
          sitemap_candidates: 3,
        },
        warnings: [{ code: "sitemap_invalid", message: "child Sitemap was invalid" }],
      }),
      "crawl-output",
    );

    expect(output).toContain("Sitemap: include");
    expect(output).toContain("Sitemap candidates: 3");
    expect(output).toContain("Warnings: 1");
    expect(output).toContain("sitemap_invalid: child Sitemap was invalid");
  });
});
