import { randomUUID } from "node:crypto";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface GatewayRequestLog {
  event: "gateway_request";
  request_id: string;
  method: string;
  route: string;
  status: number;
  duration_ms: number;
  provider: "firecrawl" | "deepseek" | "gateway" | "none";
  fallback: boolean;
  fallback_reason?: string;
}

export type GatewayLogger = (event: GatewayRequestLog) => void;

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
  if (/^\/v2\/crawl\/[^/]+$/.test(pathname)) {
    return "/v2/crawl/:id";
  }
  return pathname.startsWith("/v2/") ? "/v2/*" : "other";
}
