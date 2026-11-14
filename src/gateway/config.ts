import { isIP } from "node:net";
import {
  type CredentialName,
  type CredentialStore,
  createCredentialStore,
} from "../credentials/store.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_UPSTREAM_URL = "https://api.firecrawl.dev";
const DEFAULT_REQUEST_BODY_LIMIT = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CREDITS_COOLDOWN_MS = 60_000;
const MAX_CREDITS_COOLDOWN_MS = 3_600_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 100;
const DEFAULT_MAX_CONCURRENT_PROVIDER_REQUESTS = 100;
const DEFAULT_MAX_ACTIVE_CRAWL_JOBS = 10;
const DEFAULT_MAX_RETAINED_CRAWL_JOBS = 100;
const MAX_CAPACITY = 1_000;
export type GatewayProviderMode = "firecrawl-first" | "deepseek-first" | "no-fallback";
const DEFAULT_PROVIDER_MODE: GatewayProviderMode = "firecrawl-first";
const PROVIDER_MODES = new Set<GatewayProviderMode>([
  "firecrawl-first",
  "deepseek-first",
  "no-fallback",
]);

export interface GatewayConfig {
  host: string;
  port: number;
  allowRemote: boolean;
  autoPort?: boolean;
  providerMode?: GatewayProviderMode;
  creditsCooldownMs?: number;
  gatewayApiKey?: string;
  firecrawlApiKey?: string;
  authFailureLimit?: number;
  authFailureWindowMs?: number;
  authBlockMs?: number;
  maxConcurrentRequests?: number;
  maxConcurrentProviderRequests?: number;
  maxActiveCrawlJobs?: number;
  maxRetainedCrawlJobs?: number;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  upstreamUrl: URL;
  requestBodyLimit: number;
  timeoutMs: number;
}

export interface GatewayConfigInput {
  host?: string;
  port?: number;
  remote?: boolean;
  allowRemote?: boolean;
  providerMode?: GatewayProviderMode;
  creditsCooldownMs?: number;
  maxConcurrentRequests?: number;
  maxConcurrentProviderRequests?: number;
  maxActiveCrawlJobs?: number;
  maxRetainedCrawlJobs?: number;
  env?: NodeJS.ProcessEnv;
  credentialStores?: Partial<Record<CredentialName, CredentialStore>>;
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

function validateHost(host: string, remote: boolean): string {
  const value = host.trim();
  if (!value) {
    throw new Error("Gateway host is required.");
  }
  if (!remote && !isLoopbackHostname(value)) {
    throw new Error("A non-loopback gateway host requires --remote.");
  }
  return value;
}

function validatePort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Gateway port must be an integer from 1 to 65535.");
  }
  return port;
}

function validateApiKey(value: string, name: string): string {
  const key = value.trim();
  if (!key) {
    throw new Error(`${name} must not be empty.`);
  }
  if (/[\r\n]/.test(key)) {
    throw new Error(`${name} must not contain a newline.`);
  }
  return key;
}

function parseProviderMode(value: string | undefined): GatewayProviderMode {
  const mode = value?.trim() || DEFAULT_PROVIDER_MODE;
  if (!PROVIDER_MODES.has(mode as GatewayProviderMode)) {
    throw new Error(
      "Gateway provider mode must be firecrawl-first, deepseek-first, or no-fallback.",
    );
  }
  return mode as GatewayProviderMode;
}

function parseCreditsCooldown(value: string | undefined): number {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") {
    return DEFAULT_CREDITS_COOLDOWN_MS;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new Error("Gateway credits cooldown must be an integer from 0 to 3600 seconds.");
  }
  const seconds = Number(normalized);
  if (!Number.isSafeInteger(seconds) || seconds > 3_600) {
    throw new Error("Gateway credits cooldown must be an integer from 0 to 3600 seconds.");
  }
  return seconds * 1000;
}

function validateCreditsCooldown(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CREDITS_COOLDOWN_MS) {
    throw new Error("Gateway credits cooldown must be an integer from 0 to 3600 seconds.");
  }
  return value;
}

function parseCapacity(value: string | number | undefined, name: string, fallback: number): number {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) {
    return fallback;
  }
  const parsed =
    typeof value === "number"
      ? value
      : /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CAPACITY) {
    throw new Error(`${name} must be an integer from 1 to ${MAX_CAPACITY}.`);
  }
  return parsed;
}

const CREDENTIAL_ENV: Record<CredentialName, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  gateway: "GATEWAY_API_KEY",
};

function resolveCredential(
  env: NodeJS.ProcessEnv,
  credential: CredentialName,
  stores: GatewayConfigInput["credentialStores"],
): string | undefined {
  const environmentName = CREDENTIAL_ENV[credential];
  const environmentValue = env[environmentName];
  if (environmentValue !== undefined && environmentValue.trim() !== "") {
    return validateApiKey(environmentValue, environmentName);
  }
  const store =
    stores !== undefined ? stores[credential] : createCredentialStore({ env, credential });
  return store?.get()?.trim() || undefined;
}

export function loadGatewayConfig(options: GatewayConfigInput = {}): GatewayConfig {
  const env = options.env ?? process.env;
  const providerMode = parseProviderMode(
    options.providerMode ?? env.DEEPSEEK_GATEWAY_PROVIDER_MODE,
  );
  const creditsCooldownMs = validateCreditsCooldown(
    options.creditsCooldownMs ??
      parseCreditsCooldown(env.DEEPSEEK_GATEWAY_CREDITS_COOLDOWN_SECONDS),
  );
  const maxConcurrentRequests = parseCapacity(
    options.maxConcurrentRequests ?? env.DEEPSEEK_GATEWAY_MAX_CONCURRENT_REQUESTS,
    "Gateway maximum concurrent requests",
    DEFAULT_MAX_CONCURRENT_REQUESTS,
  );
  const maxConcurrentProviderRequests = parseCapacity(
    options.maxConcurrentProviderRequests ?? env.DEEPSEEK_GATEWAY_MAX_PROVIDER_REQUESTS,
    "Gateway maximum concurrent provider requests",
    DEFAULT_MAX_CONCURRENT_PROVIDER_REQUESTS,
  );
  const maxActiveCrawlJobs = parseCapacity(
    options.maxActiveCrawlJobs ?? env.DEEPSEEK_GATEWAY_MAX_CRAWL_JOBS,
    "Gateway maximum active Crawl jobs",
    DEFAULT_MAX_ACTIVE_CRAWL_JOBS,
  );
  const maxRetainedCrawlJobs = parseCapacity(
    options.maxRetainedCrawlJobs ?? env.DEEPSEEK_GATEWAY_MAX_RETAINED_CRAWL_JOBS,
    "Gateway maximum retained Crawl jobs",
    DEFAULT_MAX_RETAINED_CRAWL_JOBS,
  );
  const remote = options.remote ?? options.allowRemote ?? false;
  const host = validateHost(options.host?.trim() || (remote ? "0.0.0.0" : DEFAULT_HOST), remote);
  const gatewayApiKey = resolveCredential(env, "gateway", options.credentialStores);
  const firecrawlApiKey = resolveCredential(env, "firecrawl", options.credentialStores);
  if ((remote || !isLoopbackHostname(host)) && !gatewayApiKey) {
    throw new Error("GATEWAY_API_KEY is required for a non-loopback gateway host.");
  }
  const port = validatePort(options.port ?? DEFAULT_PORT);
  return {
    host,
    port,
    allowRemote: remote || !isLoopbackHostname(host),
    autoPort: !remote && options.port === undefined,
    providerMode,
    creditsCooldownMs,
    maxConcurrentRequests,
    maxConcurrentProviderRequests,
    maxActiveCrawlJobs,
    maxRetainedCrawlJobs,
    ...(gatewayApiKey === undefined ? {} : { gatewayApiKey }),
    ...(firecrawlApiKey === undefined ? {} : { firecrawlApiKey }),
    upstreamUrl: parseUpstreamUrl(env.FIRECRAWL_UPSTREAM_URL),
    requestBodyLimit: DEFAULT_REQUEST_BODY_LIMIT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}
