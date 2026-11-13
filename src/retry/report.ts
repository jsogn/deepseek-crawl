import { z } from "zod";
import type { CrawlPageSource, CrawlRunResult } from "../crawl/types.js";
import type { RetryAttempt } from "./types.js";

const retryAttemptSchema = z.object({
  url: z.string(),
  index: z.number().int().positive().optional(),
  kind: z.string(),
  message: z.string(),
});

const batchRetryReportSchema = z.object({
  version: z.literal(1),
  source: z.string(),
  failures: z.array(retryAttemptSchema),
});

export interface BatchFetchRetryReport {
  source: string;
  failures: RetryAttempt[];
}

const crawlRetryFailureSchema = retryAttemptSchema.extend({
  depth: z.number().int().nonnegative(),
  sources: z.array(z.enum(["seed_url", "markdown", "sitemap"])).optional(),
});

const crawlRetryReportSchema = z.object({
  version: z.literal(1),
  seed_url: z.string(),
  settings: z.object({
    max_depth: z.number().int(),
    max_pages: z.number().int(),
    concurrency: z.number().int(),
    delay_ms: z.number().int(),
    sitemap_mode: z.enum(["include", "only", "skip"]).optional(),
  }),
  failures: z.array(crawlRetryFailureSchema),
});

export interface CrawlRetryFailure {
  url: string;
  index?: number;
  depth: number;
  sources: CrawlPageSource[];
  kind: string;
  message: string;
}

export interface CrawlRetryReport {
  seedUrl: string;
  settings: CrawlRunResult["settings"];
  failures: CrawlRetryFailure[];
}

export function parseBatchFetchRetryReport(input: unknown): BatchFetchRetryReport {
  const result = batchRetryReportSchema.safeParse(input);
  if (!result.success) {
    throw new Error("Invalid Batch Fetch retry report.", { cause: result.error });
  }
  return {
    source: result.data.source,
    failures: result.data.failures.map((failure) => ({
      url: failure.url,
      ...(failure.index === undefined ? {} : { index: failure.index }),
      kind: failure.kind,
      message: failure.message,
    })),
  };
}

export function parseCrawlRetryReport(input: unknown): CrawlRetryReport {
  const result = crawlRetryReportSchema.safeParse(input);
  if (!result.success) {
    throw new Error("Invalid Crawl retry report.", { cause: result.error });
  }
  return {
    seedUrl: result.data.seed_url,
    settings: {
      max_depth: result.data.settings.max_depth,
      max_pages: result.data.settings.max_pages,
      concurrency: result.data.settings.concurrency,
      delay_ms: result.data.settings.delay_ms,
      ...(result.data.settings.sitemap_mode === undefined
        ? {}
        : { sitemap_mode: result.data.settings.sitemap_mode }),
    },
    failures: result.data.failures.map((failure) => ({
      url: failure.url,
      ...(failure.index === undefined ? {} : { index: failure.index }),
      depth: failure.depth,
      sources:
        failure.sources && failure.sources.length > 0
          ? failure.sources
          : failure.depth === 0
            ? ["seed_url"]
            : ["markdown"],
      kind: failure.kind,
      message: failure.message,
    })),
  };
}
