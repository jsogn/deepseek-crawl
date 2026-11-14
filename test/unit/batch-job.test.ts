import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BatchFetchJobStore } from "../../src/batch/job.js";
import type { BatchFetchJobState, BatchFetchPage } from "../../src/batch/types.js";
import { contentHash } from "../../src/content/hash.js";
import { pageRelativePath } from "../../src/output/page.js";

const startedAt = "2026-11-14T01:00:00.000Z";
const updatedAt = "2026-11-14T01:00:01.000Z";

function initialState(outputDir = "/tmp/final-pages"): BatchFetchJobState {
  return {
    version: 1,
    status: "running",
    source: "map.json",
    output_dir: outputDir,
    started_at: startedAt,
    updated_at: startedAt,
    input: 2,
    settings: {
      concurrency: 2,
      delay_ms: 0,
      max_chars: 1000,
    },
    requests: [
      { index: 1, url: "https://example.com/a" },
      { index: 2, url: "https://example.com/b" },
    ],
    pages: [],
    failures: [],
  };
}

function page(): BatchFetchPage {
  return {
    index: 1,
    url: "https://example.com/a",
    title: "A",
    content: "# A",
    contentHash: contentHash("# A"),
    contentTruncated: false,
    contentOriginalLength: 3,
  };
}

describe("BatchFetchJobStore", () => {
  it("writes pages and checkpoints state atomically for resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-batch-job-"));
    const directory = join(root, "job");
    const store = await BatchFetchJobStore.create(
      directory,
      initialState(),
      () => new Date(updatedAt),
    );

    await store.recordPage(page());
    await store.recordFailure({
      index: 2,
      url: "https://example.com/b",
      kind: "timeout",
      message: "timed out",
    });
    await store.markInterrupted(new Error("stopped"), () => new Date(updatedAt));

    expect(store.state).toMatchObject({
      status: "interrupted",
      updated_at: updatedAt,
      pages: [{ index: 1, url: "https://example.com/a" }],
      failures: [{ index: 2, url: "https://example.com/b", kind: "timeout" }],
      last_error: "stopped",
    });
    expect(await readFile(join(directory, pageRelativePath(page())), "utf8")).toContain(
      "Source: https://example.com/a",
    );
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    await store.release();

    const reopened = await BatchFetchJobStore.open(directory);
    expect(reopened.state).toEqual(store.state);
    await reopened.release();
  });

  it("publishes a completed job into its stored output directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-batch-job-"));
    const directory = join(root, "job");
    const output = join(root, "final");
    const store = await BatchFetchJobStore.create(directory, initialState(output));
    await store.recordPage(page());
    await store.markCompleted(() => new Date(updatedAt));

    const result = await store.finalize();

    expect(result).toMatchObject({
      source: "map.json",
      stats: { input: 2, unique: 2, fetched: 1, failed: 0 },
      pages: [{ index: 1, path: "pages/0001-a.md" }],
    });
    expect(JSON.parse(await readFile(join(output, "fetch.json"), "utf8"))).toMatchObject({
      pages: [{ index: 1, path: "pages/0001-a.md" }],
    });
    await store.release();
  });

  it("holds one writer and rejects incompatible state versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-batch-job-"));
    const directory = join(root, "job");
    const store = await BatchFetchJobStore.create(directory, initialState());
    await expect(BatchFetchJobStore.open(directory)).rejects.toMatchObject({ code: "EEXIST" });
    await store.release();

    const incompatibleRoot = await mkdtemp(join(tmpdir(), "deepseek-batch-job-"));
    const incompatibleDirectory = join(incompatibleRoot, "job");
    const incompatible = await BatchFetchJobStore.create(incompatibleDirectory, {
      ...initialState(),
      version: 2,
    } as unknown as BatchFetchJobState);
    await incompatible.release();
    await expect(BatchFetchJobStore.open(incompatibleDirectory)).rejects.toThrow(
      /invalid|incompatible/i,
    );
  });
});
