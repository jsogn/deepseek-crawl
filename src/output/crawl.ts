import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CrawlOutputResult,
  CrawlPage,
  CrawlPlanResult,
  CrawlRunResult,
} from "../crawl/types.js";
import { renderPageMarkdown } from "./page.js";
import { createStagedDirectoryOutput } from "./publication.js";

export interface CrawlOutputWriter {
  writePage(page: CrawlPage): Promise<string>;
  finish(result: CrawlRunResult): Promise<CrawlOutputResult>;
  abort(): Promise<void>;
}

export interface CrawlOutputWriterOptions {
  allowMissingPages?: boolean;
}

export async function createCrawlOutputWriter(
  finalDirectory: string,
  options: CrawlOutputWriterOptions = {},
): Promise<CrawlOutputWriter> {
  const directory = await createStagedDirectoryOutput(
    finalDirectory,
    "Crawl output writer is no longer writable.",
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
            if (options.allowMissingPages && summary.change_status === "unchanged") {
              return { ...summary, written: false };
            }
            throw new Error(`Crawl page ${summary.index} was not written.`);
          }
          return { ...summary, written: true, path };
        });
        const output: CrawlOutputResult = { ...result, pages };

        await writeFile(
          join(stagingPath, "crawl.json"),
          `${JSON.stringify(output, null, 2)}\n`,
          "utf8",
        );
        return output;
      });
    },

    abort: () => directory.abort(),
  };
}

export function formatCrawlHuman(result: CrawlRunResult, outputDirectory: string): string {
  const lines = [
    `Seed: ${result.seed_url}`,
    `Depth: ${result.settings.max_depth}`,
    `Page limit: ${result.settings.max_pages}`,
    `Concurrency: ${result.settings.concurrency}`,
    `Delay: ${result.settings.delay_ms} ms`,
    `Fetched: ${result.stats.fetched}`,
    `Failed: ${result.stats.failed}`,
    `Markdown-sourced pages: ${result.pages.filter((page) => page.sources.includes("markdown")).length}`,
    `Sitemap-sourced pages: ${result.pages.filter((page) => page.sources.includes("sitemap")).length}`,
    `Content truncated: ${result.stats.content_truncated}`,
    `Page limit reached: ${result.stats.limit_reached ? "yes" : "no"}`,
    `Discovery limit reached: ${result.stats.discovery_limit_reached ? "yes" : "no"}`,
  ];
  if (result.settings.sitemap_mode !== undefined) {
    lines.push(`Sitemap: ${result.settings.sitemap_mode}`);
  }
  if (result.stats.sitemap_candidates !== undefined) {
    lines.push(`Sitemap candidates: ${result.stats.sitemap_candidates}`);
  }
  if (result.warnings.length > 0) {
    lines.push(`Warnings: ${result.warnings.length}`);
    for (const warning of result.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
  }
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
  if (result.baseline) {
    lines.push(`Baseline: ${result.baseline.source}`);
  }
  if (
    result.stats.added !== undefined ||
    result.stats.modified !== undefined ||
    result.stats.unchanged !== undefined ||
    result.stats.removed !== undefined
  ) {
    lines.push(
      `Changes: +${result.stats.added ?? 0} ~${result.stats.modified ?? 0} =${result.stats.unchanged ?? 0} -${result.stats.removed ?? 0}`,
    );
  }
  lines.push(`Output: ${outputDirectory}`);
  return lines.join("\n");
}

export function formatCrawlPlanHuman(result: CrawlPlanResult, output: string): string {
  const lines = [
    `Seed: ${result.seed_url}`,
    `Depth: ${result.settings.max_depth}`,
    `Page limit: ${result.settings.max_pages}`,
    `Sitemap: ${result.settings.sitemap_mode ?? "skip"}`,
    `Candidate URLs: ${result.stats.candidates}`,
    `Eligible URLs: ${result.stats.eligible}`,
    `Selected child pages: ${result.stats.selected}`,
    `Planned pages including seed: ${result.stats.planned_pages}`,
    `Deferred by page limit: ${result.stats.deferred}`,
    `Filtered: ${result.stats.filtered}`,
    `Page limit reached: ${result.stats.page_limit_reached ? "yes" : "no"}`,
    `Discovery limit reached: ${result.stats.discovery_limit_reached ? "yes" : "no"}`,
    `Diagnostics truncated: ${result.diagnostics_truncated ? "yes" : "no"}`,
  ];
  if (result.warnings.length > 0) {
    lines.push(`Warnings: ${result.warnings.length}`);
    for (const warning of result.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
  }
  if (result.stats.cache_hits !== undefined || result.stats.cache_misses !== undefined) {
    lines.push(
      `Cache hits: ${result.stats.cache_hits ?? 0}`,
      `Cache misses: ${result.stats.cache_misses ?? 0}`,
      `Cache errors: ${result.stats.cache_errors ?? 0}`,
    );
  }
  lines.push(`Output: ${output}`);
  return lines.join("\n");
}
