#!/usr/bin/env node

import { Firecrawl } from "firecrawl";
import { loadConfig } from "../dist/config.js";
import {
  createCredentialStore,
  DeepSeekClient,
  loadGatewayConfig,
  startGatewayServer,
} from "../dist/index.js";

const TARGET_URL = "https://example.com/";
const SEARCH_QUERY = "Example Domain";
const GATEWAY_TOKEN = "live-smoke-gateway-token";
const OPERATION_TIMEOUT_MS = 60_000;
const CRAWL_TIMEOUT_MS = 120_000;

function usage() {
  return `Usage: npm run test:live:gateway -- --billable [--matrix] [--crawl]

Runs two billable example.com Scrapes through the official Firecrawl SDK: one
Firecrawl passthrough and one DeepSeek fallback.

Options:
  --billable   Confirm billable provider requests.
  --matrix     Add Search and Map for both providers. This runs six billable
               operations in total; DeepSeek Map reads the seed page.
  --crawl      Add one minimal Crawl for both providers. Crawl uses limit=1,
               maxDiscoveryDepth=0, and skips Sitemap discovery.
  -h, --help   Show this help without reading credentials.
`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, label, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForRequestEvent(events, expectedProvider, route) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const event = events.find(
      (candidate) =>
        candidate.event === "gateway_request" &&
        candidate.route === route &&
        candidate.provider === expectedProvider,
    );
    if (event) {
      return event;
    }
    await delay(25);
  }
  throw new Error(`Gateway did not log the ${expectedProvider} ${route} request.`);
}

function staticStore(apiKey) {
  return {
    name: "keychain",
    get: () => apiKey,
    set: () => undefined,
    remove: () => undefined,
  };
}

function requireCredential(env, credential, command) {
  const environmentName = credential === "firecrawl" ? "FIRECRAWL_API_KEY" : "DEEPSEEK_API_KEY";
  const environmentValue = env[environmentName]?.trim();
  if (environmentValue) {
    return environmentValue;
  }
  const stored = createCredentialStore({ env, credential }).get()?.trim();
  if (!stored) {
    throw new Error(`${environmentName} is missing. Run ${command}.`);
  }
  return stored;
}

function validateProviderEvent(events, expectedProvider, route, expectedFallbackReason) {
  return waitForRequestEvent(events, expectedProvider, route).then((event) => {
    if (event.status !== 200) {
      throw new Error(`${expectedProvider} ${route} returned status ${event.status}.`);
    }
    if (expectedFallbackReason === undefined) {
      if (event.fallback) {
        throw new Error(`${expectedProvider} ${route} unexpectedly used fallback.`);
      }
    } else if (!event.fallback || event.fallback_reason !== expectedFallbackReason) {
      throw new Error(`Unexpected fallback metadata: ${JSON.stringify(event)}`);
    }
    return {
      provider: event.provider,
      fallback: event.fallback,
      fallback_reason: event.fallback_reason ?? null,
      status: event.status,
      request_id: event.request_id,
    };
  });
}

async function runScrape(client, events, expectedProvider, expectedFallbackReason) {
  const result = await withTimeout(
    client.scrape(TARGET_URL, { formats: ["markdown"] }),
    `${expectedProvider} Scrape`,
    OPERATION_TIMEOUT_MS,
  );
  if (typeof result.markdown !== "string" || !result.markdown.trim()) {
    throw new Error(`${expectedProvider} Scrape returned no Markdown.`);
  }
  return {
    ...(await validateProviderEvent(
      events,
      expectedProvider,
      "/v2/scrape",
      expectedFallbackReason,
    )),
    markdown_characters: result.markdown.length,
  };
}

async function runSearch(client, events, expectedProvider, expectedFallbackReason) {
  const result = await withTimeout(
    client.search(SEARCH_QUERY, { limit: 1 }),
    `${expectedProvider} Search`,
    OPERATION_TIMEOUT_MS,
  );
  if (!Array.isArray(result.web) || result.web.length === 0) {
    throw new Error(`${expectedProvider} Search returned no web results.`);
  }
  return {
    ...(await validateProviderEvent(
      events,
      expectedProvider,
      "/v2/search",
      expectedFallbackReason,
    )),
    result_count: result.web.length,
  };
}

async function runMap(client, events, expectedProvider, expectedFallbackReason) {
  const result = await withTimeout(
    client.map(TARGET_URL, { limit: 1 }),
    `${expectedProvider} Map`,
    OPERATION_TIMEOUT_MS,
  );
  if (!Array.isArray(result.links) || result.links.length === 0) {
    throw new Error(`${expectedProvider} Map returned no links.`);
  }
  return {
    ...(await validateProviderEvent(events, expectedProvider, "/v2/map", expectedFallbackReason)),
    link_count: result.links.length,
  };
}

async function pollCrawlStatus(client, id, expectedProvider) {
  const deadline = Date.now() + CRAWL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await client.getCrawlStatus(id);
    if (status.status !== "scraping") {
      return status;
    }
    await delay(250);
  }
  throw new Error(`${expectedProvider} Crawl did not reach a terminal status.`);
}

async function runCrawl(client, events, expectedProvider, expectedFallbackReason) {
  const started = await withTimeout(
    client.startCrawl(TARGET_URL, {
      limit: 1,
      maxDiscoveryDepth: 0,
      sitemap: "skip",
    }),
    `${expectedProvider} Crawl create`,
    OPERATION_TIMEOUT_MS,
  );
  if (!started.id) {
    throw new Error(`${expectedProvider} Crawl returned no job ID.`);
  }
  const created = await validateProviderEvent(
    events,
    expectedProvider,
    "/v2/crawl",
    expectedFallbackReason,
  );
  const status = await pollCrawlStatus(client, started.id, expectedProvider);
  if (status.status !== "completed") {
    throw new Error(`${expectedProvider} Crawl ended with status ${status.status}.`);
  }
  if (!Array.isArray(status.data) || status.data.length === 0) {
    throw new Error(`${expectedProvider} Crawl returned no pages.`);
  }
  const statusEvent = await validateProviderEvent(
    events,
    expectedProvider,
    "/v2/crawl/:id",
    expectedFallbackReason === undefined ? undefined : "local_crawl_job",
  );
  const errors = await withTimeout(
    client.getCrawlErrors(started.id),
    `${expectedProvider} Crawl errors`,
    OPERATION_TIMEOUT_MS,
  );
  if (errors.errors.length !== 0 || errors.robotsBlocked.length !== 0) {
    throw new Error(`${expectedProvider} Crawl reported errors.`);
  }

  return {
    ...created,
    crawl_status: status.status,
    page_count: status.data.length,
    status_request_id: statusEvent.request_id,
    page_error_count: errors.errors.length,
    robots_blocked_count: errors.robotsBlocked.length,
  };
}

async function runProviderSmoke(server, events, expectedProvider, expectedFallbackReason, options) {
  const client = new Firecrawl({
    apiKey: GATEWAY_TOKEN,
    apiUrl: server.url.href.replace(/\/$/, ""),
  });
  if (!options.matrix && !options.crawl) {
    return runScrape(client, events, expectedProvider, expectedFallbackReason);
  }
  const summary = options.matrix
    ? {
        search: await runSearch(client, events, expectedProvider, expectedFallbackReason),
        map: await runMap(client, events, expectedProvider, expectedFallbackReason),
        scrape: await runScrape(client, events, expectedProvider, expectedFallbackReason),
      }
    : {
        scrape: await runScrape(client, events, expectedProvider, expectedFallbackReason),
      };
  if (options.crawl) {
    summary.crawl = await runCrawl(client, events, expectedProvider, expectedFallbackReason);
  }
  return summary;
}

async function startSmokeGateway({ firecrawlApiKey, deepseekClient }) {
  const events = [];
  const env = { ...process.env };
  delete env.FIRECRAWL_API_KEY;
  delete env.GATEWAY_API_KEY;
  const config = loadGatewayConfig({
    env,
    credentialStores: {
      firecrawl: staticStore(firecrawlApiKey),
      gateway: staticStore(GATEWAY_TOKEN),
    },
  });
  const server = await startGatewayServer({
    config,
    env,
    fetchImpl: fetch,
    deepseekClient,
    logger: (event) => events.push(event),
  });
  return { events, server };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return 0;
  }
  const unknown = args.filter(
    (argument) => argument !== "--billable" && argument !== "--matrix" && argument !== "--crawl",
  );
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option: ${unknown[0]}\n${usage()}`);
    return 2;
  }
  if (!args.includes("--billable")) {
    process.stderr.write(`Refusing billable requests without --billable.\n${usage()}`);
    return 2;
  }
  const matrix = args.includes("--matrix");
  const crawl = args.includes("--crawl");

  const firecrawlApiKey = requireCredential(
    process.env,
    "firecrawl",
    "deepseek-crawl auth import firecrawl",
  );
  const deepseekStore = createCredentialStore({ env: process.env, credential: "deepseek" });
  const deepseekRuntime = loadConfig(process.env, deepseekStore);
  const deepseekClient = new DeepSeekClient({
    ...deepseekRuntime,
    maxRetries: 0,
    fetchImpl: fetch,
  });

  const operationCount = 2 + (matrix ? 4 : 0) + (crawl ? 2 : 0);
  process.stderr.write(
    `Billable requests: ${operationCount} bounded provider operations through Firecrawl and DeepSeek fallback.\n`,
  );
  const summary = {};

  const firecrawlGateway = await startSmokeGateway({
    firecrawlApiKey,
    deepseekClient,
  });
  try {
    summary.firecrawl = await runProviderSmoke(
      firecrawlGateway.server,
      firecrawlGateway.events,
      "firecrawl",
      undefined,
      { matrix, crawl },
    );
  } finally {
    await firecrawlGateway.server.close();
  }

  const fallbackGateway = await startSmokeGateway({
    firecrawlApiKey: undefined,
    deepseekClient,
  });
  try {
    summary.deepseek = await runProviderSmoke(
      fallbackGateway.server,
      fallbackGateway.events,
      "deepseek",
      "no_firecrawl_credential",
      { matrix, crawl },
    );
  } finally {
    await fallbackGateway.server.close();
  }

  const serialized = JSON.stringify(summary);
  if (
    serialized.includes(firecrawlApiKey) ||
    serialized.includes(deepseekRuntime.apiKey) ||
    serialized.includes(GATEWAY_TOKEN)
  ) {
    throw new Error("Credential material appeared in the smoke summary.");
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
