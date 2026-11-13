import type { RetryAttempt, RetrySummary } from "../retry/types.js";
import type { FetchRetrievalSource } from "../types.js";

export interface BatchFetchOptions {
  concurrency: number;
  delayMs: number;
  maxChars: number;
  now?: () => Date;
}

export interface BatchFetchPage {
  index: number;
  url: string;
  title: string;
  content: string;
  contentTruncated: boolean;
  contentOriginalLength: number;
  retrievedFrom?: FetchRetrievalSource;
  retryOf?: RetryAttempt;
}

export interface BatchFetchPageSummary {
  index: number;
  url: string;
  title: string;
  content_length: number;
  content_truncated: boolean;
  content_original_length?: number;
  retrieved_from?: FetchRetrievalSource;
  retry_of?: RetryAttempt;
}

export interface BatchFetchPageIndex extends BatchFetchPageSummary {
  path: string;
}

export interface BatchFetchFailure {
  url: string;
  index?: number;
  kind: string;
  message: string;
  retry_of?: RetryAttempt;
}

export interface BatchFetchResult extends Record<string, unknown> {
  version: 1;
  source: string;
  started_at: string;
  finished_at: string;
  settings: {
    concurrency: number;
    delay_ms: number;
    max_chars: number;
  };
  stats: {
    input: number;
    unique: number;
    fetched: number;
    failed: number;
    cache_hits?: number;
    cache_misses?: number;
    cache_errors?: number;
  };
  pages: BatchFetchPageSummary[];
  failures: BatchFetchFailure[];
  retry_of?: RetrySummary;
}

export interface BatchFetchOutputResult extends BatchFetchResult {
  pages: BatchFetchPageIndex[];
}
