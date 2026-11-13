import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CrawlPage, CrawlRunResult } from "../../src/crawl/types.js";
import { createCrawlOutputWriter, formatCrawlHuman } from "../../src/output/crawl.js";

function page(overrides: Partial<CrawlPage> = {}): CrawlPage {
  return {
    index: 1,
    url: "https://example.com/",
    title: "Example",
    depth: 0,
    content: "# Example",
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
        content_length: 9,
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

describe("formatCrawlHuman", () => {
  it("reports limits, counts, truncation, and output path", () => {
    expect(formatCrawlHuman(result(), "crawl-output")).toContain("Output: crawl-output");
    expect(formatCrawlHuman(result(), "crawl-output")).toContain("Fetched: 1");
    expect(formatCrawlHuman(result(), "crawl-output")).toContain("Failed: 1");
    expect(formatCrawlHuman(result(), "crawl-output")).toContain("Page limit reached: yes");
    expect(formatCrawlHuman(result(), "crawl-output")).toContain("Page limit: 20");
  });
});
