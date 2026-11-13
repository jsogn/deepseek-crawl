import type { RawFetchResponse } from "../types.js";

export interface FetchCacheEntry {
  version: 1;
  url: string;
  fetched_at: string;
  content_hash: string;
  response: RawFetchResponse;
}

export interface FetchCache {
  readonly location: string;
  read(url: string): Promise<FetchCacheEntry | null>;
  write(
    url: string,
    response: RawFetchResponse,
    fetchedAt: string,
    contentHash?: string,
  ): Promise<void>;
  clear(): Promise<void>;
}
