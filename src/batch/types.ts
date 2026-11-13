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
}

export interface BatchFetchPageSummary {
  index: number;
  url: string;
  title: string;
  content_length: number;
  content_truncated: boolean;
  content_original_length?: number;
}

export interface BatchFetchPageIndex extends BatchFetchPageSummary {
  path: string;
}

export interface BatchFetchFailure {
  url: string;
  kind: string;
  message: string;
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
  };
  pages: BatchFetchPageSummary[];
  failures: BatchFetchFailure[];
}

export interface BatchFetchOutputResult extends Omit<BatchFetchResult, "pages"> {
  pages: BatchFetchPageIndex[];
}
