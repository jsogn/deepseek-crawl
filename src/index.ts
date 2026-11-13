export const packageName = "deepseek-crawl";
export { executeCrawl, executeFetch, executeSearch } from "./application/index.js";
export type {
  CrawlFailure,
  CrawlOptions,
  CrawlOutputResult,
  CrawlPage,
  CrawlPageIndex,
  CrawlPageSummary,
  CrawlRunResult,
} from "./crawl/types.js";
export { DeepSeekClient } from "./deepseek/client.js";
export { DeepSeekError } from "./deepseek/errors.js";
