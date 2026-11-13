export interface RetryAttempt {
  url: string;
  index?: number;
  kind: string;
  message: string;
}

export interface RetrySummary {
  source: string;
  original_source?: string;
  original_failures: number;
  attempted: number;
  deduplicated: number;
  skipped: RetryAttempt[];
  truncated: boolean;
}
