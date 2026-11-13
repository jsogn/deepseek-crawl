import { normalizeHttpUrl, sameOrigin, visitMarkdownLinks } from "../crawl/links.js";
import type { MapResult, MapUrl, MapUrlSource, MapWarning } from "../crawl/types.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import { fetchInputSchema } from "../deepseek/schemas.js";
import { boundFetchOutput } from "../output/bounds.js";
import type { SitemapDiscovery, SitemapReadOptions } from "../sitemap/reader.js";

const HARD_MAP_LIMIT = 1_000;
const HARD_DISCOVERY_LIMIT = 10_000;
const HARD_PAGE_CONTENT_LIMIT = 1_000_000;
const SITEMAP_DOCUMENT_LIMIT = 10;

export interface MapSitemapReader {
  read(seedUrl: URL, options: SitemapReadOptions, signal?: AbortSignal): Promise<SitemapDiscovery>;
}

export interface MapOptions {
  limit: number;
  discoveryLimit: number;
  pageContentLimit?: number;
  search?: string;
  now?: () => Date;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Map request cancelled.");
}

function validateLimit(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Math.min(value, maximum);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sourcesInOrder(sources: Set<MapUrlSource>): MapUrlSource[] {
  const order: MapUrlSource[] = ["seed_url", "seed_page", "sitemap"];
  return order.filter((source) => sources.has(source));
}

function selectCandidates(
  candidates: Map<string, Set<MapUrlSource>>,
  seedHref: string,
  limit: number,
  search?: string,
): MapUrl[] {
  if (search !== undefined) {
    const matches = [...candidates.keys()]
      .filter((url) => url.toLowerCase().includes(search.toLowerCase()))
      .sort(compareCodeUnits)
      .slice(0, limit);
    return matches.map((url) => ({
      url,
      sources: sourcesInOrder(candidates.get(url) ?? new Set<MapUrlSource>()),
    }));
  }

  const seedSources = candidates.get(seedHref);
  if (!seedSources) {
    throw new Error("Map seed URL was not retained.");
  }

  const remaining = [...candidates.keys()]
    .filter((url) => url !== seedHref)
    .sort(compareCodeUnits)
    .slice(0, limit - 1);
  const selected = [seedHref, ...remaining];
  selected.sort(compareCodeUnits);

  return selected.map((url) => ({
    url,
    sources: sourcesInOrder(candidates.get(url) ?? new Set<MapUrlSource>()),
  }));
}

interface CandidateCollector {
  add(url: URL, source: MapUrlSource): void;
  finish(): { candidates: Map<string, Set<MapUrlSource>>; truncated: boolean };
}

function createCandidateCollector(seed: URL, capacity: number): CandidateCollector {
  const candidates = new Map<string, Set<MapUrlSource>>([
    [seed.href, new Set<MapUrlSource>(["seed_url"])],
  ]);
  const nonSeedCapacity = Math.max(0, capacity - 1);
  let truncated = false;

  const trim = (): void => {
    if (candidates.size <= capacity) {
      return;
    }
    const retained = [...candidates.keys()]
      .filter((url) => url !== seed.href)
      .sort(compareCodeUnits)
      .slice(0, nonSeedCapacity);
    const retainedSet = new Set(retained);
    for (const url of candidates.keys()) {
      if (url !== seed.href && !retainedSet.has(url)) {
        candidates.delete(url);
      }
    }
    truncated = true;
  };

  return {
    add(url: URL, source: MapUrlSource): void {
      const normalized = normalizeHttpUrl(url.href);
      if (!normalized) {
        return;
      }
      if (normalized.href === seed.href) {
        candidates.get(seed.href)?.add(source);
        return;
      }
      const sources = candidates.get(normalized.href);
      if (sources) {
        sources.add(source);
        return;
      }
      if (nonSeedCapacity === 0) {
        truncated = true;
        return;
      }
      candidates.set(normalized.href, new Set<MapUrlSource>([source]));
      if (candidates.size >= capacity * 2) {
        trim();
      }
    },
    finish() {
      trim();
      return { candidates, truncated };
    },
  };
}

export async function executeMap(
  client: DeepSeekGateway,
  reader: MapSitemapReader,
  input: unknown,
  options: MapOptions,
  signal?: AbortSignal,
): Promise<MapResult> {
  const parsed = fetchInputSchema.parse(input);
  const seed = normalizeHttpUrl(parsed.url);
  if (!seed) {
    throw new Error("Map URL must be an HTTP(S) URL with a host and no credentials.");
  }

  const limit = validateLimit(options.limit, "Map limit", HARD_MAP_LIMIT);
  const discoveryLimit = validateLimit(
    options.discoveryLimit,
    "Map discovery limit",
    HARD_DISCOVERY_LIMIT,
  );
  const pageContentLimit =
    options.pageContentLimit === undefined
      ? HARD_PAGE_CONTENT_LIMIT
      : validateLimit(options.pageContentLimit, "Map page content limit", HARD_PAGE_CONTENT_LIMIT);
  const search = options.search?.trim();
  if (options.search !== undefined && !search) {
    throw new Error("Map search must contain non-whitespace text.");
  }

  const [sitemapResult, seedPageResult] = await Promise.allSettled([
    reader.read(
      seed,
      { maxDocuments: SITEMAP_DOCUMENT_LIMIT, maxCandidates: discoveryLimit },
      signal,
    ),
    client.fetch({ url: seed.href }, signal),
  ]);
  if (signal?.aborted) {
    throw abortReason(signal);
  }

  const sitemapReadable =
    sitemapResult.status === "fulfilled" &&
    (sitemapResult.value.urls.length > 0 || sitemapResult.value.warnings.length === 0);
  const seedReadable = seedPageResult.status === "fulfilled";
  if (!sitemapReadable && !seedReadable) {
    const sitemapDiagnostic =
      sitemapResult.status === "rejected"
        ? errorMessage(sitemapResult.reason)
        : sitemapResult.value.warnings.map((warning) => warning.message).join("; ") ||
          "no usable Sitemap URLs";
    const seedDiagnostic =
      seedPageResult.status === "rejected"
        ? errorMessage(seedPageResult.reason)
        : "no usable seed page";
    throw new Error(
      `Map could not read either the Sitemap or the seed page. ` +
        `Sitemap: ${sitemapDiagnostic}. ` +
        `Seed page: ${seedDiagnostic}.`,
    );
  }

  const candidateCollector = createCandidateCollector(seed, discoveryLimit);
  const warnings: MapWarning[] = [];
  let truncated = sitemapResult.status === "fulfilled" ? sitemapResult.value.truncated : false;

  if (sitemapResult.status === "fulfilled") {
    warnings.push(...sitemapResult.value.warnings);
    for (const url of sitemapResult.value.urls) {
      if (sameOrigin(url, seed)) {
        candidateCollector.add(url, "sitemap");
      }
    }
  } else {
    warnings.push({
      code: "sitemap_unavailable",
      message: `Could not read Sitemap: ${errorMessage(sitemapResult.reason)}`,
    });
  }

  if (seedPageResult.status === "fulfilled") {
    const bounded = boundFetchOutput({ ...seedPageResult.value, url: seed.href }, pageContentLimit);
    visitMarkdownLinks(
      bounded.content,
      seed,
      (url) => {
        if (sameOrigin(url, seed)) {
          candidateCollector.add(url, "seed_page");
        }
      },
      { dedupe: false },
    );
  } else {
    warnings.push({
      code: "seed_page_failed",
      message: `Could not read seed page: ${errorMessage(seedPageResult.reason)}`,
    });
  }

  const collected = candidateCollector.finish();
  const candidates = collected.candidates;
  truncated = truncated || collected.truncated;
  const matchedCount =
    search === undefined
      ? candidates.size
      : [...candidates.keys()].filter((url) => url.toLowerCase().includes(search.toLowerCase()))
          .length;
  if (matchedCount > limit) {
    truncated = true;
  }

  const urls = selectCandidates(candidates, seed.href, limit, search);

  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  return {
    version: 1,
    seed_url: seed.href,
    generated_at: generatedAt,
    limit,
    total: urls.length,
    truncated,
    urls,
    warnings,
    ...(search === undefined ? {} : { search }),
  };
}
