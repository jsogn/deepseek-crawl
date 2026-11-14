import type { ReadableStreamDefaultReader } from "node:stream/web";
import type { z } from "zod";
import type {
  FetchInput,
  RawBalanceResponse,
  RawFetchResponse,
  RawSearchResponse,
  SearchInput,
} from "../types.js";
import { DeepSeekError, type DeepSeekErrorKind } from "./errors.js";
import { balanceResponseSchema, fetchResponseSchema, searchResponseSchema } from "./schemas.js";

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_UPSTREAM_MESSAGE_LENGTH = 500;
const MAX_FETCH_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl: URL;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  fetchResponseByteLimit?: number;
}

function cancellationError(): DeepSeekError {
  return new DeepSeekError("Request cancelled.", { kind: "cancelled" });
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(cancellationError());
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancellationError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorKindForStatus(status: number): DeepSeekErrorKind {
  switch (status) {
    case 400:
    case 413:
      return "invalid_request";
    case 401:
      return "auth";
    case 402:
      return "balance";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 408:
      return "timeout";
    case 429:
      return "rate_limit";
    default:
      return status >= 500 ? "server" : "invalid_request";
  }
}

function defaultStatusMessage(status: number): string {
  switch (status) {
    case 400:
      return "DeepSeek rejected the request.";
    case 401:
      return "DeepSeek API key is invalid or missing.";
    case 402:
      return "DeepSeek account balance is insufficient.";
    case 403:
      return "DeepSeek rejected the request under its security policy.";
    case 404:
      return "DeepSeek could not extract usable page content.";
    case 408:
      return "DeepSeek timed out reading the request.";
    case 413:
      return "The DeepSeek request is too large.";
    case 429:
      return "DeepSeek rate limit exceeded.";
    case 500:
      return "DeepSeek internal server error.";
    case 502:
    case 503:
    case 504:
      return "DeepSeek is temporarily unavailable.";
    default:
      return `DeepSeek request failed with HTTP ${status}.`;
  }
}

function safeUpstreamMessage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, MAX_UPSTREAM_MESSAGE_LENGTH) : undefined;
}

async function readUpstreamMessage(
  response: Response,
  signal: AbortSignal,
): Promise<string | undefined> {
  const body = await readResponseBodyWithLimit(response, MAX_ERROR_RESPONSE_BYTES, signal).catch(
    () => undefined,
  );
  if (!body || body.truncated || body.bytes.length === 0) {
    return undefined;
  }
  try {
    const data = JSON.parse(body.bytes.toString("utf8")) as { error?: { message?: unknown } };
    return safeUpstreamMessage(data.error?.message);
  } catch {
    return undefined;
  }
}

function statusError(response: Response, upstreamMessage?: string): DeepSeekError {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const message = upstreamMessage
    ? `DeepSeek HTTP ${response.status}: ${upstreamMessage}`
    : defaultStatusMessage(response.status);
  const options: ConstructorParameters<typeof DeepSeekError>[1] = {
    kind: errorKindForStatus(response.status),
    status: response.status,
  };
  if (requestId !== undefined) {
    options.requestId = requestId;
  }
  return new DeepSeekError(message, options);
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  if (/^\d+$/.test(value.trim())) {
    return Math.min(Number(value.trim()) * 1000, 5000);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return Math.max(0, Math.min(timestamp - now, 5000));
}

function jitteredDelay(attempt: number, random: () => number): number {
  const base = attempt === 0 ? 250 : 750;
  const factor = 0.5 + Math.min(Math.max(random(), 0), 1);
  return Math.round(base * factor);
}

function responseTooLargeError(): DeepSeekError {
  return new DeepSeekError("DeepSeek Fetch response exceeded the configured byte limit.", {
    kind: "resource_limit",
  });
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reader.cancel().catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readJsonWithByteLimit<T>(
  response: Response,
  maxBytes: number,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  const body = await readResponseBodyWithLimit(response, maxBytes, signal);
  if (body.truncated) {
    throw responseTooLargeError();
  }
  return schema.parse(JSON.parse(body.bytes.toString("utf8")));
}

async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { bytes: Buffer.alloc(0), truncated: true };
  }

  if (!response.body) {
    const bytes = Buffer.from(await response.text(), "utf8");
    return {
      bytes: bytes.subarray(0, maxBytes),
      truncated: bytes.byteLength > maxBytes,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await readChunk(reader, signal);
    if (chunk.done) {
      break;
    }
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { bytes: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(chunk.value);
  }

  return { bytes: Buffer.concat(chunks), truncated: false };
}

export class DeepSeekClient {
  readonly #apiKey: string;
  readonly #baseUrl: URL;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetchImpl: typeof fetch;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #fetchResponseByteLimit: number;

  constructor(options: DeepSeekClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl;
    this.#timeoutMs = options.timeoutMs;
    this.#maxRetries = options.maxRetries;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    const fetchResponseByteLimit = options.fetchResponseByteLimit ?? MAX_FETCH_RESPONSE_BYTES;
    if (!Number.isSafeInteger(fetchResponseByteLimit) || fetchResponseByteLimit < 1) {
      throw new Error("fetchResponseByteLimit must be a positive safe integer.");
    }
    this.#fetchResponseByteLimit = Math.min(fetchResponseByteLimit, MAX_FETCH_RESPONSE_BYTES);
  }

  search(input: SearchInput, signal?: AbortSignal): Promise<RawSearchResponse> {
    return this.#request({
      method: "POST",
      path: "v1/tools/search",
      body: input,
      schema: searchResponseSchema,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  fetch(input: FetchInput, signal?: AbortSignal): Promise<RawFetchResponse> {
    return this.#request({
      method: "POST",
      path: "v1/tools/fetch",
      body: input,
      schema: fetchResponseSchema,
      maxResponseBytes: this.#fetchResponseByteLimit,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  balance(signal?: AbortSignal): Promise<RawBalanceResponse> {
    return this.#request({
      method: "GET",
      path: "user/balance",
      schema: balanceResponseSchema,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #request<T>(options: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    schema: z.ZodType<T>;
    maxResponseBytes?: number;
    signal?: AbortSignal;
  }): Promise<T> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      if (options.signal?.aborted) {
        throw cancellationError();
      }

      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), this.#timeoutMs);
      const requestSignal = options.signal
        ? AbortSignal.any([options.signal, timeoutController.signal])
        : timeoutController.signal;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.#apiKey}`,
        Accept: "application/json",
      };
      if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      let response: Response | undefined;
      try {
        response = await this.#fetchImpl(new URL(options.path, this.#baseUrl), {
          method: options.method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          redirect: "error",
          signal: requestSignal,
        });

        if (!response.ok) {
          const upstreamMessage = await readUpstreamMessage(response, requestSignal);
          if (timeoutController.signal.aborted) {
            throw new DeepSeekError("DeepSeek request timed out.", { kind: "timeout" });
          }
          const error = statusError(response, upstreamMessage);
          if (RETRYABLE_STATUSES.has(response.status) && attempt < this.#maxRetries) {
            const retryAfter =
              response.status === 429
                ? parseRetryAfter(response.headers.get("retry-after"))
                : undefined;
            clearTimeout(timer);
            await this.#sleep(retryAfter ?? jitteredDelay(attempt, this.#random), options.signal);
            continue;
          }
          throw error;
        }

        if (options.maxResponseBytes !== undefined) {
          return await readJsonWithByteLimit(
            response,
            options.maxResponseBytes,
            options.schema,
            requestSignal,
          );
        }
        return options.schema.parse(await response.json());
      } catch (error) {
        if (options.signal?.aborted) {
          throw cancellationError();
        }
        if (timeoutController.signal.aborted) {
          throw new DeepSeekError("DeepSeek request timed out.", {
            kind: "timeout",
            cause: error,
          });
        }
        if (error instanceof DeepSeekError) {
          throw error;
        }
        if (response) {
          throw new DeepSeekError("DeepSeek returned an invalid response.", {
            kind: "invalid_response",
            cause: error,
          });
        }
        throw new DeepSeekError("Could not reach the DeepSeek API.", {
          kind: "network",
          cause: error,
        });
      } finally {
        clearTimeout(timer);
      }
    }

    throw new DeepSeekError("DeepSeek request failed.", { kind: "server" });
  }
}
