import type { GatewayConfig } from "./config.js";

export const DEFAULT_KEYLESS_COOLDOWN_MS = 15 * 60_000;

const KEYLESS_EXACT_ROUTES = new Set([
  "POST /v2/scrape",
  "POST /v2/search",
  "POST /v2/parse",
  "POST /v2/parse/upload-url",
  "POST /v1/scrape",
  "POST /v1/search",
  "POST /v2/search/developer",
  "POST /v2/search/research",
  "POST /v2/search/government",
  "POST /v2/search/gov",
]);

const KEYLESS_INTERACT_ROUTE = /^\/v2\/scrape\/[^/]+\/interact$/;

export function isKeylessEnabled(
  config: Pick<GatewayConfig, "allowRemote" | "providerMode">,
): boolean {
  return !config.allowRemote && (config.providerMode ?? "firecrawl-first") === "firecrawl-first";
}

export function isKeylessRoute(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();
  const route = `${normalizedMethod} ${pathname}`;
  if (KEYLESS_EXACT_ROUTES.has(route)) {
    return true;
  }
  return (
    (normalizedMethod === "POST" || normalizedMethod === "DELETE") &&
    KEYLESS_INTERACT_ROUTE.test(pathname)
  );
}

export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (/^\d+$/.test(normalized)) {
    return Number(normalized) * 1000;
  }
  if (/^-\d+$/.test(normalized)) {
    return undefined;
  }
  const deadline = Date.parse(normalized);
  return Number.isFinite(deadline) ? Math.max(0, deadline - nowMs) : undefined;
}

export class KeylessCooldown {
  #untilMs = 0;

  block(nowMs: number, retryAfter: string | null): void {
    const delayMs = parseRetryAfter(retryAfter, nowMs) ?? DEFAULT_KEYLESS_COOLDOWN_MS;
    this.#untilMs = nowMs + delayMs;
  }

  remainingMs(nowMs: number): number {
    return Math.max(0, this.#untilMs - nowMs);
  }

  retryAfterSeconds(nowMs: number): number {
    return Math.ceil(this.remainingMs(nowMs) / 1000);
  }
}
