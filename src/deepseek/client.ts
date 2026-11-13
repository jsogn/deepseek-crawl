import type { z } from "zod";
import type { FetchInput, RawFetchResponse, RawSearchResponse, SearchInput } from "../types.js";
import { DeepSeekError, type DeepSeekErrorKind } from "./errors.js";
import { fetchResponseSchema, searchResponseSchema } from "./schemas.js";

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_UPSTREAM_MESSAGE_LENGTH = 500;

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl: URL;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
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

async function readUpstreamMessage(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return undefined;
  }
  try {
    const data = JSON.parse(text) as { error?: { message?: unknown } };
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

export class DeepSeekClient {
  readonly #apiKey: string;
  readonly #baseUrl: URL;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetchImpl: typeof fetch;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;

  constructor(options: DeepSeekClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl;
    this.#timeoutMs = options.timeoutMs;
    this.#maxRetries = options.maxRetries;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  search(input: SearchInput, signal?: AbortSignal): Promise<RawSearchResponse> {
    return this.#request("search", input, searchResponseSchema, signal);
  }

  fetch(input: FetchInput, signal?: AbortSignal): Promise<RawFetchResponse> {
    return this.#request("fetch", input, fetchResponseSchema, signal);
  }

  async #request<T>(
    operation: "search" | "fetch",
    input: SearchInput | FetchInput,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      if (signal?.aborted) {
        throw cancellationError();
      }

      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), this.#timeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      let response: Response;
      try {
        response = await this.#fetchImpl(new URL(`v1/tools/${operation}`, this.#baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(input),
          redirect: "error",
          signal: requestSignal,
        });
      } catch (error) {
        if (signal?.aborted) {
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
        throw new DeepSeekError("Could not reach the DeepSeek API.", {
          kind: "network",
          cause: error,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const upstreamMessage = await readUpstreamMessage(response);
        const error = statusError(response, upstreamMessage);
        if (RETRYABLE_STATUSES.has(response.status) && attempt < this.#maxRetries) {
          const retryAfter =
            response.status === 429
              ? parseRetryAfter(response.headers.get("retry-after"))
              : undefined;
          await this.#sleep(retryAfter ?? jitteredDelay(attempt, this.#random), signal);
          continue;
        }
        throw error;
      }

      try {
        return schema.parse(await response.json());
      } catch (error) {
        throw new DeepSeekError("DeepSeek returned an invalid response.", {
          kind: "invalid_response",
          cause: error,
        });
      }
    }

    throw new DeepSeekError("DeepSeek request failed.", { kind: "server" });
  }
}
