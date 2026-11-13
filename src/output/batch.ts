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
  return [
    `Input: ${result.source}`,
    `URLs: ${result.stats.input} input, ${result.stats.unique} unique`,
    `Concurrency: ${result.settings.concurrency}`,
    `Delay: ${result.settings.delay_ms} ms`,
    `Fetched: ${result.stats.fetched}`,
    `Failed: ${result.stats.failed}`,
    `Output: ${outputDirectory}`,
  ].join("\n");
}
