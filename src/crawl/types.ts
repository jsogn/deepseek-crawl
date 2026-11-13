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
  content_truncated: boolean;
  content_original_length: number;
}

export interface CrawlPageSummary {
  index: number;
  url: string;
  title: string;
  depth: number;
  content_length: number;
  content_truncated: boolean;
  content_original_length?: number;
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
