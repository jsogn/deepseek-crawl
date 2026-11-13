import { isIP } from "node:net";

export interface RuntimeConfig {
  apiKey: string;
  baseUrl: URL;
  timeoutMs: number;
  maxRetries: number;
}

function readInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
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

function parseBaseUrl(value: string | undefined): URL {
  const input = value?.trim() || "https://api.deepseek.com";
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("DEEPSEEK_BASE_URL must be a valid HTTP(S) URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("DEEPSEEK_BASE_URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("DEEPSEEK_BASE_URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("DEEPSEEK_BASE_URL must not contain a query string or fragment.");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("DEEPSEEK_BASE_URL must use HTTPS unless the host is loopback.");
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is required.");
  }
  if (/[\r\n]/.test(apiKey)) {
    throw new Error("DEEPSEEK_API_KEY must not contain a newline.");
  }

  return {
    apiKey,
    baseUrl: parseBaseUrl(env.DEEPSEEK_BASE_URL),
    timeoutMs: readInteger(env.DEEPSEEK_TIMEOUT_MS, 60000, "DEEPSEEK_TIMEOUT_MS", 1000, 120000),
    maxRetries: readInteger(env.DEEPSEEK_MAX_RETRIES, 2, "DEEPSEEK_MAX_RETRIES", 0, 5),
  };
}
