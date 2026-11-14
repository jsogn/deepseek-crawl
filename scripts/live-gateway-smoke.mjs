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
const GATEWAY_TOKEN = "live-smoke-gateway-token";
const SCRAPE_TIMEOUT_MS = 60_000;

function usage() {
  return `Usage: npm run test:live:gateway -- --billable

Runs exactly two billable example.com Scrapes through the official Firecrawl SDK:
one Firecrawl passthrough and one DeepSeek fallback.

Options:
  --billable   Confirm the two billable provider requests.
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

async function waitForRequestEvent(events, expectedProvider) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const event = events.find(
      (candidate) =>
        candidate.event === "gateway_request" &&
        candidate.route === "/v2/scrape" &&
        candidate.provider === expectedProvider,
    );
    if (event) {
      return event;
    }
    await delay(25);
  }
  throw new Error(`Gateway did not log the ${expectedProvider} Scrape request.`);
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

async function runScrape(server, events, expectedProvider, expectedFallbackReason) {
  const client = new Firecrawl({
    apiKey: GATEWAY_TOKEN,
    apiUrl: server.url.href.replace(/\/$/, ""),
  });
  const result = await withTimeout(
    client.scrape(TARGET_URL, { formats: ["markdown"] }),
    `${expectedProvider} Scrape`,
    SCRAPE_TIMEOUT_MS,
  );
  if (typeof result.markdown !== "string" || !result.markdown.trim()) {
    throw new Error(`${expectedProvider} Scrape returned no Markdown.`);
  }

  const event = await waitForRequestEvent(events, expectedProvider);
  if (event.status !== 200) {
    throw new Error(`${expectedProvider} Scrape returned status ${event.status}.`);
  }
  if (expectedFallbackReason === undefined) {
    if (event.fallback) {
      throw new Error("Firecrawl passthrough unexpectedly used fallback.");
    }
  } else if (!event.fallback || event.fallback_reason !== expectedFallbackReason) {
    throw new Error(`Unexpected fallback metadata: ${JSON.stringify(event)}`);
  }

  return {
    provider: event.provider,
    fallback: event.fallback,
    fallback_reason: event.fallback_reason ?? null,
    status: event.status,
    markdown_characters: result.markdown.length,
    request_id: event.request_id,
  };
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
  const unknown = args.filter((argument) => argument !== "--billable");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option: ${unknown[0]}\n${usage()}`);
    return 2;
  }
  if (!args.includes("--billable")) {
    process.stderr.write(`Refusing billable requests without --billable.\n${usage()}`);
    return 2;
  }

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

  process.stderr.write(
    "Billable requests: one Firecrawl Scrape and one DeepSeek Fetch fallback.\n",
  );
  const summary = {};

  const firecrawlGateway = await startSmokeGateway({
    firecrawlApiKey,
    deepseekClient,
  });
  try {
    summary.firecrawl = await runScrape(
      firecrawlGateway.server,
      firecrawlGateway.events,
      "firecrawl",
    );
  } finally {
    await firecrawlGateway.server.close();
  }

  const fallbackGateway = await startSmokeGateway({
    firecrawlApiKey: undefined,
    deepseekClient,
  });
  try {
    summary.deepseek = await runScrape(
      fallbackGateway.server,
      fallbackGateway.events,
      "deepseek",
      "no_firecrawl_credential",
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
