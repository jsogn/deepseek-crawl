import { randomUUID } from "node:crypto";
import { z } from "zod";
import { executeCrawl } from "../application/crawl.js";
import type { MapSitemapReader } from "../application/map.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import { errorMessage } from "../error-message.js";
import { UnsupportedFallbackFeatureError } from "./errors.js";

const DEFAULT_JOB_TTL_MS = 24 * 60 * 60 * 1000;

const crawlInputSchema = z
  .object({
    url: z.string().trim().min(1),
    limit: z.number().int().min(1).max(10_000).optional(),
    maxDiscoveryDepth: z.number().int().min(0).optional(),
    sitemap: z.enum(["skip", "include", "only"]).optional(),
    ignoreQueryParameters: z.boolean().optional(),
    includePaths: z.array(z.string()).optional(),
    excludePaths: z.array(z.string()).optional(),
    delay: z.number().nonnegative().optional(),
    maxConcurrency: z.number().int().min(1).optional(),
    allowExternalLinks: z.boolean().optional(),
    allowSubdomains: z.boolean().optional(),
    scrapeOptions: z
      .object({
        formats: z
          .array(
            z.union([
              z.string(),
              z
                .object({
                  type: z.string(),
                })
                .passthrough(),
            ]),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface CrawlJobManagerOptions {
  now?: () => Date;
  idFactory?: () => string;
  jobTtlMs?: number;
}

export interface FirecrawlCrawlDocument {
  markdown: string;
  metadata: {
    title: string;
    sourceURL: string;
    url: string;
  };
}

export interface FirecrawlCrawlError {
  id: string;
  timestamp: string;
  url: string;
  error: string;
}

interface IndexedCrawlDocument {
  index: number;
  document: FirecrawlCrawlDocument;
}

export interface FirecrawlCrawlStatus {
  success: true;
  status: "scraping" | "completed" | "failed" | "cancelled";
  completed: number;
  total: number;
  creditsUsed: 0;
  createdAt: string;
  completedAt?: string;
  data: FirecrawlCrawlDocument[];
}

interface CrawlJob {
  id: string;
  url: string;
  status: FirecrawlCrawlStatus["status"];
  completed: number;
  total: number;
  createdAt: string;
  expiresAt: number;
  completedAt?: string;
  data: IndexedCrawlDocument[];
  errors: FirecrawlCrawlError[];
  controller: AbortController;
  done: Promise<void>;
}

function requestUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Crawl URL must be an HTTP(S) URL with a host.");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new Error("Crawl URL must be an HTTP(S) URL with a host.");
  }
  if (url.username || url.password) {
    throw new Error("Crawl URL must not contain credentials.");
  }
  return url.href;
}

function formatsAreMarkdownOnly(
  formats:
    | Array<
        | string
        | {
            type: string;
          }
      >
    | undefined,
): boolean {
  return (
    formats === undefined ||
    formats.every((format) => (typeof format === "string" ? format : format.type) === "markdown")
  );
}

export class CrawlJobManager {
  readonly #jobs = new Map<string, CrawlJob>();
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #jobTtlMs: number;

  constructor(options: CrawlJobManagerOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => `dsc_${randomUUID()}`);
    this.#jobTtlMs = options.jobTtlMs ?? DEFAULT_JOB_TTL_MS;
  }

  create(
    input: unknown,
    client: DeepSeekGateway,
    reader: MapSitemapReader,
  ): { success: true; id: string; url: string } {
    const parsed = crawlInputSchema.parse(input);
    if (!formatsAreMarkdownOnly(parsed.scrapeOptions?.formats)) {
      throw new UnsupportedFallbackFeatureError(
        "DeepSeek fallback supports only the Firecrawl markdown Crawl format.",
      );
    }
    if (parsed.allowExternalLinks) {
      throw new UnsupportedFallbackFeatureError(
        "DeepSeek fallback does not support Firecrawl external-link crawling.",
      );
    }
    if (parsed.allowSubdomains) {
      throw new UnsupportedFallbackFeatureError(
        "DeepSeek fallback does not support Firecrawl subdomain crawling.",
      );
    }
    const url = requestUrl(parsed.url);
    const generatedId = this.#idFactory();
    const id = generatedId.startsWith("dsc_") ? generatedId : `dsc_${generatedId}`;
    const controller = new AbortController();
    const createdAt = this.#now();
    const job: CrawlJob = {
      id,
      url,
      status: "scraping",
      completed: 0,
      total: 0,
      createdAt: createdAt.toISOString(),
      expiresAt: createdAt.getTime() + this.#jobTtlMs,
      data: [],
      errors: [],
      controller,
      done: Promise.resolve(),
    };
    this.#jobs.set(id, job);

    const sitemapMode = parsed.sitemap ?? "include";
    job.done = executeCrawl(
      client,
      { url },
      {
        maxDepth: Math.min(parsed.maxDiscoveryDepth ?? 2, 5),
        maxPages: Math.min(parsed.limit ?? 100, 100),
        concurrency: Math.min(parsed.maxConcurrency ?? 2, 5),
        delayMs: Math.min(Math.round((parsed.delay ?? 0) * 1000), 5000),
        discoveryLimit: 10_000,
        pageContentLimit: 1_000_000,
        includePaths: parsed.includePaths ?? [],
        excludePaths: parsed.excludePaths ?? [],
        ignoreQueryParameters: parsed.ignoreQueryParameters ?? false,
        sitemapMode,
        sitemapReader: reader,
      },
      async (page) => {
        job.data.push({
          index: page.index,
          document: {
            markdown: page.content,
            metadata: {
              title: page.title,
              sourceURL: page.url,
              url: page.url,
            },
          },
        });
        job.completed += 1;
        job.total = Math.max(job.total, job.completed);
      },
      job.controller.signal,
    )
      .then((result) => {
        job.status = "completed";
        job.completed = result.pages.length;
        job.total = result.pages.length + result.failures.length;
        job.completedAt = result.finished_at;
        job.errors = result.failures.map((failure, index) => ({
          id: String(failure.index ?? index + 1),
          timestamp: result.finished_at,
          url: failure.url,
          error: failure.message,
        }));
      })
      .catch((error: unknown) => {
        job.status = job.controller.signal.aborted ? "cancelled" : "failed";
        job.completedAt = this.#now().toISOString();
        if (job.status === "failed") {
          job.errors.push({
            id: String(job.completed + 1),
            timestamp: job.completedAt,
            url,
            error: errorMessage(error),
          });
        }
      });

    return { success: true, id, url };
  }

  waitForIdle(id: string): Promise<void> {
    return this.#job(id).done;
  }

  status(id: string): FirecrawlCrawlStatus | undefined {
    const job = this.#activeJob(id);
    if (!job) {
      return undefined;
    }
    return {
      success: true,
      status: job.status,
      completed: job.completed,
      total: job.total,
      creditsUsed: 0,
      createdAt: job.createdAt,
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      data: [...job.data]
        .sort((left, right) => left.index - right.index)
        .map((entry) => entry.document),
    };
  }

  errors(id: string): { errors: FirecrawlCrawlError[]; robotsBlocked: [] } | undefined {
    const job = this.#activeJob(id);
    if (!job) {
      return undefined;
    }
    return {
      errors: [...job.errors],
      robotsBlocked: [],
    };
  }

  cancel(id: string): boolean {
    const job = this.#activeJob(id);
    if (job?.status !== "scraping") {
      return false;
    }
    job.status = "cancelled";
    job.completedAt = this.#now().toISOString();
    job.controller.abort(new Error("Crawl cancelled."));
    return true;
  }

  #job(id: string): CrawlJob {
    const job = this.#jobs.get(id);
    if (!job) {
      throw new Error(`Crawl job not found: ${id}`);
    }
    return job;
  }

  #activeJob(id: string): CrawlJob | undefined {
    const job = this.#jobs.get(id);
    if (!job) {
      return undefined;
    }
    if (this.#now().getTime() >= job.expiresAt) {
      job.controller.abort(new Error("Crawl job expired."));
      this.#jobs.delete(id);
      return undefined;
    }
    return job;
  }
}
