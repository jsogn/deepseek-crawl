import { isIP } from "node:net";
import { createCredentialStore, type CredentialStore } from "./credentials/store.js";

export type CredentialSource = "environment" | "keychain" | "file";

export interface ResolvedCredential {
  apiKey: string;
  source: CredentialSource;
}

export interface RuntimeConfig {
  apiKey: string;
  credentialSource: CredentialSource;
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

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  store?: CredentialStore,
): RuntimeConfig {
  const credential = resolveCredential(env, store);

  return {
    apiKey: credential.apiKey,
    credentialSource: credential.source,
    baseUrl: parseBaseUrl(env.DEEPSEEK_BASE_URL),
    timeoutMs: readInteger(env.DEEPSEEK_TIMEOUT_MS, 60000, "DEEPSEEK_TIMEOUT_MS", 1000, 120000),
    maxRetries: readInteger(env.DEEPSEEK_MAX_RETRIES, 2, "DEEPSEEK_MAX_RETRIES", 0, 5),
  };
}

export function resolveCredential(
  env: NodeJS.ProcessEnv,
  store?: CredentialStore,
): ResolvedCredential {
  const environmentKey = env.DEEPSEEK_API_KEY?.trim();
  if (environmentKey) {
    if (/[\r\n]/.test(environmentKey)) {
      throw new Error("DEEPSEEK_API_KEY must not contain a newline.");
    }
    return { apiKey: environmentKey, source: "environment" };
  }

  const credentialStore = store ?? createCredentialStore({ env });
  const storedKey = credentialStore.get()?.trim();
  if (!storedKey) {
    throw new Error(
      "DeepSeek API key is required. Run deepseek-crawl auth set or set DEEPSEEK_API_KEY.",
    );
  }
  if (/[\r\n]/.test(storedKey)) {
    throw new Error("Stored DeepSeek API key must not contain a newline.");
  }
  return { apiKey: storedKey, source: credentialStore.name };
}
