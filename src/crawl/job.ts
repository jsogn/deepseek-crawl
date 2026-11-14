import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { assertPathMissing, createExistingPathError } from "../output/files.js";
import { pageRelativePath, renderPageMarkdown } from "../output/page.js";
import { createStagedDirectoryOutput } from "../output/publication.js";
import type {
  CrawlCheckpointState,
  CrawlOutputResult,
  CrawlPage,
  CrawlRunResult,
} from "./types.js";

const sourceSchema = z.enum(["seed_url", "markdown", "sitemap"]);
const pageSchema = z.object({
  index: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  depth: z.number().int().nonnegative(),
  sources: z.array(sourceSchema),
  content_length: z.number().int().nonnegative(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  change_status: z.enum(["added", "modified", "unchanged"]).optional(),
  previous_content_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  content_truncated: z.boolean(),
  content_original_length: z.number().int().nonnegative().optional(),
  retrieved_from: z.enum(["api", "cache"]).optional(),
});

const stateSchema = z.object({
  version: z.literal(1),
  status: z.enum(["running", "interrupted", "completed"]),
  seed_url: z.string().url(),
  started_at: z.string(),
  updated_at: z.string(),
  options: z.object({
    maxDepth: z.number().int(),
    maxPages: z.number().int(),
    concurrency: z.number().int(),
    delayMs: z.number().int(),
    includePaths: z.array(z.string()),
    excludePaths: z.array(z.string()),
    ignoreQueryParameters: z.boolean(),
    sitemapMode: z.enum(["include", "only", "skip"]),
  }),
  counters: z.object({
    nextIndex: z.number().int().positive(),
    attemptedPages: z.number().int().nonnegative(),
    fetched: z.number().int().nonnegative(),
    contentTruncated: z.number().int().nonnegative(),
    limitReached: z.boolean(),
    discoveryLimitReached: z.boolean(),
    sitemapCandidates: z.number().int().nonnegative(),
  }),
  seen: z.array(z.string().url()),
  sources: z.array(z.object({ url: z.string().url(), sources: z.array(sourceSchema) })),
  pages: z.array(pageSchema),
  failures: z.array(
    z.object({
      url: z.string(),
      index: z.number().int().positive().optional(),
      depth: z.number().int().nonnegative(),
      sources: z.array(sourceSchema).optional(),
      kind: z.string(),
      message: z.string(),
      retry_of: z
        .object({
          url: z.string(),
          index: z.number().int().positive().optional(),
          kind: z.string(),
          message: z.string(),
        })
        .optional(),
    }),
  ),
  warnings: z.array(
    z.object({
      code: z.enum([
        "sitemap_unavailable",
        "sitemap_invalid",
        "sitemap_limit_reached",
        "seed_page_failed",
      ]),
      message: z.string(),
    }),
  ),
  frontier: z.array(z.string().url()),
  depth: z.number().int().nonnegative(),
  active_layer: z
    .object({
      depth: z.number().int().positive(),
      urls: z.array(z.string().url()),
      indexes: z.array(z.number().int().positive()),
      completed: z.array(z.string().url()),
      discovered: z.array(z.string().url()),
    })
    .optional(),
  last_error: z.string().optional(),
});

function lockPath(directory: string): string {
  return join(directory, "writer.lock");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function acquireWriterLock(directory: string): Promise<void> {
  const path = lockPath(directory);
  const payload = JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() });
  try {
    await writeFile(path, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const existing = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
  if (!Number.isSafeInteger(existing.pid) || (existing.pid as number) < 1) {
    throw createExistingPathError(path);
  }
  if (processIsAlive(existing.pid as number)) {
    throw createExistingPathError(path);
  }
  await rm(path, { force: true });
  await writeFile(path, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

export async function readCrawlJobState(directory: string): Promise<CrawlCheckpointState> {
  const parsed = stateSchema.safeParse(
    JSON.parse(await readFile(join(resolve(directory), "job.json"), "utf8")) as unknown,
  );
  if (!parsed.success) {
    throw new Error("Invalid or incompatible Crawl job state.", { cause: parsed.error });
  }
  return parsed.data as CrawlCheckpointState;
}

export class CrawlJobStore {
  readonly directory: string;
  #state: CrawlCheckpointState;
  #released = false;

  private constructor(directory: string, state: CrawlCheckpointState) {
    this.directory = directory;
    this.#state = state;
  }

  static async create(directory: string): Promise<CrawlJobStore> {
    const target = resolve(directory);
    await assertPathMissing(target);
    await mkdir(dirname(target), { recursive: true });
    await mkdir(target, { mode: 0o700 });
    await mkdir(join(target, "pages"), { mode: 0o700 });
    await acquireWriterLock(target);
    return new CrawlJobStore(target, {} as CrawlCheckpointState);
  }

  static async open(directory: string): Promise<CrawlJobStore> {
    const target = resolve(directory);
    const state = await readCrawlJobState(target);
    await acquireWriterLock(target);
    return new CrawlJobStore(target, state);
  }

  get state(): CrawlCheckpointState {
    return this.#state;
  }

  async checkpoint(state: CrawlCheckpointState): Promise<void> {
    this.#assertActive();
    await atomicJson(join(this.directory, "job.json"), state);
    this.#state = state;
  }

  async writePage(page: CrawlPage): Promise<string> {
    this.#assertActive();
    const relativePath = pageRelativePath(page);
    try {
      await writeFile(join(this.directory, relativePath), renderPageMarkdown(page), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    return relativePath;
  }

  async finalize(finalDirectory: string, result: CrawlRunResult): Promise<CrawlOutputResult> {
    this.#assertActive();
    if (this.#state.status !== "completed") {
      throw new Error("Crawl job must be completed before publication.");
    }
    const directory = await createStagedDirectoryOutput(
      finalDirectory,
      "Crawl job output is no longer writable.",
    );
    try {
      const pages = [];
      for (const summary of result.pages) {
        const relativePath = pageRelativePath(summary);
        const markdown = await readFile(join(this.directory, relativePath), "utf8");
        await directory.writePage(summary, markdown);
        pages.push({ ...summary, written: true, path: relativePath });
      }
      const output: CrawlOutputResult = { ...result, pages };
      return await directory.finish(async (stagingPath) => {
        await writeFile(
          join(stagingPath, "crawl.json"),
          `${JSON.stringify(output, null, 2)}\n`,
          "utf8",
        );
        return output;
      });
    } catch (error) {
      await directory.abort().catch(() => undefined);
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    this.#released = true;
    await rm(lockPath(this.directory), { force: true });
  }

  #assertActive(): void {
    if (this.#released) {
      throw new Error("Crawl job writer has been released.");
    }
  }
}
