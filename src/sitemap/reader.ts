import http from "node:http";
import https from "node:https";
import { packageVersion } from "../version.js";
import {
  isPublicIpAddress,
  type ResolvedAddress,
  resolvePublicAddress,
  stripIpv6Brackets,
} from "./network-policy.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SitemapFetchResponse {
  body: string;
  finalUrl: URL;
}

export interface SitemapFetcher {
  fetch(url: URL, signal?: AbortSignal): Promise<SitemapFetchResponse>;
}

interface SitemapHttpResponse {
  status: number;
  location?: string;
  body: string;
}

export interface PublicSitemapFetcherOptions {
  resolve?: (hostname: string) => Promise<ResolvedAddress>;
  request?: (
    url: URL,
    address: ResolvedAddress,
    signal?: AbortSignal,
  ) => Promise<SitemapHttpResponse>;
  timeoutMs?: number;
  bodyLimitBytes?: number;
  maxRedirects?: number;
}

function validateRequestUrl(url: URL): void {
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new Error("Sitemap URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Sitemap URL must not contain credentials.");
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.aborted) {
    return signal.reason instanceof Error ? signal.reason : new Error("Sitemap request cancelled.");
  }
  return new Error("Sitemap request cancelled.");
}

async function requestWithTimeout(
  request: NonNullable<PublicSitemapFetcherOptions["request"]>,
  url: URL,
  address: ResolvedAddress,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<SitemapHttpResponse> {
  if (signal?.aborted) {
    throw abortReason(signal);
  }

  const timeoutController = new AbortController();
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort(new Error("Sitemap request timed out."));
  }, timeoutMs);

  const aborted = new Promise<never>((_resolve, reject) => {
    requestSignal.addEventListener(
      "abort",
      () => {
        reject(timedOut ? new Error("Sitemap request timed out.") : abortReason(signal));
      },
      { once: true },
    );
  });

  try {
    return await Promise.race([request(url, address, requestSignal), aborted]);
  } finally {
    clearTimeout(timer);
  }
}

function defaultRequest(
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal | undefined,
  bodyLimitBytes: number,
): Promise<SitemapHttpResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const options: https.RequestOptions = {
      method: "GET",
      headers: {
        Accept: "application/xml,text/xml,*/*;q=0.8",
        "User-Agent": `deepseek-crawl/${packageVersion}`,
      },
      signal,
      lookup: (_hostname, _options, callback) => {
        callback(null, address.address, address.family);
      },
    };
    if (url.protocol === "https:") {
      options.servername = stripIpv6Brackets(url.hostname);
    }

    const request = transport.request(url, options, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > bodyLimitBytes) {
          response.destroy(new Error("Sitemap response exceeded the 5 MiB body limit."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const location = response.headers.location;
        resolve({
          status: response.statusCode ?? 0,
          ...(location ? { location } : {}),
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

export function createPublicSitemapFetcher(
  options: PublicSitemapFetcherOptions = {},
): SitemapFetcher {
  const resolve = options.resolve ?? resolvePublicAddress;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const request =
    options.request ??
    ((url: URL, address: ResolvedAddress, signal?: AbortSignal) =>
      defaultRequest(url, address, signal, bodyLimitBytes));

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Sitemap timeout must be a positive integer.");
  }
  if (!Number.isInteger(bodyLimitBytes) || bodyLimitBytes < 1) {
    throw new Error("Sitemap body limit must be a positive integer.");
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error("Sitemap redirect limit must be a non-negative integer.");
  }

  async function fetch(url: URL, signal?: AbortSignal): Promise<SitemapFetchResponse> {
    validateRequestUrl(url);
    const origin = url.origin;
    let current = new URL(url);
    let redirects = 0;

    for (;;) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      const address = await resolve(stripIpv6Brackets(current.hostname));
      if (!isPublicIpAddress(address.address)) {
        throw new Error("Refusing non-public Sitemap address.");
      }
      const response = await requestWithTimeout(request, current, address, timeoutMs, signal);
      if (Buffer.byteLength(response.body, "utf8") > bodyLimitBytes) {
        throw new Error("Sitemap response exceeded the 5 MiB body limit.");
      }

      if (!REDIRECT_STATUSES.has(response.status)) {
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Sitemap request failed with HTTP ${response.status}.`);
        }
        return { body: response.body, finalUrl: current };
      }

      if (redirects >= maxRedirects) {
        throw new Error("Sitemap redirect limit exceeded.");
      }
      if (!response.location) {
        throw new Error("Sitemap redirect did not include a location.");
      }

      const next = new URL(response.location, current);
      validateRequestUrl(next);
      if (next.origin !== origin) {
        throw new Error("Sitemap redirect must remain on the same origin.");
      }
      current = next;
      redirects += 1;
    }
  }

  return { fetch };
}
