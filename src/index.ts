export const packageName = "deepseek-crawl";
export type { MapOptions, MapSitemapReader } from "./application/index.js";
export { executeCrawl, executeFetch, executeMap, executeSearch } from "./application/index.js";
export type {
  CrawlFailure,
  CrawlOptions,
  CrawlOutputResult,
  CrawlPage,
  CrawlPageIndex,
  CrawlPageSummary,
  CrawlRunResult,
  MapResult,
  MapUrl,
  MapUrlSource,
  MapWarning,
} from "./crawl/types.js";
export { DeepSeekClient } from "./deepseek/client.js";
export { DeepSeekError } from "./deepseek/errors.js";
