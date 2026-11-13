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

export interface CrawlSitemapReader {
  read(
    seedUrl: URL,
    options: { maxDocuments: number; maxCandidates: number },
    signal?: AbortSignal,
  ): Promise<{
    urls: URL[];
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
  now?: () => Date;
}

export interface CrawlPage {
  index: number;
  url: string;
  title: string;
  depth: number;
  content: string;
  sources: CrawlPageSource[];
  content_truncated: boolean;
  content_original_length: number;
}

export interface CrawlPageSummary {
  index: number;
  url: string;
  title: string;
  depth: number;
  sources: CrawlPageSource[];
  content_length: number;
  content_truncated: boolean;
  content_original_length?: number;
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
  content_truncated: boolean;
  content_original_length?: number;
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
  };
  diagnostics_truncated: boolean;
  warnings: MapWarning[];
}

export interface CrawlPageIndex extends CrawlPageSummary {
  path: string;
}

export interface CrawlFailure {
  url: string;
  depth: number;
  kind: string;
  message: string;
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
  };
  pages: CrawlPageSummary[];
  failures: CrawlFailure[];
  warnings: MapWarning[];
}

export interface CrawlOutputResult extends Omit<CrawlRunResult, "pages"> {
  pages: CrawlPageIndex[];
}
