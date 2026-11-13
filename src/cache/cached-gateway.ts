import { contentHash } from "../content/hash.js";
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

export async function prepareCachedFetch(
  gateway: DeepSeekGateway,
  input: FetchInput,
): Promise<boolean> {
  return gateway instanceof CachedFetchGateway ? gateway.prepare(input) : false;
}

export function contentHashFor(
  gateway: DeepSeekGateway,
  url: string,
  response: RawFetchResponse,
): string {
  return gateway instanceof CachedFetchGateway
    ? (gateway.hashFor(url) ?? contentHash(response.content))
    : contentHash(response.content);
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
  readonly #prefetched = new Map<string, RawFetchResponse>();
  readonly #checkedMisses = new Set<string>();
  readonly #hashes = new Map<string, string>();
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

  async prepare(input: FetchInput): Promise<boolean> {
    const url = canonicalUrl(input.url);
    if (!url || this.#fresh) {
      return false;
    }
    if (this.#prefetched.has(url)) {
      return true;
    }
    if (this.#checkedMisses.has(url)) {
      return false;
    }
    try {
      const entry = await this.#cache.read(url);
      const fetchedAt = entry ? Date.parse(entry.fetched_at) : Number.NaN;
      const age = this.#now().getTime() - fetchedAt;
      if (entry && Number.isFinite(fetchedAt) && age >= 0 && age <= this.#ttlMs) {
        this.#hits += 1;
        this.#sources.set(url, "cache");
        this.#prefetched.set(url, entry.response);
        this.#hashes.set(url, entry.content_hash);
        return true;
      }
    } catch {
      this.#errors += 1;
    }
    this.#checkedMisses.add(url);
    return false;
  }

  async fetch(input: FetchInput, signal?: AbortSignal): Promise<RawFetchResponse> {
    const url = canonicalUrl(input.url);
    if (!url) {
      return this.#gateway.fetch(input, signal);
    }
    if (this.#prefetched.has(url)) {
      const response = this.#prefetched.get(url) as RawFetchResponse;
      this.#prefetched.delete(url);
      return response;
    }
    if (!this.#fresh && !this.#checkedMisses.has(url) && (await this.prepare(input))) {
      return this.fetch(input, signal);
    }

    this.#misses += 1;
    const response = await this.#gateway.fetch(input, signal);
    const hash = contentHash(response.content);
    this.#sources.set(url, "api");
    this.#hashes.set(url, hash);
    try {
      await this.#cache.write(url, response, this.#now().toISOString(), hash);
    } catch {
      this.#errors += 1;
    }
    this.#checkedMisses.delete(url);
    return response;
  }

  sourceFor(url: string): FetchRetrievalSource | undefined {
    const canonical = canonicalUrl(url);
    return canonical ? this.#sources.get(canonical) : undefined;
  }

  hashFor(url: string): string | undefined {
    const canonical = canonicalUrl(url);
    return canonical ? this.#hashes.get(canonical) : undefined;
  }

  stats(): FetchCacheStats {
    return { hits: this.#hits, misses: this.#misses, errors: this.#errors };
  }
}
