import {
  cacheStatsFor,
  contentHashFor,
  fetchSourceFor,
  prepareCachedFetch,
} from "../cache/cached-gateway.js";
import { compareCrawlBaseline } from "../crawl/baseline.js";
import { canonicalizeCrawlUrl, createCrawlPathFilter } from "../crawl/filters.js";
import { extractMarkdownLinks, sameOrigin } from "../crawl/links.js";
import { runLayeredTasks } from "../crawl/queue.js";
import type {
  CrawlCheckpointActiveLayer,
  CrawlCheckpointState,
  CrawlFailure,
  CrawlOptions,
  CrawlPage,
  CrawlPageSource,
  CrawlPageSummary,
  CrawlRunResult,
  MapWarning,
} from "../crawl/types.js";
import { DeepSeekError } from "../deepseek/errors.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import { fetchInputSchema } from "../deepseek/schemas.js";
import { errorMessage } from "../error-message.js";
import { boundFetchOutput, codepointLength } from "../output/bounds.js";

const CRAWL_MAX_DEPTH = 5;
const CRAWL_MAX_PAGES = 100;
const CRAWL_MAX_CONCURRENCY = 5;
const CRAWL_MAX_DELAY_MS = 5_000;
const CRAWL_MAX_DISCOVERY_LIMIT = 10_000;
const CRAWL_MAX_PAGE_CONTENT_LIMIT = 1_000_000;
const PAGE_SOURCE_ORDER: CrawlPageSource[] = ["seed_url", "markdown", "sitemap"];

function clampInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Math.min(value, maximum);
}

export function normalizeCrawlOptions(options: CrawlOptions): CrawlOptions {
  const sitemapMode = options.sitemapMode ?? "skip";
  if (!["include", "only", "skip"].includes(sitemapMode)) {
    throw new Error("sitemapMode must be include, only, or skip.");
  }
  const normalized: CrawlOptions = {
    maxDepth: clampInteger(options.maxDepth, "maxDepth", 0, CRAWL_MAX_DEPTH),
    maxPages: clampInteger(options.maxPages, "maxPages", 1, CRAWL_MAX_PAGES),
    concurrency: clampInteger(options.concurrency, "concurrency", 1, CRAWL_MAX_CONCURRENCY),
    delayMs: clampInteger(options.delayMs, "delayMs", 0, CRAWL_MAX_DELAY_MS),
    discoveryLimit: clampInteger(
      options.discoveryLimit,
      "discoveryLimit",
      1,
      CRAWL_MAX_DISCOVERY_LIMIT,
    ),
    pageContentLimit: clampInteger(
      options.pageContentLimit,
      "pageContentLimit",
      1,
      CRAWL_MAX_PAGE_CONTENT_LIMIT,
    ),
    includePaths: options.includePaths ?? [],
    excludePaths: options.excludePaths ?? [],
    ignoreQueryParameters: options.ignoreQueryParameters ?? false,
    sitemapMode,
  };
  if (options.baseline !== undefined) {
    normalized.baseline = options.baseline;
  }
  normalized.changedOnly = options.changedOnly ?? false;
  if (options.resume !== undefined) {
    normalized.resume = options.resume;
  }
  if (options.onCheckpoint !== undefined) {
    normalized.onCheckpoint = options.onCheckpoint;
  }
  if (options.sitemapReader !== undefined) {
    normalized.sitemapReader = options.sitemapReader;
  }
  if (options.now !== undefined) {
    normalized.now = options.now;
  }
  return normalized;
}

interface PageOutcome {
  url: string;
  summary: CrawlPageSummary | null;
  links: string[];
  error: unknown | null;
}

interface MutableActiveLayer {
  depth: number;
  urls: string[];
  indexes: number[];
  completed: Set<string>;
  discovered: string[];
}

interface BoundedLinkCollector {
  add(link: string): void;
  values(): string[];
  finish(): { links: string[]; truncated: boolean };
}

function errorKind(error: unknown): string {
  return error instanceof DeepSeekError ? error.kind : "crawl";
}

function summaryFor(page: CrawlPage): CrawlPageSummary {
  const summary: CrawlPageSummary = {
    index: page.index,
    url: page.url,
    title: page.title,
    depth: page.depth,
    sources: page.sources,
    ...(page.retrievedFrom ? { retrieved_from: page.retrievedFrom } : {}),
    content_length: codepointLength(page.content),
    content_hash: page.content_hash,
    ...(page.change_status ? { change_status: page.change_status } : {}),
    ...(page.previous_content_hash ? { previous_content_hash: page.previous_content_hash } : {}),
    content_truncated: page.content_truncated,
  };
  if (page.content_truncated) {
    summary.content_original_length = page.content_original_length;
  }
  return summary;
}

function pageSourcesInOrder(sources: Set<CrawlPageSource>): CrawlPageSource[] {
  return PAGE_SOURCE_ORDER.filter((source) => sources.has(source));
}

function createBoundedLinkCollector(capacity: number, seen: Set<string>): BoundedLinkCollector {
  let candidates = new Set<string>();
  let truncated = false;

  const trim = (): void => {
    if (candidates.size <= capacity) {
      return;
    }
    const retained = [...candidates].sort().slice(0, capacity);
    candidates = new Set(retained);
    truncated = true;
  };

  return {
    add(link: string): void {
      if (seen.has(link) || candidates.has(link)) {
        return;
      }
      if (capacity === 0) {
        truncated = true;
        return;
      }
      candidates.add(link);
      if (candidates.size >= capacity * 2) {
        trim();
      }
    },
    values(): string[] {
      return [...candidates].sort();
    },
    finish(): { links: string[]; truncated: boolean } {
      trim();
      const links = [...candidates].sort();
      for (const link of links) {
        seen.add(link);
      }
      return { links, truncated };
    },
  };
}

export async function executeCrawl(
  client: DeepSeekGateway,
  input: unknown,
  options: CrawlOptions,
  onPage?: (page: CrawlPage) => Promise<void>,
  signal?: AbortSignal,
): Promise<CrawlRunResult> {
  const limits = normalizeCrawlOptions(options);
  if (limits.changedOnly && !limits.baseline) {
    throw new Error("Crawl --changed-only requires a baseline report.");
  }
  const sitemapMode = limits.sitemapMode ?? "skip";
  if (sitemapMode !== "skip" && !limits.sitemapReader) {
    throw new Error("Sitemap reader is required when sitemap mode is include or only.");
  }
  const parsed = fetchInputSchema.parse(input);
  const seed = canonicalizeCrawlUrl(parsed.url, undefined, limits.ignoreQueryParameters);
  if (!seed) {
    throw new Error("Crawl URL must be an HTTP(S) URL with a host and no credentials.");
  }
  const pathFilter = createCrawlPathFilter(limits.includePaths ?? [], limits.excludePaths ?? []);

  const now = limits.now ?? (() => new Date());
  const crawlController = new AbortController();
  const crawlSignal = signal
    ? AbortSignal.any([signal, crawlController.signal])
    : crawlController.signal;
  crawlSignal.throwIfAborted();
  const resume = limits.resume;
  if (resume) {
    const resumeSeed = canonicalizeCrawlUrl(
      resume.seed_url,
      undefined,
      limits.ignoreQueryParameters,
    );
    if (!resumeSeed || resumeSeed.href !== seed.href) {
      throw new Error("Crawl job seed URL does not match the requested Crawl URL.");
    }
  }
  const startedAt = resume?.started_at ?? now().toISOString();
  const seen = new Set<string>(resume?.seen ?? [seed.href]);
  const sourcesByUrl = new Map<string, Set<CrawlPageSource>>(
    resume?.sources.map((source) => [source.url, new Set(source.sources)]) ?? [
      [seed.href, new Set<CrawlPageSource>(["seed_url"])],
    ],
  );
  const pages: CrawlPageSummary[] = [...(resume?.pages ?? [])];
  const failures: CrawlFailure[] = [...(resume?.failures ?? [])];
  const warnings: MapWarning[] = [...(resume?.warnings ?? [])];
  let frontier: string[] = [...(resume?.frontier ?? [])];
  let nextIndex = resume?.counters.nextIndex ?? 1;
  let attemptedPages = resume?.counters.attemptedPages ?? 1;
  let fetched = resume?.counters.fetched ?? 0;
  let contentTruncated = resume?.counters.contentTruncated ?? 0;
  let limitReached = resume?.counters.limitReached ?? false;
  let discoveryLimitReached = resume?.counters.discoveryLimitReached ?? false;
  let sitemapCandidates = resume?.counters.sitemapCandidates ?? 0;
  let depth = resume?.depth ?? 1;
  let activeLayer: MutableActiveLayer | undefined = resume?.active_layer
    ? {
        depth: resume.active_layer.depth,
        urls: [...resume.active_layer.urls],
        indexes: [...resume.active_layer.indexes],
        completed: new Set(resume.active_layer.completed),
        discovered: [...resume.active_layer.discovered],
      }
    : undefined;
  let checkpointChain = Promise.resolve();

  const checkpoint = (
    status: CrawlCheckpointState["status"],
    lastError?: string,
  ): Promise<void> => {
    if (!limits.onCheckpoint) {
      return Promise.resolve();
    }
    const snapshot: CrawlCheckpointState = {
      version: 1,
      status,
      seed_url: seed.href,
      started_at: startedAt,
      updated_at: now().toISOString(),
      options: {
        maxDepth: limits.maxDepth,
        maxPages: limits.maxPages,
        concurrency: limits.concurrency,
        delayMs: limits.delayMs,
        includePaths: [...(limits.includePaths ?? [])],
        excludePaths: [...(limits.excludePaths ?? [])],
        ignoreQueryParameters: limits.ignoreQueryParameters ?? false,
        sitemapMode,
      },
      counters: {
        nextIndex,
        attemptedPages,
        fetched,
        contentTruncated,
        limitReached,
        discoveryLimitReached,
        sitemapCandidates,
      },
      seen: [...seen],
      sources: [...sourcesByUrl.entries()]
        .map(([url, sources]) => ({ url, sources: pageSourcesInOrder(sources) }))
        .sort((left, right) => left.url.localeCompare(right.url)),
      pages: [...pages],
      failures: [...failures],
      warnings: [...warnings],
      frontier: [...frontier],
      depth,
      ...(activeLayer
        ? {
            active_layer: {
              depth: activeLayer.depth,
              urls: [...activeLayer.urls],
              indexes: [...activeLayer.indexes],
              completed: [...activeLayer.completed].sort(),
              discovered: [...activeLayer.discovered].sort(),
            } satisfies CrawlCheckpointActiveLayer,
          }
        : {}),
      ...(lastError ? { last_error: lastError } : {}),
    };
    const write = checkpointChain.then(() => limits.onCheckpoint?.(snapshot));
    checkpointChain = write.catch(() => undefined);
    return write;
  };

  const recordSource = (url: string, source: CrawlPageSource): void => {
    let sources = sourcesByUrl.get(url);
    if (!sources) {
      sources = new Set<CrawlPageSource>();
      sourcesByUrl.set(url, sources);
    }
    sources.add(source);
  };

  const fetchPage = async (url: string, depth: number, index: number): Promise<PageOutcome> => {
    let page: CrawlPage;
    let links: string[];
    try {
      const response = await client.fetch({ url }, crawlSignal);
      const hash = contentHashFor(client, url, response);
      const previousHash = limits.baseline?.hashes.get(url);
      const changeStatus = limits.baseline
        ? previousHash === undefined
          ? "added"
          : previousHash === hash
            ? "unchanged"
            : "modified"
        : undefined;
      const retrievedFrom = fetchSourceFor(client, url);
      const bounded = boundFetchOutput({ ...response, url }, limits.pageContentLimit);
      page = {
        index,
        url,
        title: bounded.title,
        depth,
        content: bounded.content,
        content_hash: hash,
        ...(changeStatus ? { change_status: changeStatus } : {}),
        ...(previousHash ? { previous_content_hash: previousHash } : {}),
        ...(retrievedFrom ? { retrievedFrom } : {}),
        sources: pageSourcesInOrder(sourcesByUrl.get(url) ?? new Set<CrawlPageSource>()),
        content_truncated: bounded.truncated ?? false,
        content_original_length: bounded.original_length ?? codepointLength(bounded.content),
      };
      links =
        depth < limits.maxDepth
          ? extractMarkdownLinks(bounded.content, new URL(url))
              .map((candidate) =>
                canonicalizeCrawlUrl(candidate, undefined, limits.ignoreQueryParameters),
              )
              .filter(
                (candidate): candidate is URL =>
                  candidate !== undefined && sameOrigin(candidate, seed) && pathFilter(candidate),
              )
              .map((candidate) => candidate.href)
          : [];
    } catch (error) {
      if (crawlSignal.aborted) {
        throw error;
      }
      return { url, summary: null, links: [], error };
    }
    const summary = summaryFor(page);
    if (onPage && (page.change_status !== "unchanged" || !limits.changedOnly)) {
      try {
        await onPage(page);
      } catch (error) {
        crawlController.abort(error);
        throw error;
      }
    }
    return { url, summary, links, error: null };
  };

  await checkpoint("running");
  const needsSeed = !resume || !pages.some((page) => page.url === seed.href && page.depth === 0);
  if (needsSeed) {
    try {
      const seedOutcome = await fetchPage(seed.href, 0, nextIndex);
      nextIndex += 1;
      if (!seedOutcome.summary) {
        throw seedOutcome.error;
      }
      fetched += 1;
      contentTruncated += seedOutcome.summary.content_truncated ? 1 : 0;
      pages.push(seedOutcome.summary);

      const seedLinks = createBoundedLinkCollector(
        Math.max(0, limits.discoveryLimit - seen.size),
        seen,
      );
      if (sitemapMode !== "only") {
        for (const link of seedOutcome.links) {
          recordSource(link, "markdown");
          seedLinks.add(link);
        }
      }
      if (sitemapMode !== "skip" && limits.maxDepth > 0) {
        try {
          const discovery = await limits.sitemapReader?.read(
            seed,
            { maxDocuments: 10, maxCandidates: limits.discoveryLimit },
            crawlSignal,
          );
          if (discovery) {
            warnings.push(...discovery.warnings);
            discoveryLimitReached = discoveryLimitReached || discovery.truncated;
            const candidates = discovery.urls
              .map((url) => canonicalizeCrawlUrl(url, undefined, limits.ignoreQueryParameters))
              .filter(
                (url): url is URL => url !== undefined && sameOrigin(url, seed) && pathFilter(url),
              );
            sitemapCandidates = new Set(candidates.map((url) => url.href)).size;
            for (const url of candidates) {
              recordSource(url.href, "sitemap");
              seedLinks.add(url.href);
            }
          }
        } catch (error) {
          if (crawlSignal.aborted) {
            throw error;
          }
          warnings.push({
            code: "sitemap_unavailable",
            message: `Could not read Sitemap: ${errorMessage(error)}`,
          });
        }
      }
      seedOutcome.links = [];
      const seedCollection = seedLinks.finish();
      discoveryLimitReached = discoveryLimitReached || seedCollection.truncated;
      frontier = seedCollection.links;
      await checkpoint("running");
    } catch (error) {
      await checkpoint("interrupted", errorMessage(error)).catch(() => undefined);
      throw error;
    }
  }
  while (
    activeLayer !== undefined ||
    (frontier.length > 0 && depth <= limits.maxDepth && attemptedPages < limits.maxPages)
  ) {
    let layerDepth: number;
    let selected: string[];
    let selectedIndexes: number[];
    let layerLinks: BoundedLinkCollector;

    if (activeLayer) {
      layerDepth = activeLayer.depth;
      const remaining = activeLayer.urls
        .map((url, index) => ({ url, index: activeLayer?.indexes[index] ?? 0 }))
        .filter((request) => !activeLayer?.completed.has(request.url));
      selected = remaining.map((request) => request.url);
      selectedIndexes = remaining.map((request) => request.index);
      depth = layerDepth;
      layerLinks = createBoundedLinkCollector(Math.max(0, limits.discoveryLimit - seen.size), seen);
      for (const link of activeLayer.discovered) {
        layerLinks.add(link);
      }
    } else {
      layerDepth = depth;
      const sorted = [...frontier].sort();
      const remaining = limits.maxPages - attemptedPages;
      selected = sorted.slice(0, remaining);
      if (selected.length < sorted.length) {
        limitReached = true;
      }
      attemptedPages += selected.length;
      selectedIndexes = selected.map(() => {
        const index = nextIndex;
        nextIndex += 1;
        return index;
      });
      layerLinks = createBoundedLinkCollector(Math.max(0, limits.discoveryLimit - seen.size), seen);
      activeLayer = {
        depth: layerDepth,
        urls: [...selected],
        indexes: [...selectedIndexes],
        completed: new Set<string>(),
        discovered: [],
      };
      await checkpoint("running");
    }

    if (selected.length > 0) {
      try {
        await runLayeredTasks<string, PageOutcome>(selected, {
          concurrency: limits.concurrency,
          delayMs: limits.delayMs,
          signal: crawlSignal,
          immediate: async (url) => prepareCachedFetch(client, { url }),
          run: async (url, index) => {
            const outcome = await fetchPage(url, layerDepth, selectedIndexes[index] ?? 0);
            if (outcome.summary) {
              fetched += 1;
              contentTruncated += outcome.summary.content_truncated ? 1 : 0;
              pages.push(outcome.summary);
            } else {
              failures.push({
                url: outcome.url,
                index: selectedIndexes[index] ?? 0,
                depth: layerDepth,
                sources: pageSourcesInOrder(
                  sourcesByUrl.get(outcome.url) ?? new Set<CrawlPageSource>(),
                ),
                kind: errorKind(outcome.error),
                message: errorMessage(outcome.error),
              });
            }
            for (const link of outcome.links) {
              recordSource(link, "markdown");
              layerLinks.add(link);
            }
            activeLayer?.completed.add(url);
            if (activeLayer) {
              activeLayer.discovered = layerLinks.values();
            }
            await checkpoint("running");
            return { ...outcome, links: [] };
          },
        });
      } catch (error) {
        await checkpoint("interrupted", errorMessage(error)).catch(() => undefined);
        throw error;
      }
    }

    const collected = layerLinks.finish();
    discoveryLimitReached = discoveryLimitReached || collected.truncated;
    frontier = collected.links;
    depth = layerDepth + 1;
    activeLayer = undefined;
    await checkpoint("running");
  }

  if (attemptedPages >= limits.maxPages && frontier.length > 0) {
    limitReached = true;
  }

  pages.sort((left, right) => left.index - right.index);
  failures.sort((left, right) => left.depth - right.depth || left.url.localeCompare(right.url));

  const cacheStats = cacheStatsFor(client);
  const changes = limits.baseline ? compareCrawlBaseline(pages, seen, limits.baseline) : undefined;
  const result: CrawlRunResult = {
    version: 1,
    seed_url: seed.href,
    started_at: startedAt,
    finished_at: now().toISOString(),
    settings: {
      max_depth: limits.maxDepth,
      max_pages: limits.maxPages,
      concurrency: limits.concurrency,
      delay_ms: limits.delayMs,
      ...(options.sitemapMode === undefined ? {} : { sitemap_mode: sitemapMode }),
    },
    stats: {
      discovered: seen.size,
      fetched,
      failed: failures.length,
      content_truncated: contentTruncated,
      limit_reached: limitReached,
      discovery_limit_reached: discoveryLimitReached,
      ...(cacheStats
        ? {
            cache_hits: cacheStats.hits,
            cache_misses: cacheStats.misses,
            cache_errors: cacheStats.errors,
          }
        : {}),
      ...(changes
        ? {
            added: changes.added.length,
            modified: changes.modified.length,
            unchanged: changes.unchanged.length,
            removed: changes.removed.length,
          }
        : {}),
      ...(options.sitemapMode === undefined ? {} : { sitemap_candidates: sitemapCandidates }),
    },
    pages,
    failures,
    warnings,
    ...(limits.baseline ? { baseline: { source: limits.baseline.source } } : {}),
    ...(changes ? { changes } : {}),
  };
  await checkpoint("completed");
  return result;
}
