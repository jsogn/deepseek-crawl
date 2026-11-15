import type { AdvancedBackendConfig } from "./config.js";

const PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_CONCURRENT_JSON = 4;

const BLOCKED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface AdvancedBackendStatus {
  enabled: boolean;
  provider: "pagesift" | null;
  url: string | null;
  reachable: boolean;
  api_ready: boolean;
  credential_configured: boolean;
}

export interface AdvancedRequest {
  method: string;
  path: string;
  headers: Headers;
  body?: Uint8Array;
  signal?: AbortSignal;
}

export interface AdvancedBackend {
  readonly config: AdvancedBackendConfig;
  request(input: AdvancedRequest): Promise<Response>;
  readJsonResponse(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export class AdvancedBackendError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AdvancedBackendError";
  }
}

export function disabledAdvancedBackendStatus(): AdvancedBackendStatus {
  return {
    enabled: false,
    provider: null,
    url: null,
    reachable: false,
    api_ready: false,
    credential_configured: false,
  };
}

function pageSiftHeaders(source: Headers, apiKey: string | undefined): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!BLOCKED_REQUEST_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

async function readSmallText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new AdvancedBackendError(
        "The advanced backend health response is too large.",
        "advanced_backend_invalid_response",
        502,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

export async function probePageSift(
  config: AdvancedBackendConfig,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<AdvancedBackendStatus> {
  const headers = pageSiftHeaders(new Headers(), config.apiKey);
  let health: Response;
  let healthBody: string;
  try {
    health = await fetchImpl(new URL("healthz", config.url), {
      headers,
      redirect: "manual",
      signal: signalWithTimeout(signal, PROBE_TIMEOUT_MS),
    });
    healthBody = await readSmallText(health, 64);
  } catch {
    return {
      enabled: true,
      provider: "pagesift",
      url: config.url.href,
      reachable: false,
      api_ready: false,
      credential_configured: config.apiKey !== undefined,
    };
  }
  if (!health.ok || healthBody.trim() !== "ok") {
    return {
      enabled: true,
      provider: "pagesift",
      url: config.url.href,
      reachable: false,
      api_ready: false,
      credential_configured: config.apiKey !== undefined,
    };
  }
  try {
    const active = await fetchImpl(new URL("v2/crawl/active", config.url), {
      headers,
      redirect: "manual",
      signal: signalWithTimeout(signal, PROBE_TIMEOUT_MS),
    });
    await active.body?.cancel().catch(() => undefined);
    return {
      enabled: true,
      provider: "pagesift",
      url: config.url.href,
      reachable: true,
      api_ready: active.ok,
      credential_configured: config.apiKey !== undefined,
    };
  } catch {
    return {
      enabled: true,
      provider: "pagesift",
      url: config.url.href,
      reachable: true,
      api_ready: false,
      credential_configured: config.apiKey !== undefined,
    };
  }
}

class JsonBufferLimiter {
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw signal.reason;
    }
    if (this.#active < MAX_CONCURRENT_JSON) {
      this.#active += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        let abort: () => void;
        const wake = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        abort = () => {
          const index = this.#waiters.indexOf(wake);
          if (index >= 0) {
            this.#waiters.splice(index, 1);
          }
          reject(signal?.reason ?? new Error("Aborted."));
        };
        this.#waiters.push(wake);
        signal?.addEventListener("abort", abort, { once: true });
      });
      if (signal?.aborted) {
        this.#release();
        throw signal.reason;
      }
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#release();
    };
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) {
      next();
      return;
    }
    this.#active = Math.max(0, this.#active - 1);
  }
}

async function boundedBytes(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel();
      throw signal.reason;
    }
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new AdvancedBackendError(
        "The advanced scrape response is too large to establish session routing.",
        "advanced_backend_response_too_large",
        502,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export function createPageSiftBackend(
  config: AdvancedBackendConfig,
  fetchImpl: typeof fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): AdvancedBackend {
  const limiter = new JsonBufferLimiter();
  return {
    config,
    async request(input) {
      try {
        return await fetchImpl(new URL(input.path, config.url), {
          method: input.method,
          headers: pageSiftHeaders(input.headers, config.apiKey),
          redirect: "manual",
          signal: signalWithTimeout(input.signal, timeoutMs),
          ...(input.body === undefined ? {} : { body: input.body }),
        });
      } catch {
        if (input.signal?.aborted) {
          throw input.signal.reason;
        }
        throw new AdvancedBackendError(
          "The configured advanced backend is unavailable.",
          "advanced_backend_unavailable",
          503,
        );
      }
    },
    async readJsonResponse(response, signal) {
      const release = await limiter.acquire(signal);
      try {
        const bytes = await boundedBytes(response, MAX_JSON_BYTES, signal);
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
        } catch {
          throw new AdvancedBackendError(
            "The advanced backend returned an invalid scrape response.",
            "advanced_backend_invalid_response",
            502,
          );
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new AdvancedBackendError(
            "The advanced backend returned an invalid scrape response.",
            "advanced_backend_invalid_response",
            502,
          );
        }
        return parsed as Record<string, unknown>;
      } finally {
        release();
      }
    },
  };
}
