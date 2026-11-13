import { extractMarkdownLinks, normalizeHttpUrl, sameOrigin } from "../crawl/links.js";
import { runLayeredTasks } from "../crawl/queue.js";
import type {
  CrawlFailure,
  CrawlOptions,
  CrawlPage,
  CrawlPageSummary,
  CrawlRunResult,
} from "../crawl/types.js";
import { DeepSeekError } from "../deepseek/errors.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import { fetchInputSchema } from "../deepseek/schemas.js";
import { boundFetchOutput } from "../output/bounds.js";

interface PageOutcome {
  url: string;
  page: CrawlPage | null;
  links: string[];
  error: unknown | null;
}

function errorKind(error: unknown): string {
  return error instanceof DeepSeekError ? error.kind : "crawl";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codepointLength(value: string): number {
  return [...value].length;
}

function summaryFor(page: CrawlPage): CrawlPageSummary {
  const summary: CrawlPageSummary = {
    index: page.index,
    url: page.url,
    title: page.title,
    depth: page.depth,
    content_length: codepointLength(page.content),
    content_truncated: page.content_truncated,
  };
  if (page.content_truncated) {
    summary.content_original_length = page.content_original_length;
  }
  return summary;
}

export async function executeCrawl(
  client: DeepSeekGateway,
  input: unknown,
  options: CrawlOptions,
  onPage?: (page: CrawlPage) => Promise<void>,
  signal?: AbortSignal,
): Promise<CrawlRunResult> {
  const parsed = fetchInputSchema.parse(input);
  const seed = normalizeHttpUrl(parsed.url);
  if (!seed) {
    throw new Error("Crawl URL must be an HTTP(S) URL with a host and no credentials.");
  }

  const now = options.now ?? (() => new Date());
  const crawlController = new AbortController();
  const crawlSignal = signal
    ? AbortSignal.any([signal, crawlController.signal])
    : crawlController.signal;
  crawlSignal.throwIfAborted();
  const startedAt = now().toISOString();
  const seen = new Set<string>([seed.href]);
  const pages: CrawlPageSummary[] = [];
  const failures: CrawlFailure[] = [];
  let frontier: string[] = [];
  let nextIndex = 1;
  let attemptedPages = 1;
  let fetched = 0;
  let contentTruncated = 0;
  let limitReached = false;
  let discoveryLimitReached = false;

  const fetchPage = async (url: string, depth: number, index: number): Promise<PageOutcome> => {
    let page: CrawlPage;
    let links: string[];
    try {
      const response = await client.fetch({ url }, crawlSignal);
      const bounded = boundFetchOutput({ ...response, url }, options.pageContentLimit);
      page = {
        index,
        url,
        title: bounded.title,
        depth,
        content: bounded.content,
        content_truncated: bounded.truncated ?? false,
        content_original_length: bounded.original_length ?? codepointLength(bounded.content),
      };
      links =
        depth < options.maxDepth
          ? extractMarkdownLinks(bounded.content, new URL(url))
              .filter((candidate) => sameOrigin(candidate, seed))
              .map((candidate) => candidate.href)
          : [];
    } catch (error) {
      if (crawlSignal.aborted) {
        throw error;
      }
      return { url, page: null, links: [], error };
    }
    if (onPage) {
      try {
        await onPage(page);
      } catch (error) {
        crawlController.abort(error);
        throw error;
      }
    }
    return { url, page, links, error: null };
  };

  const seedOutcome = await fetchPage(seed.href, 0, nextIndex);
  nextIndex += 1;
  if (!seedOutcome.page) {
    throw seedOutcome.error;
  }
  fetched += 1;
  contentTruncated += seedOutcome.page.content_truncated ? 1 : 0;
  pages.push(summaryFor(seedOutcome.page));

  const mergeLinks = (links: string[]): string[] => {
    const candidates = [...new Set(links)].sort();
    const nextFrontier: string[] = [];
    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      if (seen.size >= options.discoveryLimit) {
        discoveryLimitReached = true;
        continue;
      }
      seen.add(candidate);
      nextFrontier.push(candidate);
    }
    return nextFrontier;
  };

  frontier = mergeLinks(seedOutcome.links);
  let depth = 1;
  while (frontier.length > 0 && depth <= options.maxDepth && attemptedPages < options.maxPages) {
    const sorted = [...frontier].sort();
    const remaining = options.maxPages - attemptedPages;
    const selected = sorted.slice(0, remaining);
    if (selected.length < sorted.length) {
      limitReached = true;
    }
    attemptedPages += selected.length;
    const selectedIndexes = selected.map(() => {
      const index = nextIndex;
      nextIndex += 1;
      return index;
    });
    const outcomes = await runLayeredTasks<string, PageOutcome>(selected, {
      concurrency: options.concurrency,
      delayMs: options.delayMs,
      signal: crawlSignal,
      run: async (url, index) => fetchPage(url, depth, selectedIndexes[index] ?? 0),
    });

    const nextLayerLinks: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.page) {
        fetched += 1;
        contentTruncated += outcome.page.content_truncated ? 1 : 0;
        pages.push(summaryFor(outcome.page));
        nextLayerLinks.push(...outcome.links);
      } else {
        failures.push({
          url: outcome.url,
          depth,
          kind: errorKind(outcome.error),
          message: errorMessage(outcome.error),
        });
      }
    }

    frontier = mergeLinks(nextLayerLinks);
    depth += 1;
  }

  if (attemptedPages >= options.maxPages && frontier.length > 0) {
    limitReached = true;
  }

  pages.sort((left, right) => left.index - right.index);
  failures.sort((left, right) => left.depth - right.depth || left.url.localeCompare(right.url));

  return {
    version: 1,
    seed_url: seed.href,
    started_at: startedAt,
    finished_at: now().toISOString(),
    settings: {
      max_depth: options.maxDepth,
      max_pages: options.maxPages,
      concurrency: options.concurrency,
      delay_ms: options.delayMs,
    },
    stats: {
      discovered: seen.size,
      fetched,
      failed: failures.length,
      content_truncated: contentTruncated,
      limit_reached: limitReached,
      discovery_limit_reached: discoveryLimitReached,
    },
    pages,
    failures,
  };
}
