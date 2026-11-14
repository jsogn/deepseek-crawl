import {
  cacheStatsFor,
  contentHashFor,
  fetchSourceFor,
  prepareCachedFetch,
} from "../cache/cached-gateway.js";
import { canonicalizeCrawlUrl } from "../crawl/filters.js";
import { sameOrigin } from "../crawl/links.js";
import { runLayeredTasks } from "../crawl/queue.js";
import type {
  CrawlFailure,
  CrawlPage,
  CrawlPageSource,
  CrawlPageSummary,
  CrawlRunResult,
} from "../crawl/types.js";
import { DeepSeekError } from "../deepseek/errors.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import { errorMessage } from "../error-message.js";
import { boundFetchOutput, codepointLength } from "../output/bounds.js";
import { createIndexAllocator } from "../retry/indexes.js";
import { type CrawlRetryFailure, parseCrawlRetryReport } from "../retry/report.js";
import type { RetryAttempt, RetrySummary } from "../retry/types.js";
import { normalizeCrawlOptions } from "./crawl.js";

const RETRY_DISCOVERY_LIMIT = 10_000;
const RETRY_PAGE_CONTENT_LIMIT = 1_000_000;
const SOURCE_ORDER: CrawlPageSource[] = ["seed_url", "markdown", "sitemap"];

interface CrawlRetryRequest {
  url: string;
  index: number;
  depth: number;
  sources: CrawlPageSource[];
  retryOf: RetryAttempt;
}

function retryAttempt(failure: CrawlRetryFailure): RetryAttempt {
  return {
    url: failure.url,
    ...(failure.index === undefined ? {} : { index: failure.index }),
    kind: failure.kind,
    message: failure.message,
  };
}

function sourcesInOrder(sources: readonly CrawlPageSource[]): CrawlPageSource[] {
  return SOURCE_ORDER.filter((source) => sources.includes(source));
}

function errorKind(error: unknown): string {
  return error instanceof DeepSeekError ? error.kind : "crawl";
}

function summaryFor(page: CrawlPage): CrawlPageSummary {
  return {
    index: page.index,
    url: page.url,
    title: page.title,
    depth: page.depth,
    sources: page.sources,
    ...(page.retrievedFrom ? { retrieved_from: page.retrievedFrom } : {}),
    content_length: codepointLength(page.content),
    content_hash: page.content_hash,
    content_truncated: page.content_truncated,
    ...(page.content_truncated ? { content_original_length: page.content_original_length } : {}),
    ...(page.retryOf ? { retry_of: page.retryOf } : {}),
  };
}

export async function executeCrawlRetry(
  client: DeepSeekGateway,
  input: unknown,
  reportSource: string,
  onPage?: (page: CrawlPage) => Promise<void>,
  signal?: AbortSignal,
): Promise<CrawlRunResult> {
  const report = parseCrawlRetryReport(input);
  const limits = normalizeCrawlOptions({
    maxDepth: report.settings.max_depth,
    maxPages: report.settings.max_pages,
    concurrency: report.settings.concurrency,
    delayMs: report.settings.delay_ms,
    discoveryLimit: RETRY_DISCOVERY_LIMIT,
    pageContentLimit: RETRY_PAGE_CONTENT_LIMIT,
    includePaths: [],
    excludePaths: [],
    ignoreQueryParameters: false,
    ...(report.settings.sitemap_mode === undefined
      ? {}
      : { sitemapMode: report.settings.sitemap_mode }),
  });
  const seed = canonicalizeCrawlUrl(report.seedUrl);
  if (!seed) {
    throw new Error("Crawl retry report must contain a valid HTTP(S) seed URL.");
  }

  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  combinedSignal.throwIfAborted();
  const now = () => new Date();
  const startedAt = now().toISOString();
  const requests: CrawlRetryRequest[] = [];
  const skipped: RetryAttempt[] = [];
  const seen = new Set<string>();
  const indexes = createIndexAllocator();
  let deduplicated = 0;
  let truncated = false;

  for (const failure of report.failures) {
    const normalized = canonicalizeCrawlUrl(failure.url);
    if (
      !normalized ||
      !sameOrigin(normalized, seed) ||
      normalized.href === seed.href ||
      failure.depth === 0 ||
      failure.depth > limits.maxDepth
    ) {
      skipped.push(retryAttempt(failure));
      continue;
    }
    if (seen.has(normalized.href)) {
      deduplicated += 1;
      continue;
    }
    if (requests.length >= limits.maxPages) {
      skipped.push(retryAttempt(failure));
      truncated = true;
      continue;
    }
    seen.add(normalized.href);
    const index = indexes.allocate(failure.index);
    requests.push({
      url: normalized.href,
      index,
      depth: failure.depth,
      sources: sourcesInOrder(failure.sources),
      retryOf: retryAttempt(failure),
    });
  }
  requests.sort((left, right) => left.depth - right.depth || left.index - right.index);

  const retryOf: RetrySummary = {
    source: reportSource,
    original_failures: report.failures.length,
    attempted: requests.length,
    deduplicated,
    skipped,
    truncated,
  };
  const pages: CrawlPageSummary[] = [];
  const failures: CrawlFailure[] = [];
  let contentTruncated = 0;

  const outcomes = await runLayeredTasks<CrawlRetryRequest, CrawlPageSummary | CrawlFailure>(
    requests,
    {
      concurrency: limits.concurrency,
      delayMs: limits.delayMs,
      signal: combinedSignal,
      immediate: async (request) => prepareCachedFetch(client, { url: request.url }),
      run: async (request) => {
        try {
          const response = await client.fetch({ url: request.url }, combinedSignal);
          const hash = contentHashFor(client, request.url, response);
          const retrievedFrom = fetchSourceFor(client, request.url);
          const bounded = boundFetchOutput(
            { ...response, url: request.url },
            limits.pageContentLimit,
          );
          const page: CrawlPage = {
            index: request.index,
            url: request.url,
            title: bounded.title,
            depth: request.depth,
            content: bounded.content,
            content_hash: hash,
            ...(retrievedFrom ? { retrievedFrom } : {}),
            sources: request.sources,
            content_truncated: bounded.truncated ?? false,
            content_original_length: bounded.original_length ?? codepointLength(bounded.content),
            retryOf: request.retryOf,
          };
          if (onPage) {
            try {
              await onPage(page);
            } catch (error) {
              controller.abort(error);
              throw error;
            }
          }
          return summaryFor(page);
        } catch (error) {
          if (combinedSignal.aborted) {
            throw error;
          }
          return {
            url: request.url,
            index: request.index,
            depth: request.depth,
            sources: request.sources,
            kind: errorKind(error),
            message: errorMessage(error),
            retry_of: request.retryOf,
          };
        }
      },
    },
  );

  for (const outcome of outcomes) {
    if ("kind" in outcome) {
      failures.push(outcome);
    } else {
      pages.push(outcome);
      contentTruncated += outcome.content_truncated ? 1 : 0;
    }
  }
  pages.sort((left, right) => left.index - right.index);
  failures.sort((left, right) => left.depth - right.depth || left.url.localeCompare(right.url));

  const cacheStats = cacheStatsFor(client);
  return {
    version: 2,
    seed_url: seed.href,
    started_at: startedAt,
    finished_at: now().toISOString(),
    settings: {
      max_depth: limits.maxDepth,
      max_pages: limits.maxPages,
      concurrency: limits.concurrency,
      delay_ms: limits.delayMs,
      ...(report.settings.sitemap_mode === undefined
        ? {}
        : { sitemap_mode: report.settings.sitemap_mode }),
    },
    stats: {
      discovered: requests.length,
      fetched: pages.length,
      failed: failures.length,
      content_truncated: contentTruncated,
      limit_reached: false,
      discovery_limit_reached: false,
      ...(cacheStats
        ? {
            cache_hits: cacheStats.hits,
            cache_misses: cacheStats.misses,
            cache_errors: cacheStats.errors,
          }
        : {}),
    },
    pages,
    failures,
    warnings: [],
    retry_of: retryOf,
  };
}
