import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { acquireWriterLock, releaseWriterLock, writeJsonAtomic } from "./persistence.js";
import type { CrawlMonitorState } from "./types.js";

const contentVersionSchema = z.object({
  url: z.string().url(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
const monitorBaselineEntrySchema = contentVersionSchema.extend({
  title: z.string(),
  depth: z.number().int().min(0).max(5),
  sources: z.array(z.enum(["seed_url", "markdown", "sitemap"])),
  content_length: z.number().int().min(0),
  content_truncated: z.boolean(),
  content_original_length: z.number().int().min(0).optional(),
  sitemap_lastmod: z.string().optional(),
});
const changesSchema = z.object({
  added: z.array(contentVersionSchema),
  modified: z.array(
    contentVersionSchema.extend({
      previous_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  unchanged: z.array(contentVersionSchema),
  removed: z.array(contentVersionSchema),
});
const baselineSchema = z.array(monitorBaselineEntrySchema).superRefine((pages, context) => {
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.url)) {
      context.addIssue({
        code: "custom",
        message: `Crawl monitor baseline contains duplicate URL: ${page.url}`,
      });
    }
    seen.add(page.url);
  }
});
const stateSchema = z.object({
  version: z.literal(2),
  seed_url: z.string().url(),
  options: z.object({
    maxDepth: z.number().int().min(0).max(5),
    maxPages: z.number().int().min(1).max(100),
    concurrency: z.number().int().min(1).max(5),
    delayMs: z.number().int().min(0).max(5000),
    includePaths: z.array(z.string()),
    excludePaths: z.array(z.string()),
    ignoreQueryParameters: z.boolean(),
    sitemapMode: z.enum(["include", "only", "skip"]),
  }),
  baseline: baselineSchema,
  last_run_at: z.string(),
  last_run_id: z.string().min(1),
  last_output: z.string().min(1),
  last_changes: changesSchema,
  last_has_changes: z.boolean(),
});

export async function readCrawlMonitorState(directory: string): Promise<CrawlMonitorState | null> {
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(await readFile(join(resolve(directory), "state.json"), "utf8")) as unknown,
    );
    if (!parsed.success) {
      throw new Error("Invalid or incompatible Crawl monitor state.", { cause: parsed.error });
    }
    return parsed.data as CrawlMonitorState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export class CrawlMonitorStore {
  readonly directory: string;
  #state: CrawlMonitorState | null;
  #released = false;

  private constructor(directory: string, state: CrawlMonitorState | null) {
    this.directory = directory;
    this.#state = state;
  }

  static async open(directory: string): Promise<CrawlMonitorStore> {
    const target = resolve(directory);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await acquireWriterLock(target);
    try {
      const state = await readCrawlMonitorState(target);
      return new CrawlMonitorStore(target, state);
    } catch (error) {
      await releaseWriterLock(target).catch(() => undefined);
      throw error;
    }
  }

  get state(): CrawlMonitorState | null {
    return this.#state;
  }

  async checkpoint(state: CrawlMonitorState): Promise<void> {
    if (this.#released) {
      throw new Error("Crawl monitor writer has been released.");
    }
    await writeJsonAtomic(join(this.directory, "state.json"), state);
    this.#state = state;
  }

  async reset(): Promise<boolean> {
    if (this.#released) {
      throw new Error("Crawl monitor writer has been released.");
    }
    if (!this.#state) {
      return false;
    }
    await rm(join(this.directory, "state.json"), { force: true });
    this.#state = null;
    return true;
  }

  async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    this.#released = true;
    await releaseWriterLock(this.directory);
  }
}
