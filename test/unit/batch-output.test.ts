import { lstat, mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BatchFetchResult } from "../../src/batch/types.js";
import { createBatchFetchOutputWriter, formatBatchFetchHuman } from "../../src/output/batch.js";

function result(): BatchFetchResult {
  return {
    version: 1,
    source: "map.json",
    started_at: "2026-11-14T01:00:00.000Z",
    finished_at: "2026-11-14T01:00:01.000Z",
    settings: { concurrency: 3, delay_ms: 250, max_chars: 0 },
    stats: { input: 1, unique: 1, fetched: 1, failed: 0 },
    pages: [
      {
        index: 1,
        url: "https://example.com/",
        title: "Example",
        content_length: 9,
        content_truncated: false,
      },
    ],
    failures: [],
  };
}

describe("batch fetch output", () => {
  it("stages pages and publishes fetch.json atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-batch-output-"));
    const output = join(root, "batch");
    const writer = await createBatchFetchOutputWriter(output);
    const path = await writer.writePage({
      index: 1,
      url: "https://example.com/",
      title: "Example",
      content: "# Example",
      contentTruncated: false,
      contentOriginalLength: 9,
    });
    const finished = await writer.finish(result());

    expect(path).toBe("pages/0001-page.md");
    expect(finished.pages[0]?.path).toBe(path);
    expect(await readFile(join(output, "pages", "0001-page.md"), "utf8")).toContain(
      "Source: https://example.com/",
    );
    expect(JSON.parse(await readFile(join(output, "fetch.json"), "utf8"))).toMatchObject({
      stats: { fetched: 1, failed: 0 },
      pages: [{ path }],
    });
  });

  it("rejects existing directories and abort removes staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-batch-output-"));
    const existing = join(root, "existing");
    await mkdir(existing);
    await expect(createBatchFetchOutputWriter(existing)).rejects.toMatchObject({
      code: "EEXIST",
    });

    const output = join(root, "aborted");
    const writer = await createBatchFetchOutputWriter(output);
    await writer.abort();
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).some((name) => name.startsWith(".aborted-"))).toBe(false);
  });

  it("formats a bounded human summary", () => {
    expect(formatBatchFetchHuman(result(), "/tmp/batch")).toContain("Fetched: 1");
    expect(formatBatchFetchHuman(result(), "/tmp/batch")).toContain("Output: /tmp/batch");
  });
});
