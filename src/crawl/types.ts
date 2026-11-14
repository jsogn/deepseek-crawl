import type { RetryAttempt, RetrySummary } from "../retry/types.js";
import type { FetchRetrievalSource } from "../types.js";

export type MapWarningCode =
  | "sitemap_unavailable"
  | "sitemap_invalid"
  | "sitemap_limit_reached"
  | "seed_page_failed";

export interface MapWarning {
  code: MapWarningCode;
  message: string;
}

export type MapUrlSource = "seed_url" | "seed_page" | "sitemap";

export type CrawlSitemapMode = "include" | "only" | "skip";

export type CrawlUrlSource = "markdown" | "sitemap";
export type CrawlPageSource = "seed_url" | CrawlUrlSource;
export type CrawlChangeStatus = "added" | "modified" | "unchanged";
export type CrawlJobStatus = "running" | "interrupted" | "completed";

export interface CrawlSitemapEntry {
  url: URL;
  lastmod?: string;
}

export interface CrawlSitemapReader {
  read(
    seedUrl: URL,
    options: { maxDocuments: number; maxCandidates: number },
    signal?: AbortSignal,
  ): Promise<{
    urls: URL[];
    entries?: CrawlSitemapEntry[];
    warnings: MapWarning[];
    truncated: boolean;
  }>;
}

export interface MapUrl {
  url: string;
  sources: MapUrlSource[];
}

export interface MapResult extends Record<string, unknown> {
  version: 1;
  seed_url: string;
  generated_at: string;
  limit: number;
  total: number;
  truncated: boolean;
  urls: MapUrl[];
  warnings: MapWarning[];
  search?: string;
}

export interface CrawlInput {
  url: string;
}

export interface CrawlOptions {
  maxDepth: number;
  maxPages: number;
  concurrency: number;
  delayMs: number;
  discoveryLimit: number;
  pageContentLimit: number;
  includePaths?: string[];
  excludePaths?: string[];
  ignoreQueryParameters?: boolean;
  sitemapMode?: CrawlSitemapMode;
  sitemapReader?: CrawlSitemapReader;
  baseline?: CrawlBaseline;
  changedOnly?: boolean;
  resume?: CrawlCheckpointState;
  onCheckpoint?: (state: CrawlCheckpointState) => Promise<void>;
  now?: () => Date;
}

export interface CrawlBaseline {
  source: string;
  hashes: ReadonlyMap<string, string>;
  pages?: ReadonlyMap<string, CrawlBaselinePage>;
}

export interface CrawlBaselinePage {
  url: string;
  title: string;
  depth: number;
  sources: CrawlPageSource[];
  content_length: number;
  content_hash: string;
  content_truncated: boolean;
  content_original_length?: number;
  sitemap_lastmod?: string;
}

export interface CrawlCheckpointOptions {
  maxDepth: number;
  maxPages: number;
  concurrency: number;
  delayMs: number;
  includePaths: string[];
  excludePaths: string[];
  ignoreQueryParameters: boolean;
  sitemapMode: CrawlSitemapMode;
}

export interface CrawlCheckpointCounters {
  nextIndex: number;
  attemptedPages: number;
  fetched: number;
  contentTruncated: number;
  limitReached: boolean;
  discoveryLimitReached: boolean;
  sitemapCandidates: number;
  sitemapLastmodSkipped?: number;
}

export interface CrawlCheckpointSource {
  url: string;
  sources: CrawlPageSource[];
}

export interface CrawlCheckpointActiveLayer {
  depth: number;
  urls: string[];
  indexes: number[];
  completed: string[];
  discovered: string[];
}

export interface CrawlCheckpointState {
  version: 1;
  status: CrawlJobStatus;
  seed_url: string;
  started_at: string;
  updated_at: string;
  options: CrawlCheckpointOptions;
  counters: CrawlCheckpointCounters;
  seen: string[];
  sources: CrawlCheckpointSource[];
  pages: CrawlPageSummary[];
  failures: CrawlFailure[];
  warnings: MapWarning[];
  frontier: string[];
  depth: number;
  active_layer?: CrawlCheckpointActiveLayer;
  last_error?: string;
}

export interface CrawlPage {
  index: number;
  url: string;
  title: string;
  depth: number;
  content: string;
  content_hash: string;
  change_status?: CrawlChangeStatus;
  previous_content_hash?: string;
  retrievedFrom?: FetchRetrievalSource;
  sources: CrawlPageSource[];
  content_truncated: boolean;
  content_original_length: number;
  sitemapLastmod?: string;
  retryOf?: RetryAttempt;
}

export interface CrawlPageSummary {
  index: number;
  url: string;
  title: string;
  depth: number;
  sources: CrawlPageSource[];
  content_length: number;
  content_hash: string;
  change_status?: CrawlChangeStatus;
  previous_content_hash?: string;
  content_truncated: boolean;
  content_original_length?: number;
  sitemap_lastmod?: string;
  retrieved_from?: FetchRetrievalSource;
  retry_of?: RetryAttempt;
}

export interface CrawlPlanUrl {
  url: string;
  sources: CrawlUrlSource[];
}

export type CrawlPlanOmissionReason =
  | "page_limit"
  | "discovery_limit"
  | "cross_origin"
  | "path_filtered";

export interface CrawlPlanOmittedUrl extends CrawlPlanUrl {
  reason: CrawlPlanOmissionReason;
}

export interface CrawlPlanSeed {
  url: string;
  title: string;
  depth: 0;
  content_length: number;
  content_hash: string;
  content_truncated: boolean;
  content_original_length?: number;
  retrieved_from?: FetchRetrievalSource;
}

export interface CrawlPlanResult {
  version: 1;
  seed_url: string;
  generated_at: string;
  settings: CrawlRunResult["settings"];
  seed: CrawlPlanSeed;
  urls: CrawlPlanUrl[];
  deferred: CrawlPlanOmittedUrl[];
  filtered: CrawlPlanOmittedUrl[];
  stats: {
    candidates: number;
    eligible: number;
    selected: number;
    deferred: number;
    filtered: number;
    planned_pages: number;
    page_limit_reached: boolean;
    discovery_limit_reached: boolean;
    sitemap_candidates?: number;
    cache_hits?: number;
    cache_misses?: number;
    cache_errors?: number;
  };
  diagnostics_truncated: boolean;
  warnings: MapWarning[];
}

export interface CrawlPageIndex extends CrawlPageSummary {
  written: boolean;
  path?: string;
}

export interface CrawlFailure {
  url: string;
  index?: number;
  depth: number;
  sources?: CrawlPageSource[];
  kind: string;
  message: string;
  retry_of?: RetryAttempt;
}

export interface CrawlRunResult {
  version: 1;
  seed_url: string;
  started_at: string;
  finished_at: string;
  settings: {
    max_depth: number;
    max_pages: number;
    concurrency: number;
    delay_ms: number;
    sitemap_mode?: CrawlSitemapMode;
  };
  stats: {
    discovered: number;
    fetched: number;
    failed: number;
    content_truncated: number;
    limit_reached: boolean;
    discovery_limit_reached: boolean;
    sitemap_candidates?: number;
    sitemap_lastmod_skipped?: number;
    cache_hits?: number;
    cache_misses?: number;
    cache_errors?: number;
    added?: number;
    modified?: number;
    unchanged?: number;
    removed?: number;
  };
  pages: CrawlPageSummary[];
  failures: CrawlFailure[];
  warnings: MapWarning[];
  retry_of?: RetrySummary;
  baseline?: {
    source: string;
  };
  changes?: CrawlChanges;
  monitor?: CrawlMonitorInfo;
}

export interface CrawlContentVersion {
  url: string;
  content_hash: string;
}

export interface CrawlModifiedContent extends CrawlContentVersion {
  previous_content_hash: string;
}

export interface CrawlChanges {
  added: CrawlContentVersion[];
  modified: CrawlModifiedContent[];
  unchanged: CrawlContentVersion[];
  removed: CrawlContentVersion[];
}

export interface CrawlMonitorState {
  version: 1;
  seed_url: string;
  options: CrawlCheckpointOptions;
  baseline: CrawlMonitorBaselineEntry[];
  last_run_at: string;
  last_run_id: string;
  last_output: string;
  last_changes: CrawlChanges;
  last_has_changes: boolean;
}

export interface CrawlMonitorBaselineEntry extends CrawlContentVersion {
  title?: string;
  depth?: number;
  sources?: CrawlPageSource[];
  content_length?: number;
  content_truncated?: boolean;
  content_original_length?: number;
  sitemap_lastmod?: string;
}

export interface CrawlMonitorInfo {
  first_run: boolean;
  run_id: string;
  state_dir: string;
  has_changes: boolean;
  triggered: boolean;
  fail_on_change: boolean;
  only_modified: boolean;
  ignore_removed: boolean;
}

export interface CrawlOutputResult extends Omit<CrawlRunResult, "pages"> {
  pages: CrawlPageIndex[];
}
