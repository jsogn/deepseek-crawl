import type {
  BatchFetchFailure,
  BatchFetchOptions,
  BatchFetchPage,
  BatchFetchPageSummary,
  BatchFetchResult,
} from "../batch/types.js";
import { normalizeHttpUrl } from "../crawl/links.js";
import { runLayeredTasks } from "../crawl/queue.js";
import { DeepSeekError } from "../deepseek/errors.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import { errorMessage } from "../error-message.js";
import { boundFetchOutput, codepointLength } from "../output/bounds.js";
import { parseBatchFetchRetryReport } from "../retry/report.js";
import type { RetryAttempt, RetrySummary } from "../retry/types.js";

const MAX_CONCURRENCY = 5;
const MAX_DELAY_MS = 5_000;
const MAX_CONTENT_CHARS = 1_000_000;

function normalizeInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Math.min(value, maximum);
}

function normalizeOptions(options: BatchFetchOptions): BatchFetchOptions {
  return {
    concurrency: normalizeInteger(options.concurrency, "concurrency", 1, MAX_CONCURRENCY),
    delayMs: normalizeInteger(options.delayMs, "delayMs", 0, MAX_DELAY_MS),
    maxChars: normalizeInteger(options.maxChars, "maxChars", 0, MAX_CONTENT_CHARS),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

function entryUrl(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "url" in value &&
    typeof value.url === "string"
  ) {
    return value.url;
  }
  throw new Error("Batch input entries must be strings or objects containing a url string.");
}

function parseStructuredInput(input: unknown): string[] {
  let entries: unknown[];
  if (Array.isArray(input)) {
    entries = input;
  } else if (
    input !== null &&
    typeof input === "object" &&
    "urls" in input &&
    Array.isArray(input.urls)
  ) {
    entries = input.urls;
  } else if (
    input !== null &&
    typeof input === "object" &&
    "url" in input &&
    typeof input.url === "string"
  ) {
    entries = [input.url];
  } else {
    throw new Error("Batch Fetch input must contain a URL array or urls field.");
  }
  const urls = entries.map(entryUrl);
  if (urls.length === 0) {
    throw new Error("Batch Fetch input cannot be empty.");
  }
  return urls;
}

export function parseBatchFetchInput(input: string | unknown): string[] {
  if (typeof input !== "string") {
    return parseStructuredInput(input);
  }
  const text = input.trim();
  if (!text) {
    throw new Error("Batch Fetch input cannot be empty.");
  }
  if (text.startsWith("[") || text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error("Batch Fetch JSON input is invalid.", { cause: error });
    }
    return parseStructuredInput(parsed);
  }
  const urls = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (urls.length === 0) {
    throw new Error("Batch Fetch input cannot be empty.");
  }
  return urls;
}

function displayUrl(value: string, index: number): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.href.slice(0, 2_048);
  } catch {
    return `input-${index + 1}`;
  }
}

function errorKind(error: unknown): string {
  return error instanceof DeepSeekError ? error.kind : "fetch";
}

function summaryFor(page: BatchFetchPage): BatchFetchPageSummary {
  const summary: BatchFetchPageSummary = {
    index: page.index,
    url: page.url,
    title: page.title,
    content_length: codepointLength(page.content),
    content_truncated: page.contentTruncated,
  };
  if (page.contentTruncated) {
    summary.content_original_length = page.contentOriginalLength;
  }
  if (page.retryOf) {
    summary.retry_of = page.retryOf;
  }
  return summary;
}

interface BatchOutcome {
  summary: BatchFetchPageSummary | null;
  failure: BatchFetchFailure | null;
}

interface BatchFetchRequest {
  url: string;
  index: number;
  retryOf?: RetryAttempt;
}

async function executeBatchRequests(
  client: DeepSeekGateway,
  requests: BatchFetchRequest[],
  initialFailures: BatchFetchFailure[],
  inputCount: number,
  source: string,
  settings: BatchFetchOptions,
  onPage: (page: BatchFetchPage) => Promise<void>,
  signal?: AbortSignal,
  retryOf?: RetrySummary,
): Promise<BatchFetchResult> {
  const failures = [...initialFailures];
  const now = settings.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const outcomes = await runLayeredTasks<BatchFetchRequest, BatchOutcome>(requests, {
    concurrency: settings.concurrency,
    delayMs: settings.delayMs,
    signal: combinedSignal,
    run: async (request) => {
      try {
        const response = await client.fetch({ url: request.url }, combinedSignal);
        const bounded = boundFetchOutput({ ...response, url: request.url }, settings.maxChars);
        const page: BatchFetchPage = {
          index: request.index,
          url: request.url,
          title: bounded.title,
          content: bounded.content,
          contentTruncated: bounded.truncated ?? false,
          contentOriginalLength: bounded.original_length ?? codepointLength(bounded.content),
          ...(request.retryOf ? { retryOf: request.retryOf } : {}),
        };
        try {
          await onPage(page);
        } catch (error) {
          controller.abort(error);
          throw error;
        }
        return { summary: summaryFor(page), failure: null };
      } catch (error) {
        if (combinedSignal.aborted) {
          throw error;
        }
        return {
          summary: null,
          failure: {
            url: request.url,
            index: request.index,
            kind: errorKind(error),
            message: errorMessage(error),
            ...(request.retryOf ? { retry_of: request.retryOf } : {}),
          },
        };
      }
    },
  });

  const pages: BatchFetchPageSummary[] = [];
  for (const outcome of outcomes) {
    if (outcome.summary) {
      pages.push(outcome.summary);
    } else if (outcome.failure) {
      failures.push(outcome.failure);
    }
  }
  pages.sort((left, right) => left.index - right.index);

  return {
    version: 1,
    source,
    started_at: startedAt,
    finished_at: now().toISOString(),
    settings: {
      concurrency: settings.concurrency,
      delay_ms: settings.delayMs,
      max_chars: settings.maxChars,
    },
    stats: {
      input: inputCount,
      unique: requests.length,
      fetched: pages.length,
      failed: failures.length,
    },
    pages,
    failures,
    ...(retryOf ? { retry_of: retryOf } : {}),
  };
}

export async function executeBatchFetch(
  client: DeepSeekGateway,
  input: string | unknown,
  source: string,
  options: BatchFetchOptions,
  onPage: (page: BatchFetchPage) => Promise<void>,
  signal?: AbortSignal,
): Promise<BatchFetchResult> {
  const settings = normalizeOptions(options);
  const entries = parseBatchFetchInput(input);
  const failures: BatchFetchFailure[] = [];
  const requests: BatchFetchRequest[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const normalized = normalizeHttpUrl(entry);
    if (!normalized) {
      failures.push({
        url: displayUrl(entry, index),
        index: index + 1,
        kind: "invalid_url",
        message: "Batch input must be an HTTP(S) URL with a host and no credentials.",
      });
      continue;
    }
    if (!seen.has(normalized.href)) {
      seen.add(normalized.href);
      requests.push({ url: normalized.href, index: requests.length + 1 });
    }
  }
  return executeBatchRequests(
    client,
    requests,
    failures,
    entries.length,
    source,
    settings,
    onPage,
    signal,
  );
}

export async function executeBatchFetchRetry(
  client: DeepSeekGateway,
  input: unknown,
  reportSource: string,
  options: BatchFetchOptions,
  onPage: (page: BatchFetchPage) => Promise<void>,
  signal?: AbortSignal,
): Promise<BatchFetchResult> {
  const settings = normalizeOptions(options);
  const report = parseBatchFetchRetryReport(input);
  const requests: BatchFetchRequest[] = [];
  const skipped: RetryAttempt[] = [];
  const seen = new Set<string>();
  const usedIndexes = new Set<number>();
  let fallbackIndex = 1;

  for (const failure of report.failures) {
    const normalized = normalizeHttpUrl(failure.url);
    if (!normalized) {
      skipped.push(failure);
      continue;
    }
    if (seen.has(normalized.href)) {
      continue;
    }
    seen.add(normalized.href);
    let index = failure.index ?? fallbackIndex;
    while (usedIndexes.has(index)) {
      index += 1;
    }
    usedIndexes.add(index);
    fallbackIndex = Math.max(fallbackIndex, index + 1);
    requests.push({ url: normalized.href, index, retryOf: failure });
  }

  const retryOf: RetrySummary = {
    source: reportSource,
    original_source: report.source,
    original_failures: report.failures.length,
    attempted: requests.length,
    skipped,
    truncated: false,
  };
  return executeBatchRequests(
    client,
    requests,
    [],
    report.failures.length,
    `${reportSource} [retry-failed]`,
    settings,
    onPage,
    signal,
    retryOf,
  );
}
