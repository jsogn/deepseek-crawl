import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { acquireWriterLock, releaseWriterLock, writeJsonAtomic } from "../crawl/persistence.js";
import { errorMessage } from "../error-message.js";
import { assertPathMissing, writeFileAtomic } from "../output/files.js";
import { pageRelativePath, renderPageMarkdown } from "../output/page.js";
import { createStagedDirectoryOutput } from "../output/publication.js";
import { summarizeBatchFetchPage } from "./summary.js";
import type {
  BatchFetchFailure,
  BatchFetchJobState,
  BatchFetchOutputResult,
  BatchFetchPage,
  BatchFetchPageSummary,
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

const journalRecordSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("page"),
    at: z.string(),
    page: pageSchema,
  }),
  z.object({
    type: z.literal("failure"),
    at: z.string(),
    failure: failureSchema,
  }),
]);

type JournalRecord =
  | { type: "page"; at: string; page: BatchFetchPageSummary }
  | { type: "failure"; at: string; failure: BatchFetchFailure };

function journalPath(directory: string): string {
  return join(directory, "journal.jsonl");
}

function failureKey(failure: { index?: number | undefined; url: string }): string {
  return `${failure.index ?? ""}\0${failure.url}`;
}

function applyJournalRecords(
  state: BatchFetchJobState,
  records: JournalRecord[],
): BatchFetchJobState {
  const pages = new Map(state.pages.map((page) => [page.index, page] as const));
  const failures = new Map(
    state.failures.map((failure) => [failureKey(failure), failure] as const),
  );
  let updatedAt = state.updated_at;
  for (const record of records) {
    updatedAt = record.at;
    if (record.type === "page") {
      pages.set(record.page.index, record.page);
    } else {
      failures.set(failureKey(record.failure), record.failure);
    }
  }
  return {
    ...state,
    pages: [...pages.values()].sort(byIndex),
    failures: [...failures.values()].sort(byIndex),
    updated_at: updatedAt,
  };
}

function normalizeState(state: BatchFetchJobState): BatchFetchJobState {
  return {
    ...state,
    pages: [...new Map(state.pages.map((page) => [page.index, page])).values()].sort(byIndex),
    failures: [
      ...new Map(state.failures.map((failure) => [failureKey(failure), failure] as const)).values(),
    ].sort(byIndex),
  };
}

async function readJournalRecords(directory: string): Promise<JournalRecord[]> {
  let text: string;
  try {
    text = await readFile(journalPath(directory), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  if (!text.trim()) {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const records: JournalRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    try {
      records.push(journalRecordSchema.parse(JSON.parse(line)) as JournalRecord);
    } catch (error) {
      const isFinalPartialRecord = index === lines.length - 1 && !text.endsWith("\n");
      if (isFinalPartialRecord) {
        break;
      }
      throw new Error("Invalid Batch Fetch job journal.", { cause: error });
    }
  }
  return records;
}

export async function readBatchFetchJobState(directory: string): Promise<BatchFetchJobState> {
  const parsed = stateSchema.safeParse(
    JSON.parse(await readFile(join(resolve(directory), "job.json"), "utf8")) as unknown,
  );
  if (!parsed.success) {
    throw new Error("Invalid or incompatible Batch Fetch job state.", { cause: parsed.error });
  }
  const records = await readJournalRecords(resolve(directory));
  return applyJournalRecords(parsed.data as BatchFetchJobState, records);
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
  #pageIndexes: Set<number>;
  #failureKeys: Set<string>;

  private constructor(directory: string, state: BatchFetchJobState, now: () => Date) {
    this.directory = directory;
    this.#state = state;
    this.#now = now;
    this.#pageIndexes = new Set(state.pages.map((page) => page.index));
    this.#failureKeys = new Set(state.failures.map(failureKey));
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
      await writeFileAtomic(journalPath(target), "", { mode: 0o600 });
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
      await writeFileAtomic(join(this.directory, relativePath), renderPageMarkdown(page), {
        mode: 0o600,
      });
      const summary = summarizeBatchFetchPage(page);
      await this.#append({
        type: "page",
        at: this.#now().toISOString(),
        page: summary,
      });
      const existing = this.#pageIndexes.has(page.index)
        ? this.#state.pages.findIndex((item) => item.index === page.index)
        : -1;
      if (existing === -1) {
        this.#state.pages.push(summary);
      } else {
        this.#state.pages[existing] = summary;
      }
      this.#pageIndexes.add(page.index);
    });
  }

  recordFailure(failure: BatchFetchJobState["failures"][number]): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertActive();
      const key = failureKey(failure);
      const alreadyRecorded = this.#failureKeys.has(key);
      if (alreadyRecorded) {
        return;
      }
      await this.#append({
        type: "failure",
        at: this.#now().toISOString(),
        failure,
      });
      this.#state.failures.push(failure);
      this.#failureKeys.add(key);
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
    const normalized = normalizeState(state);
    await writeJsonAtomic(join(this.directory, "job.json"), normalized);
    await writeFileAtomic(journalPath(this.directory), "", { mode: 0o600 });
    this.#state = normalized;
    this.#pageIndexes = new Set(normalized.pages.map((page) => page.index));
    this.#failureKeys = new Set(normalized.failures.map(failureKey));
  }

  async #append(record: JournalRecord): Promise<void> {
    await appendFile(journalPath(this.directory), `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.#state.updated_at = record.at;
  }

  #assertActive(): void {
    if (this.#released) {
      throw new Error("Batch Fetch job writer has been released.");
    }
  }
}
