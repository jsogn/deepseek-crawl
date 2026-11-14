import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CrawlJobStore } from "../../src/crawl/job.js";
import type { CrawlCheckpointState, CrawlRunResult } from "../../src/crawl/types.js";

function state(overrides: Partial<CrawlCheckpointState> = {}): CrawlCheckpointState {
  return {
    version: 2,
    status: "running",
    seed_url: "https://example.com/",
    started_at: "2026-11-14T01:00:00.000Z",
    updated_at: "2026-11-14T01:00:01.000Z",
    options: {
      maxDepth: 2,
      maxPages: 5,
      concurrency: 2,
      delayMs: 0,
      includePaths: [],
      excludePaths: [],
      ignoreQueryParameters: false,
      sitemapMode: "skip",
    },
    counters: {
      nextIndex: 2,
      attemptedPages: 1,
      fetched: 1,
      contentTruncated: 0,
      limitReached: false,
      discoveryLimitReached: false,
      sitemapCandidates: 0,
      sitemapLastmodSkipped: 0,
    },
    seen: ["https://example.com/"],
    sources: [{ url: "https://example.com/", sources: ["seed_url"] }],
    pages: [
      {
        index: 1,
        url: "https://example.com/",
        title: "Seed",
        depth: 0,
        sources: ["seed_url"],
        content_length: 4,
        content_hash: "a".repeat(64),
        content_truncated: false,
      },
    ],
    failures: [],
    warnings: [],
    frontier: [],
    depth: 1,
    ...overrides,
  };
}

function result(): CrawlRunResult {
  const s = state();
  return {
    version: 2,
    seed_url: s.seed_url,
    started_at: s.started_at,
    finished_at: "2026-11-14T01:00:02.000Z",
    settings: {
      max_depth: s.options.maxDepth,
      max_pages: s.options.maxPages,
      concurrency: s.options.concurrency,
      delay_ms: s.options.delayMs,
      sitemap_mode: s.options.sitemapMode,
    },
    stats: {
      discovered: 1,
      fetched: 1,
      failed: 0,
      content_truncated: 0,
      limit_reached: false,
      discovery_limit_reached: false,
      sitemap_lastmod_skipped: 0,
    },
    pages: s.pages,
    failures: [],
    warnings: [],
  };
}

describe("CrawlJobStore", () => {
  it("creates, checkpoints, and reopens a durable Crawl job", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-job-"));
    const directory = join(root, "job");
    const job = await CrawlJobStore.create(directory);
    await job.checkpoint(state());
    await job.writePage({
      index: 1,
      url: "https://example.com/",
      title: "Seed",
      depth: 0,
      content: "body",
      content_hash: "a".repeat(64),
      sources: ["seed_url"],
      content_truncated: false,
      content_original_length: 4,
    });
    await job.release();

    const resumed = await CrawlJobStore.open(directory);
    expect(resumed.state).toMatchObject({
      status: "running",
      seed_url: "https://example.com/",
      pages: [{ url: "https://example.com/", content_hash: "a".repeat(64) }],
    });
    expect(await readFile(join(directory, "pages", "0001-page.md"), "utf8")).toContain(
      "Source: https://example.com/",
    );
    await resumed.release();
  });

  it("allows only one active writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-job-"));
    const directory = join(root, "job");
    const first = await CrawlJobStore.create(directory);
    await first.checkpoint(state());

    await expect(CrawlJobStore.open(directory)).rejects.toMatchObject({ code: "EEXIST" });
    await first.release();
    const reopened = await CrawlJobStore.open(directory);
    await reopened.release();
  });

  it("rejects unsafe or incomplete job state", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-job-"));
    const directory = join(root, "job");
    const job = await CrawlJobStore.create(directory);
    await job.checkpoint(state({ version: 1 as unknown as 2 }));
    await job.release();

    await expect(CrawlJobStore.open(directory)).rejects.toThrow(/job|version|invalid/i);
  });

  it("removes a stale writer lock after an abrupt termination", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-job-"));
    const directory = join(root, "job");
    const job = await CrawlJobStore.create(directory);
    await job.checkpoint(state());
    await job.release();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(directory, "writer.lock"), JSON.stringify({ pid: 99_999_999 }));

    const reopened = await CrawlJobStore.open(directory);
    await reopened.release();
    await expect(lstat(join(directory, "writer.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes a completed job as an atomic Crawl output directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-job-"));
    const directory = join(root, "job");
    const output = join(root, "output");
    const job = await CrawlJobStore.create(directory);
    const completed = state({ status: "completed" });
    await job.checkpoint(completed);
    await job.writePage({
      index: 1,
      url: "https://example.com/",
      title: "Seed",
      depth: 0,
      content: "body",
      content_hash: "a".repeat(64),
      sources: ["seed_url"],
      content_truncated: false,
      content_original_length: 4,
    });

    await expect(job.finalize(output, result())).resolves.toMatchObject({
      pages: [{ written: true, path: "pages/0001-page.md" }],
    });
    expect(await readFile(join(output, "crawl.json"), "utf8")).toContain(
      '"content_hash": "aaaaaaaa',
    );
    await job.release();
  });
});
