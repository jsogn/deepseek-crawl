import { isIP } from "node:net";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_UPSTREAM_URL = "https://api.firecrawl.dev";
const DEFAULT_REQUEST_BODY_LIMIT = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface GatewayConfig {
  host: string;
  port: number;
  allowRemote: boolean;
  gatewayApiKey?: string;
  upstreamUrl: URL;
  requestBodyLimit: number;
  timeoutMs: number;
}

export interface GatewayConfigInput {
  host?: string;
  port?: number;
  allowRemote?: boolean;
  env?: NodeJS.ProcessEnv;
}

function isLoopbackHostname(hostname: string): boolean {
  const value =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (value === "localhost") {
    return true;
  }

  const version = isIP(value);
  if (version === 4) {
    return value.startsWith("127.");
  }
  if (version === 6) {
    return value === "::1" || value === "0:0:0:0:0:0:0:1";
  }
  return false;
}

function parseUpstreamUrl(value: string | undefined): URL {
  const input = value?.trim() || DEFAULT_UPSTREAM_URL;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("FIRECRAWL_UPSTREAM_URL must be a valid HTTP(S) URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("FIRECRAWL_UPSTREAM_URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("FIRECRAWL_UPSTREAM_URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("FIRECRAWL_UPSTREAM_URL must not contain a query string or fragment.");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("FIRECRAWL_UPSTREAM_URL must use HTTPS unless the host is loopback.");
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url;
}

function validateHost(host: string, allowRemote: boolean): string {
  const value = host.trim();
  if (!value) {
    throw new Error("Gateway host is required.");
  }
  if (!allowRemote && !isLoopbackHostname(value)) {
    throw new Error("A non-loopback gateway host requires --allow-remote.");
  }
  return value;
}

function validatePort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Gateway port must be an integer from 1 to 65535.");
  }
  return port;
}

function parseGatewayApiKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  if (!key) {
    return undefined;
  }
  if (/[\r\n]/.test(key)) {
    throw new Error("GATEWAY_API_KEY must not contain a newline.");
  }
  return key;
}

export function loadGatewayConfig(options: GatewayConfigInput = {}): GatewayConfig {
  const env = options.env ?? process.env;
  const allowRemote = options.allowRemote ?? false;
  const host = validateHost(options.host ?? DEFAULT_HOST, allowRemote);
  const gatewayApiKey = parseGatewayApiKey(env.GATEWAY_API_KEY);
  if (!isLoopbackHostname(host) && !gatewayApiKey) {
    throw new Error("GATEWAY_API_KEY is required for a non-loopback gateway host.");
  }
  return {
    host,
    port: validatePort(options.port ?? DEFAULT_PORT),
    allowRemote,
    ...(gatewayApiKey === undefined ? {} : { gatewayApiKey }),
    upstreamUrl: parseUpstreamUrl(env.FIRECRAWL_UPSTREAM_URL),
    requestBodyLimit: DEFAULT_REQUEST_BODY_LIMIT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}
