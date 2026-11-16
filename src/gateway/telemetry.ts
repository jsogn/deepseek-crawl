import { randomUUID } from "node:crypto";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface GatewayRequestLog {
  event: "gateway_request";
  request_id: string;
  method: string;
  route: string;
  status: number;
  duration_ms: number;
  provider: "firecrawl" | "firecrawl-keyless" | "deepseek" | "pagesift" | "gateway" | "none";
  fallback: boolean;
  fallback_reason?: string;
}

export type GatewayLogger = (event: GatewayRequestLog) => void;

export interface GatewayMetricsSnapshot {
  requests_total: number;
  firecrawl_requests: number;
  firecrawl_keyless_requests: number;
  deepseek_requests: number;
  pagesift_requests: number;
  none_requests: number;
  fallback_requests: number;
  client_errors: number;
  server_errors: number;
  last_fallback_reason: string | null;
}

export class GatewayMetrics {
  #requestsTotal = 0;
  #firecrawlRequests = 0;
  #firecrawlKeylessRequests = 0;
  #deepseekRequests = 0;
  #pagesiftRequests = 0;
  #noneRequests = 0;
  #fallbackRequests = 0;
  #clientErrors = 0;
  #serverErrors = 0;
  #lastFallbackReason: string | null = null;

  record(
    event: Pick<GatewayRequestLog, "status" | "provider" | "fallback" | "fallback_reason">,
  ): void {
    if (event.provider === "gateway") {
      return;
    }
    this.#requestsTotal += 1;
    switch (event.provider) {
      case "firecrawl":
        this.#firecrawlRequests += 1;
        break;
      case "firecrawl-keyless":
        this.#firecrawlKeylessRequests += 1;
        break;
      case "deepseek":
        this.#deepseekRequests += 1;
        break;
      case "pagesift":
        this.#pagesiftRequests += 1;
        break;
      case "none":
        this.#noneRequests += 1;
        break;
    }
    if (event.fallback) {
      this.#fallbackRequests += 1;
      if (event.fallback_reason !== undefined) {
        this.#lastFallbackReason = event.fallback_reason;
      }
    }
    if (event.status >= 500) {
      this.#serverErrors += 1;
    } else if (event.status >= 400) {
      this.#clientErrors += 1;
    }
  }

  snapshot(): GatewayMetricsSnapshot {
    return {
      requests_total: this.#requestsTotal,
      firecrawl_requests: this.#firecrawlRequests,
      firecrawl_keyless_requests: this.#firecrawlKeylessRequests,
      deepseek_requests: this.#deepseekRequests,
      pagesift_requests: this.#pagesiftRequests,
      none_requests: this.#noneRequests,
      fallback_requests: this.#fallbackRequests,
      client_errors: this.#clientErrors,
      server_errors: this.#serverErrors,
      last_fallback_reason: this.#lastFallbackReason,
    };
  }
}

export function parseGatewayMetrics(value: unknown): GatewayMetricsSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const keys = [
    "requests_total",
    "firecrawl_requests",
    "firecrawl_keyless_requests",
    "deepseek_requests",
    "pagesift_requests",
    "none_requests",
    "fallback_requests",
    "client_errors",
    "server_errors",
  ] as const;
  if (
    keys.some((key) => !Number.isSafeInteger(candidate[key]) || (candidate[key] as number) < 0) ||
    !(candidate.last_fallback_reason === null || typeof candidate.last_fallback_reason === "string")
  ) {
    return undefined;
  }
  return {
    requests_total: candidate.requests_total as number,
    firecrawl_requests: candidate.firecrawl_requests as number,
    firecrawl_keyless_requests: candidate.firecrawl_keyless_requests as number,
    deepseek_requests: candidate.deepseek_requests as number,
    pagesift_requests: candidate.pagesift_requests as number,
    none_requests: candidate.none_requests as number,
    fallback_requests: candidate.fallback_requests as number,
    client_errors: candidate.client_errors as number,
    server_errors: candidate.server_errors as number,
    last_fallback_reason: candidate.last_fallback_reason,
  };
}

export function gatewayRequestId(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

export function normalizeGatewayRoute(pathname: string): string {
  if (["/v2/search", "/v2/scrape", "/v2/map", "/v2/crawl", "/healthz"].includes(pathname)) {
    return pathname;
  }
  if (/^\/v2\/crawl\/[^/]+\/errors$/.test(pathname)) {
    return "/v2/crawl/:id/errors";
  }
  if (/^\/v2\/scrape\/[^/]+\/interact$/.test(pathname)) {
    return "/v2/scrape/:id/interact";
  }
  if (/^\/v2\/crawl\/[^/]+$/.test(pathname)) {
    return "/v2/crawl/:id";
  }
  return pathname.startsWith("/v2/") ? "/v2/*" : "other";
}
