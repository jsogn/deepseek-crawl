import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { z } from "zod";
import type { MapSitemapReader } from "../application/map.js";
import { loadConfig } from "../config.js";
import { DeepSeekClient } from "../deepseek/client.js";
import { DeepSeekError } from "../deepseek/errors.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import {
  firecrawlMapFallback,
  firecrawlScrapeFallback,
  firecrawlSearchFallback,
} from "../firecrawl/compat.js";
import { requestFirecrawlUpstream, responseHeaders } from "../firecrawl/upstream.js";
import type { GatewayConfig } from "./config.js";
import { CrawlJobManager } from "./crawl-jobs.js";
import {
  GatewayInvalidRequestError,
  GatewayNotFoundError,
  UnsupportedFallbackFeatureError,
} from "./errors.js";

const HOP_BY_HOP_HEADERS = new Set([
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

export interface GatewayHandlerDependencies {
  config: GatewayConfig;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  deepseekClient?: DeepSeekGateway;
  sitemapReader?: MapSitemapReader;
  crawlJobs?: CrawlJobManager;
  now?: () => number;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json",
    "content-length": String(payload.byteLength),
  });
  response.end(payload);
}

function authorized(request: IncomingMessage, gatewayApiKey: string): boolean {
  const match = request.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  const supplied = match?.[1] ?? "";
  const expectedBytes = Buffer.from(gatewayApiKey);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.byteLength === suppliedBytes.byteLength &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

async function sendUpstream(response: ServerResponse, upstream: Response): Promise<void> {
  const headers = responseHeaders(upstream.headers);
  response.writeHead(upstream.status, Object.fromEntries(headers));
  if (!upstream.body) {
    response.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(upstream.body as unknown as NodeReadableStream), response);
  } catch {
    response.destroy();
  }
}

type FallbackRoute =
  | { kind: "search" }
  | { kind: "scrape" }
  | { kind: "map" }
  | { kind: "crawl-create" }
  | { kind: "crawl-status"; id: string }
  | { kind: "crawl-errors"; id: string }
  | { kind: "crawl-cancel"; id: string };

function fallbackRoute(method: string, pathname: string): FallbackRoute | undefined {
  if (method === "POST") {
    switch (pathname) {
      case "/v2/search":
        return { kind: "search" };
      case "/v2/scrape":
        return { kind: "scrape" };
      case "/v2/map":
        return { kind: "map" };
      case "/v2/crawl":
        return { kind: "crawl-create" };
    }
  }

  const crawlMatch = pathname.match(/^\/v2\/crawl\/([^/]+)(\/errors)?$/);
  if (!crawlMatch) {
    return undefined;
  }
  const id = decodeURIComponent(crawlMatch[1] ?? "");
  if (!id.startsWith("dsc_")) {
    return undefined;
  }
  if (method === "GET" && crawlMatch[2] === "/errors") {
    return { kind: "crawl-errors", id };
  }
  if (method === "GET" && crawlMatch[2] === undefined) {
    return { kind: "crawl-status", id };
  }
  if (method === "DELETE" && crawlMatch[2] === undefined) {
    return { kind: "crawl-cancel", id };
  }
  return undefined;
}

function hasAuthorization(request: IncomingMessage, env: NodeJS.ProcessEnv): boolean {
  return Boolean(request.headers.authorization || env.FIRECRAWL_API_KEY?.trim());
}

function parseJsonBody(body: Uint8Array | undefined): unknown {
  if (!body || body.byteLength === 0) {
    throw new GatewayInvalidRequestError("A JSON request body is required.");
  }
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new GatewayInvalidRequestError("The request body must contain valid JSON.");
  }
}

async function executeFallback(
  route: FallbackRoute,
  body: Uint8Array | undefined,
  client: () => DeepSeekGateway,
  reader: () => Promise<MapSitemapReader>,
  crawlJobs: CrawlJobManager,
): Promise<Record<string, unknown>> {
  switch (route.kind) {
    case "search":
      return firecrawlSearchFallback(parseJsonBody(body), client());
    case "scrape":
      return firecrawlScrapeFallback(parseJsonBody(body), client());
    case "map":
      return firecrawlMapFallback(parseJsonBody(body), client(), await reader());
    case "crawl-create":
      return crawlJobs.create(parseJsonBody(body), client(), await reader());
    case "crawl-status": {
      const status = crawlJobs.status(route.id);
      if (!status) {
        throw new GatewayNotFoundError(`Crawl job not found: ${route.id}`);
      }
      return status as unknown as Record<string, unknown>;
    }
    case "crawl-errors": {
      const errors = crawlJobs.errors(route.id);
      if (!errors) {
        throw new GatewayNotFoundError(`Crawl job not found: ${route.id}`);
      }
      return errors;
    }
    case "crawl-cancel": {
      if (crawlJobs.cancel(route.id)) {
        return { status: "cancelled" };
      }
      const status = crawlJobs.status(route.id);
      if (!status) {
        throw new GatewayNotFoundError(`Crawl job not found: ${route.id}`);
      }
      return { status: status.status };
    }
  }
}

function fallbackError(response: ServerResponse, error: unknown): void {
  if (error instanceof UnsupportedFallbackFeatureError) {
    sendJson(response, 400, {
      success: false,
      error: error.message,
      code: error.code,
    });
    return;
  }
  if (error instanceof GatewayNotFoundError) {
    sendJson(response, 404, {
      success: false,
      error: error.message,
      code: "not_found",
    });
    return;
  }
  if (error instanceof GatewayInvalidRequestError) {
    sendJson(response, 400, {
      success: false,
      error: error.message,
      code: error.code,
    });
    return;
  }
  if (error instanceof z.ZodError) {
    sendJson(response, 400, {
      success: false,
      error: error.issues.map((issue) => issue.message).join("; "),
      code: "invalid_request",
    });
    return;
  }
  if (error instanceof DeepSeekError) {
    sendJson(response, error.kind === "rate_limit" ? 429 : 502, {
      success: false,
      error: error.message,
      code: "deepseek_fallback_failed",
    });
    return;
  }
  sendJson(response, 502, {
    success: false,
    error: "DeepSeek fallback failed.",
    code: "deepseek_fallback_failed",
  });
}

async function readRequestBody(
  request: IncomingMessage,
  limit: number,
): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > limit) {
      throw new Error("request_too_large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function incomingHeaders(request: IncomingMessage, stripAuthorization: boolean): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    const normalizedName = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(normalizedName) ||
      (stripAuthorization && normalizedName === "authorization")
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

export function createGatewayHandler(
  dependencies: GatewayHandlerDependencies,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  let deepseekClient = dependencies.deepseekClient;
  let sitemapReader = dependencies.sitemapReader;
  const crawlJobs = dependencies.crawlJobs ?? new CrawlJobManager();
  let firecrawlExhaustedUntil = 0;
  const now = dependencies.now ?? Date.now;

  const resolveDeepSeekClient = (): DeepSeekGateway => {
    if (!deepseekClient) {
      deepseekClient = new DeepSeekClient({
        ...loadConfig(dependencies.env),
        fetchImpl: dependencies.fetchImpl,
      });
    }
    return deepseekClient;
  };

  const resolveSitemapReader = async (): Promise<MapSitemapReader> => {
    if (!sitemapReader) {
      const { SitemapReader } = await import("../sitemap/reader.js");
      sitemapReader = new SitemapReader();
    }
    return sitemapReader;
  };

  return async (request, response) => {
    if (
      dependencies.config.gatewayApiKey !== undefined &&
      !authorized(request, dependencies.config.gatewayApiKey)
    ) {
      request.resume();
      sendJson(
        response,
        401,
        {
          success: false,
          error: "Gateway authentication is required.",
          code: "unauthorized",
        },
        {
          "www-authenticate": 'Bearer realm="deepseek-crawl-gateway"',
        },
      );
      return;
    }

    let body: Uint8Array | undefined;
    try {
      body = await readRequestBody(request, dependencies.config.requestBodyLimit);
    } catch (error) {
      if (error instanceof Error && error.message === "request_too_large") {
        sendJson(response, 413, {
          success: false,
          error: "Firecrawl request body exceeds the gateway limit.",
          code: "request_too_large",
        });
        return;
      }
      throw error;
    }

    const requestUrl = new URL(request.url ?? "/", "http://gateway.local");
    const method = request.method ?? "GET";
    const route = fallbackRoute(method, requestUrl.pathname);
    const isLocalCrawlRoute =
      route?.kind === "crawl-status" ||
      route?.kind === "crawl-errors" ||
      route?.kind === "crawl-cancel";
    const shouldTryDeepSeekFirst =
      route !== undefined &&
      (isLocalCrawlRoute ||
        (dependencies.config.gatewayApiKey === undefined
          ? !hasAuthorization(request, dependencies.env)
          : !dependencies.env.FIRECRAWL_API_KEY?.trim()) ||
        now() < firecrawlExhaustedUntil);

    if (!shouldTryDeepSeekFirst) {
      try {
        const upstream = await requestFirecrawlUpstream(
          {
            method: request.method ?? "GET",
            path: request.url ?? "/",
            headers: incomingHeaders(request, dependencies.config.gatewayApiKey !== undefined),
            ...(body === undefined ? {} : { body }),
          },
          dependencies,
        );
        if (upstream.status === 402 && route !== undefined) {
          firecrawlExhaustedUntil = now() + 60_000;
          await upstream.body?.cancel().catch(() => undefined);
        } else {
          await sendUpstream(response, upstream);
          return;
        }
      } catch {
        sendJson(response, 502, {
          success: false,
          error: "Firecrawl upstream request failed.",
          code: "upstream_unavailable",
        });
        return;
      }
    }

    try {
      if (!route) {
        throw new UnsupportedFallbackFeatureError("This route has no DeepSeek fallback.");
      }
      const result = await executeFallback(
        route,
        body,
        resolveDeepSeekClient,
        resolveSitemapReader,
        crawlJobs,
      );
      sendJson(response, 200, result);
    } catch (error) {
      fallbackError(response, error);
    }
  };
}
