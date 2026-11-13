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
  summary: CrawlPageSummary | null;
  links: string[];
  error: unknown | null;
}

interface BoundedLinkCollector {
  add(link: string): void;
  finish(): { links: string[]; truncated: boolean };
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

function createBoundedLinkCollector(capacity: number, seen: Set<string>): BoundedLinkCollector {
  let candidates = new Set<string>();
  let truncated = false;

  const trim = (): void => {
    if (candidates.size <= capacity) {
      return;
    }
    const retained = [...candidates].sort().slice(0, capacity);
    candidates = new Set(retained);
    truncated = true;
  };

  return {
    add(link: string): void {
      if (seen.has(link) || candidates.has(link)) {
        return;
      }
      if (capacity === 0) {
        truncated = true;
        return;
      }
      candidates.add(link);
      if (candidates.size >= capacity * 2) {
        trim();
      }
    },
    finish(): { links: string[]; truncated: boolean } {
      trim();
      const links = [...candidates].sort();
      for (const link of links) {
        seen.add(link);
      }
      return { links, truncated };
    },
  };
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
      return { url, summary: null, links: [], error };
    }
    const summary = summaryFor(page);
    if (onPage) {
      try {
        await onPage(page);
      } catch (error) {
        crawlController.abort(error);
        throw error;
      }
    }
    return { url, summary, links, error: null };
  };

  const seedOutcome = await fetchPage(seed.href, 0, nextIndex);
  nextIndex += 1;
  if (!seedOutcome.summary) {
    throw seedOutcome.error;
  }
  fetched += 1;
  contentTruncated += seedOutcome.summary.content_truncated ? 1 : 0;
  pages.push(seedOutcome.summary);

  const seedLinks = createBoundedLinkCollector(
    Math.max(0, options.discoveryLimit - seen.size),
    seen,
  );
  for (const link of seedOutcome.links) {
    seedLinks.add(link);
  }
  seedOutcome.links = [];
  const seedCollection = seedLinks.finish();
  discoveryLimitReached = discoveryLimitReached || seedCollection.truncated;
  frontier = seedCollection.links;

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
    const layerLinks = createBoundedLinkCollector(
      Math.max(0, options.discoveryLimit - seen.size),
      seen,
    );
    const outcomes = await runLayeredTasks<string, PageOutcome>(selected, {
      concurrency: options.concurrency,
      delayMs: options.delayMs,
      signal: crawlSignal,
      run: async (url, index) => {
        const outcome = await fetchPage(url, depth, selectedIndexes[index] ?? 0);
        for (const link of outcome.links) {
          layerLinks.add(link);
        }
        return { ...outcome, links: [] };
      },
    });

    for (const outcome of outcomes) {
      if (outcome.summary) {
        fetched += 1;
        contentTruncated += outcome.summary.content_truncated ? 1 : 0;
        pages.push(outcome.summary);
      } else {
        failures.push({
          url: outcome.url,
          depth,
          kind: errorKind(outcome.error),
          message: errorMessage(outcome.error),
        });
      }
    }

    const collected = layerLinks.finish();
    discoveryLimitReached = discoveryLimitReached || collected.truncated;
    frontier = collected.links;
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
