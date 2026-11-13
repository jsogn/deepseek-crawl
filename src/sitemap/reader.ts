import http from "node:http";
import https from "node:https";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { normalizeHttpUrl, sameOrigin } from "../crawl/links.js";
import type { MapWarning } from "../crawl/types.js";
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

export interface SitemapReaderOptions {
  fetcher?: SitemapFetcher;
}

export interface SitemapReadOptions {
  maxDocuments: number;
  maxCandidates: number;
}

export interface SitemapDiscovery {
  urls: URL[];
  warnings: MapWarning[];
  truncated: boolean;
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

interface ParsedSitemap {
  kind: "urlset" | "sitemapindex";
  locations: string[];
}

const sitemapParser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => name === "url" || name === "sitemap",
});

function warning(code: MapWarning["code"], message: string): MapWarning {
  return { code, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function locationsFrom(entries: unknown[]): string[] {
  const locations: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || !("loc" in entry)) {
      continue;
    }
    const location = (entry as { loc?: unknown }).loc;
    if (typeof location === "string" && location.trim()) {
      locations.push(location.trim());
    }
  }
  return locations;
}

function parseSitemap(body: string): ParsedSitemap {
  if (XMLValidator.validate(body) !== true) {
    throw new Error("Sitemap is not valid XML.");
  }

  const parsed = sitemapParser.parse(body) as Record<string, unknown>;
  const urlset = parsed.urlset;
  if (typeof urlset === "object" && urlset !== null) {
    return {
      kind: "urlset",
      locations: locationsFrom(asArray((urlset as Record<string, unknown>).url)),
    };
  }

  const sitemapindex = parsed.sitemapindex;
  if (typeof sitemapindex === "object" && sitemapindex !== null) {
    return {
      kind: "sitemapindex",
      locations: locationsFrom(asArray((sitemapindex as Record<string, unknown>).sitemap)),
    };
  }

  throw new Error("Sitemap root element is not urlset or sitemapindex.");
}

function validateReadOptions(options: SitemapReadOptions): void {
  if (!Number.isInteger(options.maxDocuments) || options.maxDocuments < 1) {
    throw new Error("maxDocuments must be a positive integer.");
  }
  if (!Number.isInteger(options.maxCandidates) || options.maxCandidates < 1) {
    throw new Error("maxCandidates must be a positive integer.");
  }
}

export class SitemapReader {
  readonly #fetcher: SitemapFetcher;

  constructor(options: SitemapReaderOptions = {}) {
    this.#fetcher = options.fetcher ?? createPublicSitemapFetcher();
  }

  async read(
    seedUrl: URL,
    options: SitemapReadOptions,
    signal?: AbortSignal,
  ): Promise<SitemapDiscovery> {
    validateReadOptions(options);
    if (!["http:", "https:"].includes(seedUrl.protocol) || !seedUrl.hostname) {
      throw new Error("Seed URL must use HTTP or HTTPS.");
    }
    if (signal?.aborted) {
      throw abortReason(signal);
    }

    const root = new URL("/sitemap.xml", seedUrl.origin);
    const queue = [root];
    const seenDocuments = new Set([root.href]);
    const urls = new Map<string, URL>();
    const warnings: MapWarning[] = [];
    let documentsRead = 0;
    let truncated = false;
    let candidateLimitWarningAdded = false;

    while (queue.length > 0 && documentsRead < options.maxDocuments) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      const documentUrl = queue.shift();
      if (!documentUrl) {
        break;
      }
      documentsRead += 1;

      let fetched: SitemapFetchResponse;
      try {
        fetched = await this.#fetcher.fetch(documentUrl, signal);
      } catch (error) {
        if (signal?.aborted) {
          throw abortReason(signal);
        }
        warnings.push(
          warning(
            "sitemap_unavailable",
            `Could not read Sitemap ${documentUrl.href}: ${errorMessage(error)}`,
          ),
        );
        continue;
      }

      let parsed: ParsedSitemap;
      try {
        parsed = parseSitemap(fetched.body);
      } catch (error) {
        warnings.push(
          warning(
            "sitemap_invalid",
            `Could not parse Sitemap ${fetched.finalUrl.href}: ${errorMessage(error)}`,
          ),
        );
        continue;
      }

      if (parsed.kind === "urlset") {
        for (const location of parsed.locations) {
          const url = normalizeHttpUrl(location, fetched.finalUrl);
          if (!url || !sameOrigin(url, seedUrl)) {
            continue;
          }
          if (urls.has(url.href)) {
            continue;
          }
          if (urls.size >= options.maxCandidates) {
            truncated = true;
            if (!candidateLimitWarningAdded) {
              candidateLimitWarningAdded = true;
              warnings.push(
                warning(
                  "sitemap_limit_reached",
                  `Sitemap candidate limit of ${options.maxCandidates} was reached.`,
                ),
              );
            }
            break;
          }
          urls.set(url.href, url);
        }
      } else {
        for (const location of parsed.locations) {
          const url = normalizeHttpUrl(location, fetched.finalUrl);
          if (!url || !sameOrigin(url, seedUrl) || seenDocuments.has(url.href)) {
            continue;
          }
          seenDocuments.add(url.href);
          queue.push(url);
        }
      }
    }

    if (queue.length > 0) {
      truncated = true;
      warnings.push(
        warning(
          "sitemap_limit_reached",
          `Sitemap document limit of ${options.maxDocuments} was reached.`,
        ),
      );
    }

    return {
      urls: [...urls.values()].sort((left, right) =>
        left.href < right.href ? -1 : left.href > right.href ? 1 : 0,
      ),
      warnings,
      truncated,
    };
  }
}
