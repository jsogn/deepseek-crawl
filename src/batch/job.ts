import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { acquireWriterLock, releaseWriterLock, writeJsonAtomic } from "../crawl/persistence.js";
import { errorMessage } from "../error-message.js";
import { assertPathMissing } from "../output/files.js";
import { pageRelativePath, renderPageMarkdown } from "../output/page.js";
import { createStagedDirectoryOutput } from "../output/publication.js";
import { summarizeBatchFetchPage } from "./summary.js";
import type {
  BatchFetchJobState,
  BatchFetchOutputResult,
  BatchFetchPage,
  BatchFetchResult,
} from "./types.js";

const pageSchema = z.object({
  index: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  content_length: z.number().int().nonnegative(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  content_truncated: z.boolean(),
  content_original_length: z.number().int().nonnegative().optional(),
  retrieved_from: z.enum(["api", "cache"]).optional(),
  retry_of: z
    .object({
      url: z.string(),
      index: z.number().int().positive().optional(),
      kind: z.string(),
      message: z.string(),
    })
    .optional(),
});

const failureSchema = z.object({
  url: z.string(),
  index: z.number().int().positive().optional(),
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
});

const stateSchema = z.object({
  version: z.literal(1),
  status: z.enum(["running", "interrupted", "completed"]),
  source: z.string(),
  output_dir: z.string(),
  started_at: z.string(),
  updated_at: z.string(),
  input: z.number().int().nonnegative(),
  settings: z.object({
    concurrency: z.number().int().positive(),
    delay_ms: z.number().int().nonnegative(),
    max_chars: z.number().int().nonnegative(),
  }),
  requests: z.array(
    z.object({
      index: z.number().int().positive(),
      url: z.string().url(),
    }),
  ),
  pages: z.array(pageSchema),
  failures: z.array(failureSchema),
  last_error: z.string().optional(),
});

export async function readBatchFetchJobState(directory: string): Promise<BatchFetchJobState> {
  const parsed = stateSchema.safeParse(
    JSON.parse(await readFile(join(resolve(directory), "job.json"), "utf8")) as unknown,
  );
  if (!parsed.success) {
    throw new Error("Invalid or incompatible Batch Fetch job state.", { cause: parsed.error });
  }
  return parsed.data as BatchFetchJobState;
}

function byIndex(left: { index?: number }, right: { index?: number }): number {
  return (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER);
}

function resultFromState(state: BatchFetchJobState): BatchFetchResult {
  return {
    version: 1,
    source: state.source,
    started_at: state.started_at,
    finished_at: state.updated_at,
    settings: state.settings,
    stats: {
      input: state.input,
      unique: state.requests.length,
      fetched: state.pages.length,
      failed: state.failures.length,
    },
    pages: [...state.pages].sort(byIndex),
    failures: [...state.failures].sort(byIndex),
  };
}

export class BatchFetchJobStore {
  readonly directory: string;
  #state: BatchFetchJobState;
  #now: () => Date;
  #released = false;
  #writes: Promise<void> = Promise.resolve();

  private constructor(directory: string, state: BatchFetchJobState, now: () => Date) {
    this.directory = directory;
    this.#state = state;
    this.#now = now;
  }

  static async create(
    directory: string,
    state: BatchFetchJobState,
    now: () => Date = () => new Date(),
  ): Promise<BatchFetchJobStore> {
    const target = resolve(directory);
    await assertPathMissing(target);
    await mkdir(dirname(target), { recursive: true });
    await mkdir(target, { mode: 0o700 });
    await mkdir(join(target, "pages"), { mode: 0o700 });
    try {
      await acquireWriterLock(target);
      await writeJsonAtomic(join(target, "job.json"), state);
      return new BatchFetchJobStore(target, state, now);
    } catch (error) {
      await releaseWriterLock(target).catch(() => undefined);
      throw error;
    }
  }

  static async open(
    directory: string,
    now: () => Date = () => new Date(),
  ): Promise<BatchFetchJobStore> {
    const target = resolve(directory);
    const state = await readBatchFetchJobState(target);
    await acquireWriterLock(target);
    return new BatchFetchJobStore(target, state, now);
  }

  get state(): BatchFetchJobState {
    return this.#state;
  }

  recordPage(page: BatchFetchPage): Promise<void> {
    return this.#enqueue(async () => {
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
      const summary = summarizeBatchFetchPage(page);
      const pages = [
        ...this.#state.pages.filter((item) => item.index !== page.index),
        summary,
      ].sort(byIndex);
      await this.#checkpoint({ ...this.#state, pages, updated_at: this.#now().toISOString() });
    });
  }

  recordFailure(failure: BatchFetchJobState["failures"][number]): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertActive();
      const alreadyRecorded = this.#state.failures.some(
        (item) => item.index === failure.index && item.url === failure.url,
      );
      if (alreadyRecorded) {
        return;
      }
      const failures = [...this.#state.failures, failure].sort(byIndex);
      await this.#checkpoint({ ...this.#state, failures, updated_at: this.#now().toISOString() });
    });
  }

  markInterrupted(error: unknown, now = this.#now): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertActive();
      await this.#checkpoint({
        ...this.#state,
        status: "interrupted",
        updated_at: now().toISOString(),
        last_error: errorMessage(error),
      });
    });
  }

  markCompleted(now = this.#now): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertActive();
      const { last_error: _, ...state } = this.#state;
      await this.#checkpoint({
        ...state,
        status: "completed",
        updated_at: now().toISOString(),
      });
    });
  }

  finalize(outputDirectory = this.#state.output_dir): Promise<BatchFetchOutputResult> {
    return this.#enqueue(async () => {
      this.#assertActive();
      if (this.#state.status !== "completed") {
        throw new Error("Batch Fetch job must be completed before publication.");
      }
      const directory = await createStagedDirectoryOutput(
        outputDirectory,
        "Batch Fetch job output is no longer writable.",
      );
      try {
        const result = resultFromState(this.#state);
        const pages = [];
        for (const summary of result.pages) {
          const relativePath = pageRelativePath(summary);
          const markdown = await readFile(join(this.directory, relativePath), "utf8");
          const path = await directory.writePage(summary, markdown);
          pages.push({ ...summary, path });
        }
        const output: BatchFetchOutputResult = { ...result, pages };
        return await directory.finish(async (stagingPath) => {
          await writeFile(
            join(stagingPath, "fetch.json"),
            `${JSON.stringify(output, null, 2)}\n`,
            "utf8",
          );
          return output;
        });
      } catch (error) {
        await directory.abort().catch(() => undefined);
        throw error;
      }
    });
  }

  async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    this.#released = true;
    await this.#writes;
    await releaseWriterLock(this.directory);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#writes.then(operation, operation);
    this.#writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #checkpoint(state: BatchFetchJobState): Promise<void> {
    await writeJsonAtomic(join(this.directory, "job.json"), state);
    this.#state = state;
  }

  #assertActive(): void {
    if (this.#released) {
      throw new Error("Batch Fetch job writer has been released.");
    }
  }
}
