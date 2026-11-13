import { canonicalizeCrawlUrl, createCrawlPathFilter } from "../crawl/filters.js";
import { extractMarkdownLinks, sameOrigin } from "../crawl/links.js";
import type {
  CrawlOptions,
  CrawlPlanOmittedUrl,
  CrawlPlanResult,
  CrawlPlanUrl,
  CrawlRunResult,
  CrawlSitemapMode,
  CrawlUrlSource,
  MapWarning,
} from "../crawl/types.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import { fetchInputSchema } from "../deepseek/schemas.js";
import { boundFetchOutput } from "../output/bounds.js";
import { normalizeCrawlOptions } from "./crawl.js";

const PLAN_DIAGNOSTIC_LIMIT = 1_000;
const PLAN_SOURCE_ORDER: CrawlUrlSource[] = ["markdown", "sitemap"];

interface MutablePlanCandidate {
  url: URL;
  sources: Set<CrawlUrlSource>;
  reason?: "cross_origin" | "path_filtered";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codepointLength(value: string): number {
  return [...value].length;
}

function sourcesInOrder(sources: Set<CrawlUrlSource>): CrawlUrlSource[] {
  return PLAN_SOURCE_ORDER.filter((source) => sources.has(source));
}

function planUrl(candidate: MutablePlanCandidate): CrawlPlanUrl {
  return {
    url: candidate.url.href,
    sources: sourcesInOrder(candidate.sources),
  };
}

function filteredUrl(
  candidate: MutablePlanCandidate,
  reason: CrawlPlanOmittedUrl["reason"],
): CrawlPlanOmittedUrl {
  return { ...planUrl(candidate), reason };
}

function planSettings(
  options: CrawlOptions,
  limits: CrawlOptions,
  mode: CrawlSitemapMode,
): CrawlRunResult["settings"] {
  return {
    max_depth: limits.maxDepth,
    max_pages: limits.maxPages,
    concurrency: limits.concurrency,
    delay_ms: limits.delayMs,
    ...(options.sitemapMode === undefined ? {} : { sitemap_mode: mode }),
  };
}

export async function executeCrawlPlan(
  client: DeepSeekGateway,
  input: unknown,
  options: CrawlOptions,
  signal?: AbortSignal,
): Promise<CrawlPlanResult> {
  const limits = normalizeCrawlOptions(options);
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
  const planController = new AbortController();
  const planSignal = signal
    ? AbortSignal.any([signal, planController.signal])
    : planController.signal;
  planSignal.throwIfAborted();
  const warnings: MapWarning[] = [];
  const candidates = new Map<string, MutablePlanCandidate>();
  let sitemapCandidates = 0;
  let sitemapTruncated = false;

  const addCandidates = (urls: readonly URL[], source: CrawlUrlSource): void => {
    for (const value of urls) {
      const normalized = canonicalizeCrawlUrl(value, undefined, limits.ignoreQueryParameters);
      if (!normalized || normalized.href === seed.href) {
        continue;
      }
      let candidate = candidates.get(normalized.href);
      if (!candidate) {
        candidate = { url: normalized, sources: new Set<CrawlUrlSource>() };
        candidates.set(normalized.href, candidate);
      }
      candidate.sources.add(source);
      if (candidate.reason) {
        continue;
      }
      if (!sameOrigin(normalized, seed)) {
        candidate.reason = "cross_origin";
      } else if (!pathFilter(normalized)) {
        candidate.reason = "path_filtered";
      }
    }
  };

  const response = await client.fetch({ url: seed.href }, planSignal);
  const bounded = boundFetchOutput({ ...response, url: seed.href }, limits.pageContentLimit);
  if (limits.maxDepth > 0) {
    if (sitemapMode !== "only") {
      addCandidates(extractMarkdownLinks(bounded.content, seed), "markdown");
    }
    if (sitemapMode !== "skip") {
      try {
        const discovery = await limits.sitemapReader?.read(
          seed,
          { maxDocuments: 10, maxCandidates: limits.discoveryLimit },
          planSignal,
        );
        if (discovery) {
          warnings.push(...discovery.warnings);
          sitemapTruncated = discovery.truncated;
          const sitemapUrls = discovery.urls
            .map((url) => canonicalizeCrawlUrl(url, undefined, limits.ignoreQueryParameters))
            .filter((url): url is URL => url !== undefined);
          sitemapCandidates = new Set(
            sitemapUrls
              .filter((url) => url.href !== seed.href && sameOrigin(url, seed) && pathFilter(url))
              .map((url) => url.href),
          ).size;
          addCandidates(sitemapUrls, "sitemap");
        }
      } catch (error) {
        if (planSignal.aborted) {
          throw error;
        }
        warnings.push({
          code: "sitemap_unavailable",
          message: `Could not read Sitemap: ${errorMessage(error)}`,
        });
      }
    }
  }

  const allCandidates = [...candidates.values()];
  const eligible = allCandidates
    .filter((candidate) => candidate.reason === undefined)
    .sort((left, right) => left.url.href.localeCompare(right.url.href));
  const filtered = allCandidates
    .filter((candidate) => candidate.reason !== undefined)
    .sort((left, right) => left.url.href.localeCompare(right.url.href));

  const discoveryCapacity = Math.max(0, limits.discoveryLimit - 1);
  const pageCapacity = Math.max(0, limits.maxPages - 1);
  const withinDiscovery = eligible.slice(0, discoveryCapacity);
  const discoveryOmitted = eligible.slice(discoveryCapacity);
  const selected = withinDiscovery.slice(0, pageCapacity);
  const deferred = withinDiscovery.slice(pageCapacity);
  const discoveryLimitReached = sitemapTruncated || discoveryOmitted.length > 0;
  const selectedSet = new Set(selected);
  const deferredSet = new Set(deferred);
  const filteredUrlDetails = filtered
    .slice(0, PLAN_DIAGNOSTIC_LIMIT)
    .map((candidate) => filteredUrl(candidate, candidate.reason ?? "cross_origin"));
  const discoveryOmittedDetails = discoveryOmitted
    .slice(0, PLAN_DIAGNOSTIC_LIMIT)
    .map((candidate) => filteredUrl(candidate, "discovery_limit"));
  const filteredCount = filtered.length + discoveryOmitted.length;

  return {
    version: 1,
    seed_url: seed.href,
    generated_at: now().toISOString(),
    settings: planSettings(options, limits, sitemapMode),
    seed: {
      url: seed.href,
      title: bounded.title,
      depth: 0,
      content_length: codepointLength(bounded.content),
      content_truncated: bounded.truncated ?? false,
      ...(bounded.truncated
        ? { content_original_length: bounded.original_length ?? codepointLength(bounded.content) }
        : {}),
    },
    urls: selected.map(planUrl),
    deferred: deferred.map((candidate) => filteredUrl(candidate, "page_limit")),
    filtered: [...filteredUrlDetails, ...discoveryOmittedDetails],
    stats: {
      candidates: allCandidates.length,
      eligible: eligible.length,
      selected: selectedSet.size,
      deferred: deferredSet.size,
      filtered: filteredCount,
      planned_pages: selectedSet.size + 1,
      page_limit_reached: deferred.length > 0,
      discovery_limit_reached: discoveryLimitReached,
      ...(options.sitemapMode === undefined ? {} : { sitemap_candidates: sitemapCandidates }),
    },
    diagnostics_truncated:
      filtered.length > filteredUrlDetails.length ||
      discoveryOmitted.length > discoveryOmittedDetails.length,
    warnings,
  };
}
