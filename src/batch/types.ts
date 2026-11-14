import type { RetryAttempt, RetrySummary } from "../retry/types.js";
import type { FetchRetrievalSource } from "../types.js";

export interface BatchFetchOptions {
  concurrency: number;
  delayMs: number;
  maxChars: number;
  now?: () => Date;
}

export interface BatchFetchPreparedRequest {
  index: number;
  url: string;
}

export interface BatchFetchPreparation {
  input: number;
  requests: BatchFetchPreparedRequest[];
  failures: BatchFetchFailure[];
}

export interface BatchFetchSettings {
  concurrency: number;
  delay_ms: number;
  max_chars: number;
}

export interface BatchFetchPage {
  index: number;
  url: string;
  title: string;
  content: string;
  contentHash: string;
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
  content_hash: string;
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
  settings: BatchFetchSettings;
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

export type BatchFetchJobStatus = "running" | "interrupted" | "completed";

export interface BatchFetchJobRequest {
  index: number;
  url: string;
}

export interface BatchFetchJobState {
  version: 1;
  status: BatchFetchJobStatus;
  source: string;
  output_dir: string;
  started_at: string;
  updated_at: string;
  input: number;
  settings: BatchFetchSettings;
  requests: BatchFetchJobRequest[];
  pages: BatchFetchPageSummary[];
  failures: BatchFetchFailure[];
  last_error?: string;
}
