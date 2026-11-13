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

export async function createCrawlOutputWriter(finalDirectory: string): Promise<CrawlOutputWriter> {
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
            throw new Error(`Crawl page ${summary.index} was not written.`);
          }
          return { ...summary, path };
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
  lines.push(`Output: ${output}`);
  return lines.join("\n");
}
