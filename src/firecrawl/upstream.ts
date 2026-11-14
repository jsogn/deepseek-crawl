import type { GatewayConfig } from "../gateway/config.js";

const BLOCKED_REQUEST_HEADERS = new Set([
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

const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface FirecrawlUpstreamRequest {
  method: string;
  path: string;
  headers: Headers;
  body?: Uint8Array;
}

export interface FirecrawlUpstreamDependencies {
  config: GatewayConfig;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}

function upstreamHeaders(source: Headers, env: NodeJS.ProcessEnv): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!BLOCKED_REQUEST_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }

  const environmentKey = env.FIRECRAWL_API_KEY?.trim();
  if (environmentKey && !headers.has("authorization")) {
    if (/[\r\n]/.test(environmentKey)) {
      throw new Error("FIRECRAWL_API_KEY must not contain a newline.");
    }
    headers.set("authorization", `Bearer ${environmentKey}`);
  }
  return headers;
}

export function responseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  return headers;
}

export async function requestFirecrawlUpstream(
  input: FirecrawlUpstreamRequest,
  dependencies: FirecrawlUpstreamDependencies,
): Promise<Response> {
  const requestTarget = new URL(input.path, "http://gateway.local");
  const target = new URL(
    `${requestTarget.pathname}${requestTarget.search}`,
    dependencies.config.upstreamUrl,
  );
  const init: RequestInit = {
    method: input.method,
    headers: upstreamHeaders(input.headers, dependencies.env),
    redirect: "manual",
    signal: AbortSignal.timeout(dependencies.config.timeoutMs),
  };
  if (input.body !== undefined) {
    init.body = input.body;
  }
  return dependencies.fetchImpl(target, init);
}
