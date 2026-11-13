import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BatchFetchOutputResult, BatchFetchPage, BatchFetchResult } from "../batch/types.js";
import { renderPageMarkdown } from "./page.js";
import { createStagedDirectoryOutput } from "./publication.js";

export interface BatchFetchOutputWriter {
  writePage(page: BatchFetchPage): Promise<string>;
  finish(result: BatchFetchResult): Promise<BatchFetchOutputResult>;
  abort(): Promise<void>;
}

export async function createBatchFetchOutputWriter(
  finalDirectory: string,
): Promise<BatchFetchOutputWriter> {
  const directory = await createStagedDirectoryOutput(
    finalDirectory,
    "Batch Fetch output writer is no longer writable.",
  );

  return {
    async writePage(page) {
      return directory.writePage(page, renderPageMarkdown(page));
    },
    async finish(result) {
      return directory.finish(async (stagingPath, pagePaths) => {
        const pages = result.pages.map((summary) => {
          const path = pagePaths.get(summary.index);
          if (!path) {
            throw new Error(`Batch Fetch page ${summary.index} was not written.`);
          }
          return { ...summary, path };
        });
        const output: BatchFetchOutputResult = { ...result, pages };
        await writeFile(
          join(stagingPath, "fetch.json"),
          `${JSON.stringify(output, null, 2)}\n`,
          "utf8",
        );
        return output;
      });
    },
    abort: () => directory.abort(),
  };
}

export function formatBatchFetchHuman(result: BatchFetchResult, outputDirectory: string): string {
  const lines = [
    `Input: ${result.source}`,
    `URLs: ${result.stats.input} input, ${result.stats.unique} unique`,
    `Concurrency: ${result.settings.concurrency}`,
    `Delay: ${result.settings.delay_ms} ms`,
    `Fetched: ${result.stats.fetched}`,
    `Failed: ${result.stats.failed}`,
  ];
  if (result.retry_of) {
    lines.push(
      `Retry of: ${result.retry_of.source}`,
      `Retry attempted: ${result.retry_of.attempted} of ${result.retry_of.original_failures} original failures`,
      `Retry deduplicated: ${result.retry_of.deduplicated}`,
      `Retry skipped: ${result.retry_of.skipped.length}`,
      `Retry truncated: ${result.retry_of.truncated ? "yes" : "no"}`,
    );
  }
  if (result.stats.cache_hits !== undefined || result.stats.cache_misses !== undefined) {
    lines.push(
      `Cache hits: ${result.stats.cache_hits ?? 0}`,
      `Cache misses: ${result.stats.cache_misses ?? 0}`,
      `Cache errors: ${result.stats.cache_errors ?? 0}`,
    );
  }
  lines.push(`Output: ${outputDirectory}`);
  return lines.join("\n");
}
