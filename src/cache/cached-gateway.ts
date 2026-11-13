import { normalizeHttpUrl } from "../crawl/links.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import type { FetchInput, FetchRetrievalSource, RawFetchResponse } from "../types.js";
import type { FetchCache } from "./types.js";

export interface FetchCacheStats {
  hits: number;
  misses: number;
  errors: number;
}

export function fetchSourceFor(
  gateway: DeepSeekGateway,
  url: string,
): FetchRetrievalSource | undefined {
  return gateway instanceof CachedFetchGateway ? gateway.sourceFor(url) : undefined;
}

export function cacheStatsFor(gateway: DeepSeekGateway): FetchCacheStats | undefined {
  return gateway instanceof CachedFetchGateway ? gateway.stats() : undefined;
}

export interface CachedFetchGatewayOptions {
  ttlMs: number;
  fresh: boolean;
  now?: () => Date;
}

function canonicalUrl(value: string): string | undefined {
  return normalizeHttpUrl(value)?.href;
}

export class CachedFetchGateway implements DeepSeekGateway {
  readonly #gateway: DeepSeekGateway;
  readonly #cache: FetchCache;
  readonly #ttlMs: number;
  readonly #fresh: boolean;
  readonly #now: () => Date;
  readonly #sources = new Map<string, FetchRetrievalSource>();
  #hits = 0;
  #misses = 0;
  #errors = 0;

  constructor(gateway: DeepSeekGateway, cache: FetchCache, options: CachedFetchGatewayOptions) {
    this.#gateway = gateway;
    this.#cache = cache;
    this.#ttlMs = options.ttlMs;
    this.#fresh = options.fresh;
    this.#now = options.now ?? (() => new Date());
  }

  search(...args: Parameters<DeepSeekGateway["search"]>) {
    return this.#gateway.search(...args);
  }

  async fetch(input: FetchInput, signal?: AbortSignal): Promise<RawFetchResponse> {
    const url = canonicalUrl(input.url);
    if (!url) {
      return this.#gateway.fetch(input, signal);
    }
    if (!this.#fresh) {
      try {
        const entry = await this.#cache.read(url);
        const fetchedAt = entry ? Date.parse(entry.fetched_at) : Number.NaN;
        const age = this.#now().getTime() - fetchedAt;
        if (entry && Number.isFinite(fetchedAt) && age >= 0 && age <= this.#ttlMs) {
          this.#hits += 1;
          this.#sources.set(url, "cache");
          return entry.response;
        }
      } catch {
        this.#errors += 1;
      }
    }

    this.#misses += 1;
    const response = await this.#gateway.fetch(input, signal);
    this.#sources.set(url, "api");
    try {
      await this.#cache.write(url, response, this.#now().toISOString());
    } catch {
      this.#errors += 1;
    }
    return response;
  }

  sourceFor(url: string): FetchRetrievalSource | undefined {
    const canonical = canonicalUrl(url);
    return canonical ? this.#sources.get(canonical) : undefined;
  }

  stats(): FetchCacheStats {
    return { hits: this.#hits, misses: this.#misses, errors: this.#errors };
  }
}
