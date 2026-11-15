#!/usr/bin/env node

const TARGET_URL = "https://example.com/";
const UPSTREAM_ORIGIN = "https://api.firecrawl.dev";
const REQUEST_TIMEOUT_MS = 90_000;

function usage() {
  return `Usage: npm run test:live:keyless

Runs one Keyless Scrape through a temporary loopback Gateway. The request uses
Firecrawl's free no-API-key tier and consumes a small amount of the public-IP
daily quota. It does not consume Firecrawl credits or call DeepSeek.

Direct script usage requires --confirm:
  node scripts/live-keyless-smoke.mjs --help
  node scripts/live-keyless-smoke.mjs --confirm
`;
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function boundedBody(body) {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length <= 1_000 ? compact : `${compact.slice(0, 1_000)}...`;
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(usage());
  process.exit(0);
}
if (args.length !== 1 || args[0] !== "--confirm") {
  console.error("Keyless live smoke requires explicit --confirm.");
  console.error(usage());
  process.exit(2);
}

let server;
try {
  const { startGatewayServer } = await import("../dist/index.js");
  let upstreamRequests = 0;
  let upstreamAuthorization = "unset";

  server = await startGatewayServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      allowRemote: false,
      providerMode: "firecrawl-first",
      upstreamUrl: new URL(`${UPSTREAM_ORIGIN}/`),
      requestBodyLimit: 1024 * 1024,
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
    env: {},
    fetchImpl: async (input, init) => {
      upstreamRequests += 1;
      upstreamAuthorization = new Headers(init?.headers).get("authorization");
      return fetch(input, init);
    },
    deepseekClient: {
      async search() {
        throw new Error("DeepSeek Search must not run during Keyless smoke.");
      },
      async fetch() {
        throw new Error("DeepSeek Fetch must not run during Keyless smoke.");
      },
    },
  });

  console.error("Keyless request: running one free Firecrawl Scrape using the public-IP quota.");
  const response = await fetch(new URL("v2/scrape", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: TARGET_URL,
      formats: ["markdown"],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(
      `Keyless Scrape returned non-JSON HTTP ${response.status}: ${boundedBody(body)}`,
    );
  }

  if (response.status === 429) {
    throw new Error(`Keyless Scrape hit the per-IP daily limit: ${boundedBody(body)}`);
  }
  if (response.status !== 200 || payload?.success !== true) {
    throw new Error(`Keyless Scrape failed with HTTP ${response.status}: ${boundedBody(body)}`);
  }
  if (typeof payload?.data?.markdown !== "string" || !payload.data.markdown.trim()) {
    throw new Error("Keyless Scrape returned no Markdown.");
  }
  if (upstreamRequests !== 1) {
    throw new Error(`Expected exactly one upstream request; observed ${upstreamRequests}.`);
  }
  if (upstreamAuthorization !== null) {
    throw new Error("Keyless Scrape unexpectedly sent an Authorization header.");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        operation: "keyless-scrape",
        upstream: UPSTREAM_ORIGIN,
        upstream_requests: upstreamRequests,
        upstream_authorization: "absent",
        markdown_characters: payload.data.markdown.length,
      },
      null,
      2,
    ),
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (server) {
    await server.close().catch(() => undefined);
  }
}
