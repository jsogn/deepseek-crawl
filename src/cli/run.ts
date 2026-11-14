import { lstat, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  executeBatchFetch,
  executeBatchFetchPrepared,
  executeBatchFetchRetry,
  prepareBatchFetch,
} from "../application/batch.js";
import {
  executeBalance,
  executeCrawl,
  executeCrawlPlan,
  executeCrawlRetry,
  executeFetch,
  executeMap,
  executeSearch,
} from "../application/index.js";
import type { MapSitemapReader } from "../application/map.js";
import { BatchFetchJobStore, readBatchFetchJobState } from "../batch/job.js";
import type {
  BatchFetchJobState,
  BatchFetchPreparation,
  BatchFetchResult,
} from "../batch/types.js";
import { CachedFetchGateway } from "../cache/cached-gateway.js";
import { FileFetchCache } from "../cache/file-cache.js";
import { resolveCacheDirectory } from "../cache/paths.js";
import type { FetchCache } from "../cache/types.js";
import { loadConfig } from "../config.js";
import { parseCrawlBaseline } from "../crawl/baseline.js";
import { canonicalizeCrawlUrl } from "../crawl/filters.js";
import { CrawlJobStore, readCrawlJobState } from "../crawl/job.js";
import { CrawlMonitorStore, readCrawlMonitorState } from "../crawl/monitor.js";
import type {
  CrawlBaselinePage,
  CrawlChanges,
  CrawlCheckpointOptions,
  CrawlMonitorInfo,
  CrawlMonitorState,
  CrawlRunResult,
} from "../crawl/types.js";
import { readSecret } from "../credentials/input.js";
import {
  type CredentialName,
  type CredentialStore,
  createCredentialStore,
} from "../credentials/store.js";
import { DeepSeekClient } from "../deepseek/client.js";
import { DeepSeekError } from "../deepseek/errors.js";
import type { DeepSeekBalanceGateway, DeepSeekGateway } from "../deepseek/gateway.js";
import { errorMessage as genericErrorMessage } from "../error-message.js";
import { loadGatewayConfig } from "../gateway/config.js";
import { pruneGatewayRuntimeStates, resolveGatewayRuntimeDirectory } from "../gateway/runtime.js";
import { startGatewayServer } from "../gateway/server.js";
import { createBatchFetchOutputWriter, formatBatchFetchHuman } from "../output/batch.js";
import {
  createCrawlOutputWriter,
  formatCrawlHuman,
  formatCrawlPlanHuman,
} from "../output/crawl.js";
import { assertPathMissing, writeFileAtomic, writeFileAtomicNoClobber } from "../output/files.js";
import { formatBalanceHuman, formatFetchHuman, formatSearchHuman } from "../output/format.js";
import { formatMapUrls, formatMapWarnings } from "../output/map.js";
import { type SkillSetupResult, setupSkills } from "../setup/skills.js";
import { packageVersion } from "../version.js";
import { checkDoctor, runDoctor } from "./doctor.js";
import { readJsonFileBounded, readStdinBounded, readTextFileBounded } from "./input.js";
import { CliUsageError, type ParsedCommand, parseCli } from "./parse.js";

export interface CliDependencies {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
  signal?: AbortSignal;
  crawlClient?: DeepSeekGateway;
  fetchClient?: DeepSeekGateway;
  mapClient?: DeepSeekGateway;
  balanceClient?: DeepSeekBalanceGateway;
  sitemapReader?: MapSitemapReader;
  setupEnvironment?: {
    home: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    packageRoot: string;
  };
  credentialStore?: CredentialStore;
  credentialStores?: Partial<Record<CredentialName, CredentialStore>>;
  secretReader?: () => Promise<string>;
  fetchCache?: FetchCache;
  cacheClock?: () => Date;
  monitorClock?: () => Date;
  gatewayRuntimeDirectory?: string;
  stdin: NodeJS.ReadableStream;
}

const MAIN_HELP = `deepseek-crawl ${packageVersion}

Usage:
  deepseek-crawl search <query> [options]
  deepseek-crawl fetch <url> [options]
  deepseek-crawl fetch --retry-failed <fetch.json> --output-dir <dir> [options]
  deepseek-crawl fetch --input <path|-> --output-dir <dir> --job-dir <dir> [options]
  deepseek-crawl fetch resume <job-dir> [options]
  deepseek-crawl fetch status <job-dir> [--json]
  deepseek-crawl map <url> [options]
  deepseek-crawl crawl <url> [options]
  deepseek-crawl crawl <url> --job-dir <dir> -o <dir> [options]
  deepseek-crawl crawl resume <job-dir> -o <dir> [options]
  deepseek-crawl crawl status <job-dir> [--json]
  deepseek-crawl crawl monitor <url> --monitor-dir <dir> -o <runs-dir> [options]
  deepseek-crawl crawl monitor status <monitor-dir> [--json]
  deepseek-crawl crawl monitor reset <monitor-dir> [--json]
  deepseek-crawl crawl --retry-failed <crawl.json> -o <dir> [options]
  deepseek-crawl cache clear [--json]
  deepseek-crawl balance [--json] [--output, -o <path>]
  deepseek-crawl init [options]
  deepseek-crawl doctor [--live] [--json]
  deepseek-crawl setup skills [options]
  deepseek-crawl auth set [deepseek|firecrawl|gateway]
  deepseek-crawl auth status [credential] [--json]
  deepseek-crawl auth remove [credential] [--json]
  deepseek-crawl gateway [--remote] [--host <host>] [--port <port>]
  deepseek-crawl gateway url [--port <port>]
  deepseek-crawl gateway status [--json]
  deepseek-crawl mcp

Run "deepseek-crawl help <command>" for command details.
`;

const COMMAND_HELP: Record<string, string> = {
  search: `Usage: deepseek-crawl search <query> [options]

Options:
  --count <1..50>
  --content
  --max-content-chars <0..1000000>
  --ori-question <text>
  --localization <ip>
  --json
  --output, -o <path>
`,
  fetch: `Usage: deepseek-crawl fetch <url> [options]

       deepseek-crawl fetch --input <path|-> --output-dir <dir> [options]

       deepseek-crawl fetch --retry-failed <fetch.json> --output-dir <dir> [options]

       deepseek-crawl fetch --input <path|-> --output-dir <dir> --job-dir <dir> [options]

       deepseek-crawl fetch resume <job-dir> [--cache-ttl <seconds>] [--fresh] [--json]

       deepseek-crawl fetch status <job-dir> [--json]

Options:
  --max-chars <0..1000000>
  --cache-ttl <1..31536000>
  --fresh
  --input <path|->
  --retry-failed <fetch.json>
  --output-dir <dir>
  --job-dir <dir>
  --concurrency <1..5>
  --delay-ms <0..5000>
  --json
  --output, -o <path>

With --job-dir, Batch Fetch checkpoints every successful or failed URL. Resume with
"fetch resume <job-dir>" and inspect with "fetch status <job-dir>".
`,
  map: `Usage: deepseek-crawl map <url> [options]

Options:
  --limit <1..1000> (default: 500)
  --search <text>
  --json
  --output, -o <path>
`,
  crawl: `Usage: deepseek-crawl crawl <url> [options]

       deepseek-crawl crawl --retry-failed <crawl.json> -o <dir> [--json]

       deepseek-crawl crawl resume <job-dir> -o <dir> [--json]

       deepseek-crawl crawl status <job-dir> [--json]

       deepseek-crawl crawl monitor <url> --monitor-dir <dir> -o <runs-dir> [options]

       deepseek-crawl crawl monitor status <monitor-dir> [--json]

       deepseek-crawl crawl monitor reset <monitor-dir> [--json]

Options:
  --max-depth <0..5>
  --max-pages <1..100>
  --cache-ttl <1..31536000>
  --fresh
  --baseline <crawl.json|dir>
  --changed-only
  --job-dir <dir>
  --concurrency <1..5>
  --delay-ms <0..5000>
  --include-paths <patterns>
  --exclude-paths <patterns>
  --ignore-query-parameters
  --sitemap <include|only|skip> (default: include)
  --plan-only
  --retry-failed <crawl.json>
  --output, -o <dir>
  --json

With --plan-only, --output is a new JSON file path. The plan reads the seed and
Sitemap only; it does not fetch discovered child pages.

With --retry-failed, Crawl reads settings from the existing report and retries
only its failed pages into a new output directory.

With --baseline and --changed-only, Crawl writes only added or modified pages
while retaining the complete change classification in crawl.json.

With --job-dir, Crawl keeps page files and per-page checkpoints in a durable
job directory. Resume with "crawl resume <job-dir>" and inspect with
"crawl status <job-dir>".

Monitor runs one incremental Crawl and exits. Schedule the command with cron,
CI, or Agent Automation. The first run seeds the baseline. Later runs write a
new timestamped report under --output and atomically rotate state.

Monitor options:
  --monitor-dir <dir> (required)
  --fail-on-change (exit 3 when changes are detected)
  --only-modified (trigger and write only modified pages)
  --ignore-removed (do not trigger on removed pages)
`,
  doctor: `Usage: deepseek-crawl doctor [--live] [--json]

Without --live, doctor does not make a billable DeepSeek request.
`,
  balance: `Usage: deepseek-crawl balance [--json] [--output, -o <path>]

Read the DeepSeek account balance without making a billable request.
`,
  init: `Usage: deepseek-crawl init [options]

Prompt for a missing API key, install the bundled Agent Skill, and run a
non-billable doctor check. Existing environment or stored credentials are reused.

Options:
  --skip-auth
  --skip-skills
  --project, -p
  --agent, -a <agents,codex,claude-code,cursor,all>
  --copy
  --force
  --json

init never makes a billable DeepSeek request.
`,
  setup: `Usage: deepseek-crawl setup skills [options]

Options:
  --global, -g
  --project, -p
  --agent, -a <agents,codex,claude-code,cursor,all>
  --copy
  --force
  --json
`,
  auth: `Usage:
  deepseek-crawl auth set [deepseek|firecrawl|gateway]
  deepseek-crawl auth status [credential] [--json]
  deepseek-crawl auth remove [credential] [--json]

Credential defaults to deepseek. Values are read from hidden input and stored in
the user's Keychain or a private credential file.
`,
  mcp: "Usage: deepseek-crawl mcp\n\nStart the MCP server over stdio.\n",
  gateway: `Usage: deepseek-crawl gateway [options]

Start a Firecrawl-compatible HTTP gateway.

Options:
  --host <host>       Listener host (default: 127.0.0.1)
  --port <1..65535>   Fixed listener port (default locally: auto from 8787)
  --remote            Enable authenticated remote mode (fixed port 8787)

Subcommands:
  url                 Print the URL of the only running gateway
  status              List running instances and prune stale runtime state

Remote mode requires GATEWAY_API_KEY. Firecrawl SDK clients set their apiKey to
this gateway token. Local mode uses stored Provider credentials and prints the
actual SDK apiUrl after choosing an available port.
`,
  cache: `Usage: deepseek-crawl cache clear [--json]

Clear the local DeepSeek Fetch cache.
`,
};

function resolvedDependencies(dependencies: Partial<CliDependencies>): CliDependencies {
  return {
    env: dependencies.env ?? process.env,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
    stdout: dependencies.stdout ?? process.stdout,
    stderr: dependencies.stderr ?? process.stderr,
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    ...(dependencies.crawlClient === undefined ? {} : { crawlClient: dependencies.crawlClient }),
    ...(dependencies.fetchClient === undefined ? {} : { fetchClient: dependencies.fetchClient }),
    ...(dependencies.mapClient === undefined ? {} : { mapClient: dependencies.mapClient }),
    ...(dependencies.balanceClient === undefined
      ? {}
      : { balanceClient: dependencies.balanceClient }),
    ...(dependencies.sitemapReader === undefined
      ? {}
      : { sitemapReader: dependencies.sitemapReader }),
    ...(dependencies.setupEnvironment === undefined
      ? {}
      : { setupEnvironment: dependencies.setupEnvironment }),
    ...(dependencies.credentialStore === undefined
      ? {}
      : { credentialStore: dependencies.credentialStore }),
    ...(dependencies.credentialStores === undefined
      ? {}
      : { credentialStores: dependencies.credentialStores }),
    ...(dependencies.secretReader === undefined ? {} : { secretReader: dependencies.secretReader }),
    ...(dependencies.fetchCache === undefined ? {} : { fetchCache: dependencies.fetchCache }),
    ...(dependencies.cacheClock === undefined ? {} : { cacheClock: dependencies.cacheClock }),
    ...(dependencies.monitorClock === undefined ? {} : { monitorClock: dependencies.monitorClock }),
    ...(dependencies.gatewayRuntimeDirectory === undefined
      ? {}
      : { gatewayRuntimeDirectory: dependencies.gatewayRuntimeDirectory }),
    stdin: dependencies.stdin ?? process.stdin,
  };
}

function writeHelp(command: string | undefined, stdout: CliDependencies["stdout"]): void {
  stdout.write(command && COMMAND_HELP[command] ? COMMAND_HELP[command] : MAIN_HELP);
}

function errorMessage(error: unknown): string {
  if (error instanceof DeepSeekError) {
    const requestId = error.requestId ? ` [request id: ${error.requestId}]` : "";
    return `${error.message}${requestId}`;
  }
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => issue.message).join("; ");
  }
  return genericErrorMessage(error);
}

function resolvedFetchCache(deps: CliDependencies): FetchCache {
  return deps.fetchCache ?? new FileFetchCache(resolveCacheDirectory(deps.env, homedir()));
}

function withFetchCache(
  client: DeepSeekGateway,
  cacheTtl: number | undefined,
  fresh: boolean | undefined,
  deps: CliDependencies,
): DeepSeekGateway {
  if (cacheTtl === undefined) {
    return client;
  }
  return new CachedFetchGateway(client, resolvedFetchCache(deps), {
    ttlMs: cacheTtl * 1_000,
    fresh: fresh ?? false,
    ...(deps.cacheClock ? { now: deps.cacheClock } : {}),
  });
}

async function defaultSitemapReader(): Promise<MapSitemapReader> {
  const { SitemapReader } = await import("../sitemap/reader.js");
  return new SitemapReader();
}

async function runBalance(
  command: Extract<ParsedCommand, { kind: "balance" }>,
  deps: CliDependencies,
) {
  const config = loadConfig(deps.env, deps.credentialStore);
  const client = deps.balanceClient ?? new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl });
  const output = await executeBalance(client, deps.signal);
  const content = command.json
    ? `${JSON.stringify(output, null, 2)}\n`
    : `${formatBalanceHuman(output)}\n`;
  if (command.output) {
    await writeFileAtomic(command.output, content);
    deps.stdout.write(`Wrote ${command.output}\n`);
  } else {
    deps.stdout.write(content);
  }
  return 0;
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return new Promise(() => undefined);
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function runGateway(
  command: Extract<ParsedCommand, { kind: "gateway" }>,
  deps: CliDependencies,
) {
  const config = loadGatewayConfig({
    remote: command.remote,
    ...(command.host === undefined ? {} : { host: command.host }),
    ...(command.port === undefined ? {} : { port: command.port }),
    env: deps.env,
    ...(deps.credentialStores === undefined ? {} : { credentialStores: deps.credentialStores }),
  });
  const server = await startGatewayServer({
    config,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
    runtimeState: {
      directory:
        deps.gatewayRuntimeDirectory ?? resolveGatewayRuntimeDirectory(deps.env, homedir()),
      mode: command.remote ? "remote" : "local",
    },
  });
  deps.stdout.write(`Firecrawl gateway listening on ${server.url.href}\n`);
  deps.stdout.write(
    config.firecrawlApiKey
      ? "Firecrawl provider: configured\n"
      : "Firecrawl provider: not configured; common routes use DeepSeek\n",
  );
  deps.stdout.write(
    command.remote
      ? `Firecrawl SDK: apiUrl="${server.url.href.replace(/\/$/, "")}", apiKey=GATEWAY_API_KEY\n`
      : `Firecrawl SDK: apiUrl="${server.url.href.replace(/\/$/, "")}"\n`,
  );
  try {
    await waitForAbort(deps.signal);
  } finally {
    await server.close();
  }
  return 0;
}

async function gatewayRuntimeStates(deps: CliDependencies) {
  const directory =
    deps.gatewayRuntimeDirectory ?? resolveGatewayRuntimeDirectory(deps.env, homedir());
  return pruneGatewayRuntimeStates(directory, deps.fetchImpl);
}

async function runGatewayUrl(
  command: Extract<ParsedCommand, { kind: "gateway-url" }>,
  deps: CliDependencies,
) {
  const { running } = await gatewayRuntimeStates(deps);
  const matching =
    command.port === undefined
      ? running
      : running.filter((state) => Number(new URL(state.url).port) === command.port);
  if (matching.length === 0) {
    throw new Error(
      command.port === undefined
        ? "No running gateway was found."
        : `No running gateway was found on port ${command.port}.`,
    );
  }
  if (matching.length > 1) {
    throw new Error(
      `Multiple gateways are running. Use gateway url --port <port>.\n${matching
        .map((state) => `  ${new URL(state.url).port}  ${state.url}`)
        .join("\n")}`,
    );
  }
  deps.stdout.write(`${matching[0]?.url}\n`);
  return 0;
}

async function runGatewayStatus(
  command: Extract<ParsedCommand, { kind: "gateway-status" }>,
  deps: CliDependencies,
) {
  const { running, stale } = await gatewayRuntimeStates(deps);
  const result = {
    version: 1 as const,
    running: running.length > 0,
    stale,
    instances: running.map((state) => ({
      pid: state.pid,
      url: state.url,
      mode: state.mode,
      startedAt: state.startedAt,
    })),
  };
  if (command.json) {
    deps.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (running.length === 0) {
    deps.stdout.write("Gateway is not running.\n");
  } else {
    deps.stdout.write(
      `${running
        .map((state) => `${state.mode}  ${state.url}  pid=${state.pid}  started=${state.startedAt}`)
        .join("\n")}\n`,
    );
  }
  return 0;
}

async function runSearch(
  command: Extract<ParsedCommand, { kind: "search" }>,
  deps: CliDependencies,
) {
  const config = loadConfig(deps.env, deps.credentialStore);
  const client = new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl });
  const input: Record<string, unknown> = {
    query: command.query,
    need_content: command.needContent,
  };
  if (command.count !== undefined) input.count = command.count;
  if (command.oriQuestion !== undefined) input.ori_question = command.oriQuestion;
  if (command.localization !== undefined) input.localization = command.localization;

  const maxContentChars = command.output
    ? 0
    : (command.maxContentChars ?? (command.json ? 0 : 4000));
  const output = await executeSearch(client, input, { maxContentChars });
  if (command.output) {
    await writeFileAtomic(command.output, `${JSON.stringify(output, null, 2)}\n`);
    deps.stdout.write(`Wrote ${command.output}\n`);
    return 0;
  }

  deps.stdout.write(
    command.json ? `${JSON.stringify(output, null, 2)}\n` : `${formatSearchHuman(output)}\n`,
  );
  return 0;
}

async function runFetch(command: Extract<ParsedCommand, { kind: "fetch" }>, deps: CliDependencies) {
  const config = loadConfig(deps.env, deps.credentialStore);
  const client = withFetchCache(
    deps.fetchClient ?? new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl }),
    command.cacheTtl,
    command.fresh,
    deps,
  );

  if (command.input) {
    const { inputText, source } = await readBatchFetchInput(command.input, deps);
    if (command.jobDir) {
      return runNewBatchFetchJob(command, client, inputText, source, deps);
    }

    const writer = await createBatchFetchOutputWriter(command.outputDir ?? "");
    try {
      const result = await executeBatchFetch(
        client,
        inputText,
        source,
        {
          concurrency: command.concurrency ?? 3,
          delayMs: command.delayMs ?? 250,
          maxChars: command.maxChars ?? 0,
        },
        async (page) => {
          await writer.writePage(page);
        },
        deps.signal,
      );
      const output = await writer.finish(result);
      deps.stdout.write(
        command.json
          ? `${JSON.stringify(output, null, 2)}\n`
          : `${formatBatchFetchHuman(output, command.outputDir ?? "")}\n`,
      );
      return output.stats.fetched === 0 && output.stats.failed > 0 ? 1 : 0;
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
  }

  const maxChars = command.output ? 0 : (command.maxChars ?? (command.json ? 0 : 30000));
  const output = await executeFetch(client, { url: command.url ?? "" }, { maxChars });

  if (command.output) {
    const content = command.json
      ? `${JSON.stringify(output, null, 2)}\n`
      : `${formatFetchHuman(output)}\n`;
    await writeFileAtomic(command.output, content);
    deps.stdout.write(`Wrote ${command.output}\n`);
    return 0;
  }

  deps.stdout.write(
    command.json ? `${JSON.stringify(output, null, 2)}\n` : `${formatFetchHuman(output)}\n`,
  );
  return 0;
}

async function readBatchFetchInput(
  input: string,
  deps: CliDependencies,
): Promise<{ inputText: string; source: string }> {
  if (input === "-") {
    return {
      inputText: await readStdinBounded(deps.stdin, "Batch Fetch input"),
      source: "stdin",
    };
  }
  return {
    inputText: await readTextFileBounded(input, "Batch Fetch input"),
    source: input,
  };
}

function batchFetchExitCode(result: BatchFetchResult): number {
  return result.stats.fetched === 0 && result.stats.failed > 0 ? 1 : 0;
}

function pathContains(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return (
    childRelative === "" ||
    (childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative))
  );
}

function assertDisjointBatchJobPaths(jobDirectory: string, outputDirectory: string): void {
  if (pathContains(jobDirectory, outputDirectory) || pathContains(outputDirectory, jobDirectory)) {
    throw new CliUsageError(
      "--job-dir and --output-dir must be separate directories that do not contain each other.",
    );
  }
}

async function runBatchFetchJob(
  store: BatchFetchJobStore,
  prepared: BatchFetchPreparation,
  client: DeepSeekGateway,
  deps: CliDependencies,
  json: boolean,
): Promise<number> {
  const state = store.state;
  try {
    const result = await executeBatchFetchPrepared(
      client,
      prepared,
      state.source,
      {
        concurrency: state.settings.concurrency,
        delayMs: state.settings.delay_ms,
        maxChars: state.settings.max_chars,
      },
      async (page) => {
        await store.recordPage(page);
      },
      deps.signal,
      {
        uniqueCount: state.requests.length,
        initialPages: state.pages,
        initialFailures: state.failures,
        onFailure: async (failure) => {
          await store.recordFailure(failure);
        },
      },
    );
    await store.markCompleted();
    const output = await store.finalize();
    deps.stdout.write(
      json
        ? `${JSON.stringify(output, null, 2)}\n`
        : `${formatBatchFetchHuman(output, state.output_dir)}\n`,
    );
    return batchFetchExitCode(result);
  } catch (error) {
    if (store.state.status !== "completed") {
      await store.markInterrupted(error).catch(() => undefined);
    }
    throw error;
  }
}

async function runNewBatchFetchJob(
  command: Extract<ParsedCommand, { kind: "fetch" }>,
  client: DeepSeekGateway,
  inputText: string,
  source: string,
  deps: CliDependencies,
): Promise<number> {
  const jobDirectory = resolve(command.jobDir ?? "");
  const outputDirectory = resolve(command.outputDir ?? "");
  assertDisjointBatchJobPaths(jobDirectory, outputDirectory);
  const prepared = prepareBatchFetch(inputText);
  await assertPathMissing(outputDirectory);
  const timestamp = new Date().toISOString();
  const state: BatchFetchJobState = {
    version: 1,
    status: "running",
    source,
    output_dir: outputDirectory,
    started_at: timestamp,
    updated_at: timestamp,
    input: prepared.input,
    settings: {
      concurrency: command.concurrency ?? 3,
      delay_ms: command.delayMs ?? 250,
      max_chars: command.maxChars ?? 0,
    },
    requests: prepared.requests,
    pages: [],
    failures: prepared.failures,
  };
  const store = await BatchFetchJobStore.create(jobDirectory, state);
  try {
    return await runBatchFetchJob(
      store,
      {
        input: prepared.input,
        requests: prepared.requests,
        failures: [],
      },
      client,
      deps,
      command.json,
    );
  } finally {
    await store.release().catch(() => undefined);
  }
}

function pendingBatchFetchRequests(state: BatchFetchJobState) {
  const completedUrls = new Set([
    ...state.pages.map((page) => page.url),
    ...state.failures.map((failure) => failure.url),
  ]);
  return state.requests.filter((request) => !completedUrls.has(request.url));
}

function batchFetchJobStatus(jobDir: string, state: BatchFetchJobState) {
  const pending = pendingBatchFetchRequests(state);
  return {
    directory: jobDir,
    status: state.status,
    source: state.source,
    output_dir: state.output_dir,
    started_at: state.started_at,
    updated_at: state.updated_at,
    input: state.input,
    requests: state.requests.length,
    pages: state.pages.length,
    failures: state.failures.length,
    pending: pending.length,
    ...(state.last_error ? { last_error: state.last_error } : {}),
  };
}

function formatBatchFetchJobStatus(status: ReturnType<typeof batchFetchJobStatus>): string {
  return [
    `Job: ${status.directory}`,
    `Status: ${status.status}`,
    `Source: ${status.source}`,
    `Output: ${status.output_dir}`,
    `URLs: ${status.input} input, ${status.requests} unique`,
    `Fetched: ${status.pages}`,
    `Failed: ${status.failures}`,
    `Pending: ${status.pending}`,
    `Updated: ${status.updated_at}`,
    ...(status.last_error ? [`Last error: ${status.last_error}`] : []),
  ].join("\n");
}

async function runBatchFetchJobStatus(
  command: Extract<ParsedCommand, { kind: "fetch-status" }>,
  deps: CliDependencies,
) {
  const state = await readBatchFetchJobState(command.jobDir);
  const status = batchFetchJobStatus(command.jobDir, state);
  deps.stdout.write(
    command.json
      ? `${JSON.stringify(status, null, 2)}\n`
      : `${formatBatchFetchJobStatus(status)}\n`,
  );
  return 0;
}

async function runBatchFetchJobResume(
  command: Extract<ParsedCommand, { kind: "fetch-resume" }>,
  deps: CliDependencies,
) {
  const jobDirectory = resolve(command.jobDir);
  const store = await BatchFetchJobStore.open(jobDirectory);
  try {
    const state = store.state;
    const outputDirectory = resolve(state.output_dir);
    assertDisjointBatchJobPaths(jobDirectory, outputDirectory);
    if (state.status === "completed") {
      await assertPathMissing(outputDirectory);
      const output = await store.finalize();
      deps.stdout.write(
        command.json
          ? `${JSON.stringify(output, null, 2)}\n`
          : `${formatBatchFetchHuman(output, state.output_dir)}\n`,
      );
      return output.stats.fetched === 0 && output.stats.failed > 0 ? 1 : 0;
    }
    await assertPathMissing(outputDirectory);
    const config = loadConfig(deps.env, deps.credentialStore);
    const client = withFetchCache(
      deps.fetchClient ?? new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl }),
      command.cacheTtl,
      command.fresh,
      deps,
    );
    return await runBatchFetchJob(
      store,
      {
        input: state.input,
        requests: pendingBatchFetchRequests(state),
        failures: [],
      },
      client,
      deps,
      command.json,
    );
  } finally {
    await store.release().catch(() => undefined);
  }
}

async function runFetchRetry(
  command: Extract<ParsedCommand, { kind: "fetch-retry" }>,
  deps: CliDependencies,
) {
  const config = loadConfig(deps.env, deps.credentialStore);
  const client = withFetchCache(
    deps.fetchClient ?? new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl }),
    command.cacheTtl,
    command.fresh,
    deps,
  );
  const report = await readJsonFileBounded(command.report, "Batch Fetch retry report");
  const writer = await createBatchFetchOutputWriter(command.outputDir);
  try {
    const result = await executeBatchFetchRetry(
      client,
      report,
      command.report,
      {
        concurrency: command.concurrency,
        delayMs: command.delayMs,
        maxChars: command.maxChars ?? 0,
      },
      async (page) => {
        await writer.writePage(page);
      },
      deps.signal,
    );
    const output = await writer.finish(result);
    deps.stdout.write(
      command.json
        ? `${JSON.stringify(output, null, 2)}\n`
        : `${formatBatchFetchHuman(output, command.outputDir)}\n`,
    );
    return output.stats.fetched === 0 && output.stats.failed > 0 ? 1 : 0;
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}

async function runMap(command: Extract<ParsedCommand, { kind: "map" }>, deps: CliDependencies) {
  if (command.output) {
    await assertPathMissing(command.output);
  }
  const config = loadConfig(deps.env, deps.credentialStore);
  const client = deps.mapClient ?? new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl });
  const reader = deps.sitemapReader ?? (await defaultSitemapReader());
  const output = await executeMap(
    client,
    reader,
    { url: command.url },
    {
      limit: command.limit,
      discoveryLimit: 10_000,
      pageContentLimit: 1_000_000,
      ...(command.search === undefined ? {} : { search: command.search }),
    },
    deps.signal,
  );

  const warnings = formatMapWarnings(output);
  if (warnings) {
    deps.stderr.write(`${warnings}\n`);
  }

  if (command.output) {
    await writeFileAtomicNoClobber(command.output, `${JSON.stringify(output, null, 2)}\n`);
    deps.stdout.write(`Wrote ${command.output}\n`);
    return 0;
  }

  if (command.json) {
    deps.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    const urls = formatMapUrls(output);
    if (urls) {
      deps.stdout.write(`${urls}\n`);
    }
  }
  return 0;
}

async function runCrawl(command: Extract<ParsedCommand, { kind: "crawl" }>, deps: CliDependencies) {
  const config = loadConfig(deps.env, deps.credentialStore);
  const client = withFetchCache(
    deps.crawlClient ?? new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl }),
    command.cacheTtl,
    command.fresh,
    deps,
  );
  const reader = deps.sitemapReader ?? (await defaultSitemapReader());
  let baseline: ReturnType<typeof parseCrawlBaseline> | undefined;
  if (command.baseline) {
    let baselinePath = command.baseline;
    try {
      if ((await stat(baselinePath)).isDirectory()) {
        baselinePath = join(baselinePath, "crawl.json");
      }
    } catch {
      // The bounded reader below reports missing or unreadable paths.
    }
    baseline = parseCrawlBaseline(
      await readJsonFileBounded(baselinePath, "Crawl baseline"),
      baselinePath,
    );
  }
  const crawlOptions = {
    maxDepth: command.maxDepth,
    maxPages: command.maxPages,
    concurrency: command.concurrency,
    delayMs: command.delayMs,
    discoveryLimit: 10_000,
    pageContentLimit: 1_000_000,
    includePaths: command.includePaths ?? [],
    excludePaths: command.excludePaths ?? [],
    ignoreQueryParameters: command.ignoreQueryParameters ?? false,
    sitemapMode: command.sitemapMode,
    sitemapReader: reader,
    ...(baseline ? { baseline } : {}),
    changedOnly: command.changedOnly ?? false,
  };

  if (command.jobDir) {
    await assertPathMissing(command.output);
    const job = await CrawlJobStore.create(command.jobDir);
    try {
      const result = await executeCrawl(
        client,
        { url: command.url },
        {
          ...crawlOptions,
          onCheckpoint: async (checkpoint) => {
            await job.checkpoint(checkpoint);
          },
        },
        async (page) => {
          await job.writePage(page);
        },
        deps.signal,
      );
      const output = await job.finalize(command.output, result);
      deps.stdout.write(
        command.json
          ? `${JSON.stringify(output, null, 2)}\n`
          : `${formatCrawlHuman(output, command.output)}\n`,
      );
      return 0;
    } finally {
      await job.release().catch(() => undefined);
    }
  }

  if (command.planOnly) {
    await assertPathMissing(command.output);
    const plan = await executeCrawlPlan(client, { url: command.url }, crawlOptions, deps.signal);
    const json = `${JSON.stringify(plan, null, 2)}\n`;
    await writeFileAtomicNoClobber(command.output, json);
    deps.stdout.write(command.json ? json : `${formatCrawlPlanHuman(plan, command.output)}\n`);
    return 0;
  }

  const writer = await createCrawlOutputWriter(command.output, {
    allowMissingPages: command.changedOnly ?? false,
  });

  try {
    const result = await executeCrawl(
      client,
      { url: command.url },
      crawlOptions,
      async (page) => {
        await writer.writePage(page);
      },
      deps.signal,
    );
    const output = await writer.finish(result);
    deps.stdout.write(
      command.json
        ? `${JSON.stringify(output, null, 2)}\n`
        : `${formatCrawlHuman(output, command.output)}\n`,
    );
    return 0;
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}

async function runCrawlRetry(
  command: Extract<ParsedCommand, { kind: "crawl-retry" }>,
  deps: CliDependencies,
) {
  const config = loadConfig(deps.env, deps.credentialStore);
  const client = withFetchCache(
    deps.crawlClient ?? new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl }),
    command.cacheTtl,
    command.fresh,
    deps,
  );
  const report = await readJsonFileBounded(command.report, "Crawl retry report");
  const writer = await createCrawlOutputWriter(command.output);
  try {
    const result = await executeCrawlRetry(
      client,
      report,
      command.report,
      async (page) => {
        await writer.writePage(page);
      },
      deps.signal,
    );
    const output = await writer.finish(result);
    deps.stdout.write(
      command.json
        ? `${JSON.stringify(output, null, 2)}\n`
        : `${formatCrawlHuman(output, command.output)}\n`,
    );
    return 0;
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}

async function runCrawlResume(
  command: Extract<ParsedCommand, { kind: "crawl-resume" }>,
  deps: CliDependencies,
) {
  await assertPathMissing(command.output);
  const config = loadConfig(deps.env, deps.credentialStore);
  const client = withFetchCache(
    deps.crawlClient ?? new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl }),
    command.cacheTtl,
    command.fresh,
    deps,
  );
  const reader = deps.sitemapReader ?? (await defaultSitemapReader());
  const job = await CrawlJobStore.open(command.jobDir);
  try {
    const state = job.state;
    const result = await executeCrawl(
      client,
      { url: state.seed_url },
      {
        maxDepth: state.options.maxDepth,
        maxPages: state.options.maxPages,
        concurrency: state.options.concurrency,
        delayMs: state.options.delayMs,
        discoveryLimit: 10_000,
        pageContentLimit: 1_000_000,
        includePaths: state.options.includePaths,
        excludePaths: state.options.excludePaths,
        ignoreQueryParameters: state.options.ignoreQueryParameters,
        sitemapMode: state.options.sitemapMode,
        sitemapReader: reader,
        resume: state,
        onCheckpoint: async (checkpoint) => {
          await job.checkpoint(checkpoint);
        },
      },
      async (page) => {
        await job.writePage(page);
      },
      deps.signal,
    );
    const output = await job.finalize(command.output, result);
    deps.stdout.write(
      command.json
        ? `${JSON.stringify(output, null, 2)}\n`
        : `${formatCrawlHuman(output, command.output)}\n`,
    );
    return 0;
  } finally {
    await job.release().catch(() => undefined);
  }
}

function formatCrawlJobStatus(
  jobDir: string,
  state: Awaited<ReturnType<typeof readCrawlJobState>>,
) {
  return [
    `Job: ${jobDir}`,
    `Status: ${state.status}`,
    `Seed: ${state.seed_url}`,
    `Fetched: ${state.counters.fetched}`,
    `Failed: ${state.failures.length}`,
    `Frontier: ${state.frontier.length}`,
    `Depth: ${state.depth}`,
    `Active layer: ${state.active_layer ? `${state.active_layer.completed.length}/${state.active_layer.urls.length}` : "none"}`,
    `Updated: ${state.updated_at}`,
    ...(state.last_error ? [`Last error: ${state.last_error}`] : []),
  ].join("\n");
}

async function runCrawlStatus(
  command: Extract<ParsedCommand, { kind: "crawl-status" }>,
  deps: CliDependencies,
) {
  const state = await readCrawlJobState(command.jobDir);
  deps.stdout.write(
    command.json
      ? `${JSON.stringify(state, null, 2)}\n`
      : `${formatCrawlJobStatus(command.jobDir, state)}\n`,
  );
  return 0;
}

function monitorOptions(
  command: Extract<ParsedCommand, { kind: "crawl-monitor" }>,
): CrawlCheckpointOptions {
  return {
    maxDepth: command.maxDepth,
    maxPages: command.maxPages,
    concurrency: command.concurrency,
    delayMs: command.delayMs,
    includePaths: [...(command.includePaths ?? [])],
    excludePaths: [...(command.excludePaths ?? [])],
    ignoreQueryParameters: command.ignoreQueryParameters ?? false,
    sitemapMode: command.sitemapMode,
  };
}

function emptyChanges(): CrawlChanges {
  return { added: [], modified: [], unchanged: [], removed: [] };
}

function monitorHasChanges(
  changes: CrawlChanges,
  onlyModified: boolean,
  ignoreRemoved: boolean,
): boolean {
  if (onlyModified) {
    return changes.modified.length > 0;
  }
  return (
    changes.added.length > 0 ||
    changes.modified.length > 0 ||
    (!ignoreRemoved && changes.removed.length > 0)
  );
}

function rotatedMonitorBaseline(
  previous: readonly CrawlBaselinePage[],
  result: CrawlRunResult,
  changes: CrawlChanges,
): CrawlBaselinePage[] {
  const baseline = new Map(previous.map((page) => [page.url, page]));
  for (const page of changes.removed) {
    baseline.delete(page.url);
  }
  for (const page of result.pages) {
    baseline.set(page.url, {
      url: page.url,
      content_hash: page.content_hash,
      title: page.title,
      depth: page.depth,
      sources: [...page.sources],
      content_length: page.content_length,
      content_truncated: page.content_truncated,
      ...(page.content_original_length === undefined
        ? {}
        : { content_original_length: page.content_original_length }),
      ...(page.sitemap_lastmod === undefined ? {} : { sitemap_lastmod: page.sitemap_lastmod }),
    });
  }
  return [...baseline.values()]
    .map((page) => ({ ...page, sources: [...page.sources] }))
    .sort((left, right) => left.url.localeCompare(right.url));
}

function monitorRunId(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

async function allocateMonitorRun(
  runsDirectory: string,
  date: Date,
): Promise<{ runId: string; directory: string }> {
  const root = resolve(runsDirectory);
  const base = monitorRunId(date);
  for (let sequence = 1; sequence <= 10_000; sequence += 1) {
    const runId = sequence === 1 ? base : `${base}-${sequence}`;
    const directory = join(root, runId);
    try {
      await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { runId, directory };
      }
      throw error;
    }
  }
  throw new Error(`Could not allocate a unique Crawl monitor run ID under ${root}.`);
}

function formatCrawlMonitorStatus(stateDirectory: string, state: CrawlMonitorState): string {
  const changes = state.last_changes;
  return [
    `Monitor: ${stateDirectory}`,
    `Seed: ${state.seed_url}`,
    `Baseline pages: ${state.baseline.length}`,
    `Last run: ${state.last_run_at} (${state.last_run_id})`,
    `Changes: +${changes.added.length} ~${changes.modified.length} =${changes.unchanged.length} -${changes.removed.length}`,
    `Has changes: ${state.last_has_changes ? "yes" : "no"}`,
    `Output: ${state.last_output}`,
  ].join("\n");
}

async function completeWriterOperation<T>(
  operation: () => Promise<T>,
  release: () => Promise<void>,
): Promise<T> {
  let result!: T;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await release();
  } catch (error) {
    if (!operationFailed) {
      throw error;
    }
  }

  if (operationFailed) {
    throw operationError;
  }
  return result;
}

async function runCrawlMonitor(
  command: Extract<ParsedCommand, { kind: "crawl-monitor" }>,
  deps: CliDependencies,
) {
  const clock = deps.monitorClock ?? (() => new Date());
  const runStartedAt = clock();
  const monitor = await CrawlMonitorStore.open(command.monitorDir);
  return completeWriterOperation(
    async () => {
      const previousState = monitor.state;
      const options = previousState?.options ?? monitorOptions(command);
      const requestedSeed = canonicalizeCrawlUrl(
        command.url,
        undefined,
        options.ignoreQueryParameters,
      );
      if (!requestedSeed) {
        throw new Error("Crawl URL must be an HTTP(S) URL with a host and no credentials.");
      }
      if (previousState && requestedSeed.href !== previousState.seed_url) {
        throw new Error(
          `Crawl monitor seed does not match ${previousState.seed_url}; reset the monitor before changing its seed.`,
        );
      }

      const config = loadConfig(deps.env, deps.credentialStore);
      const client = withFetchCache(
        deps.crawlClient ?? new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl }),
        command.cacheTtl,
        command.fresh,
        deps,
      );
      const reader = deps.sitemapReader ?? (await defaultSitemapReader());
      const run = await allocateMonitorRun(command.output, runStartedAt);
      const writer = await createCrawlOutputWriter(run.directory, { allowMissingPages: true });
      let result: CrawlRunResult;
      let changes: CrawlChanges;
      let hasChanges: boolean;
      let info: CrawlMonitorInfo;

      try {
        const baseline = previousState
          ? {
              source: join(monitor.directory, "state.json"),
              pages: new Map(previousState.baseline.map((page) => [page.url, page])),
            }
          : undefined;
        result = await executeCrawl(
          client,
          { url: command.url },
          {
            ...options,
            discoveryLimit: 10_000,
            pageContentLimit: 1_000_000,
            sitemapReader: reader,
            ...(baseline ? { baseline, changedOnly: true } : {}),
            now: clock,
          },
          async (page) => {
            if (
              !previousState ||
              page.change_status === "modified" ||
              (!command.onlyModified && page.change_status === "added")
            ) {
              await writer.writePage(page);
            }
          },
          deps.signal,
        );
        changes = result.changes ?? emptyChanges();
        hasChanges = previousState
          ? monitorHasChanges(changes, command.onlyModified, command.ignoreRemoved)
          : false;
        info = {
          first_run: !previousState,
          run_id: run.runId,
          state_dir: monitor.directory,
          has_changes: hasChanges,
          triggered: command.failOnChange && hasChanges,
          fail_on_change: command.failOnChange,
          only_modified: command.onlyModified,
          ignore_removed: command.ignoreRemoved,
        };
        result.monitor = info;
        const output = await writer.finish(result);

        const nextState: CrawlMonitorState = {
          version: 2,
          seed_url: result.seed_url,
          options,
          baseline: rotatedMonitorBaseline(previousState?.baseline ?? [], result, changes),
          last_run_at: runStartedAt.toISOString(),
          last_run_id: run.runId,
          last_output: run.directory,
          last_changes: changes,
          last_has_changes: hasChanges,
        };
        await monitor.checkpoint(nextState);
        deps.stdout.write(
          command.json
            ? `${JSON.stringify(output, null, 2)}\n`
            : `${formatCrawlHuman(output, run.directory)}\n`,
        );
      } catch (error) {
        await writer.abort().catch(() => undefined);
        throw error;
      }

      return command.failOnChange && hasChanges ? 3 : 0;
    },
    () => monitor.release(),
  );
}

async function runCrawlMonitorStatus(
  command: Extract<ParsedCommand, { kind: "crawl-monitor-status" }>,
  deps: CliDependencies,
) {
  const state = await readCrawlMonitorState(command.monitorDir);
  if (!state) {
    throw new Error(`Crawl monitor is not initialized: ${resolve(command.monitorDir)}`);
  }
  const stateDirectory = resolve(command.monitorDir);
  deps.stdout.write(
    command.json
      ? `${JSON.stringify({ state_dir: stateDirectory, ...state }, null, 2)}\n`
      : `${formatCrawlMonitorStatus(stateDirectory, state)}\n`,
  );
  return 0;
}

async function runCrawlMonitorReset(
  command: Extract<ParsedCommand, { kind: "crawl-monitor-reset" }>,
  deps: CliDependencies,
) {
  const stateDirectory = resolve(command.monitorDir);
  let exists = true;
  try {
    await lstat(stateDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      exists = false;
    } else {
      throw error;
    }
  }
  let removed = false;
  if (exists) {
    const monitor = await CrawlMonitorStore.open(stateDirectory);
    removed = await completeWriterOperation(
      () => monitor.reset(),
      () => monitor.release(),
    );
  }
  deps.stdout.write(
    command.json
      ? `${JSON.stringify({ state_dir: stateDirectory, removed }, null, 2)}\n`
      : removed
        ? `Reset Crawl monitor: ${stateDirectory}\n`
        : `Crawl monitor has no baseline to reset: ${stateDirectory}\n`,
  );
  return 0;
}

async function runCacheClear(
  command: Extract<ParsedCommand, { kind: "cache-clear" }>,
  deps: CliDependencies,
) {
  const cache = resolvedFetchCache(deps);
  await cache.clear();
  deps.stdout.write(
    command.json
      ? `${JSON.stringify({ cleared: true, location: cache.location }, null, 2)}\n`
      : `Cleared Fetch cache: ${cache.location}\n`,
  );
  return 0;
}

function formatSkillSetupHuman(result: SkillSetupResult): string {
  const lines = ["Installed DeepSeek Crawl Skill:"];
  for (const install of result.installs) {
    const status = install.status === "installed" ? "" : ` [${install.status}]`;
    lines.push(`- ${install.agents.join(",")}: ${install.path} (${install.mode})${status}`);
  }
  lines.push("", "Start a new Agent session to use the Skill.");
  return lines.join("\n");
}

async function installBundledSkill(
  options: {
    scope: "global" | "project";
    agents: Extract<ParsedCommand, { kind: "setup-skills" }>["agents"];
    copy: boolean;
    force: boolean;
  },
  deps: CliDependencies,
): Promise<SkillSetupResult> {
  const environment = deps.setupEnvironment;
  const packageRoot = environment?.packageRoot ?? fileURLToPath(new URL("../../", import.meta.url));
  return setupSkills({
    agents: options.agents,
    scope: options.scope,
    home: environment?.home ?? homedir(),
    cwd: environment?.cwd ?? process.cwd(),
    env: environment?.env ?? deps.env,
    source: join(packageRoot, "skills", "deepseek-crawl"),
    copy: options.copy,
    force: options.force,
  });
}

async function runSetupSkills(
  command: Extract<ParsedCommand, { kind: "setup-skills" }>,
  deps: CliDependencies,
) {
  const result = await installBundledSkill(command, deps);
  deps.stdout.write(
    command.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatSkillSetupHuman(result)}\n`,
  );
  return 0;
}

function resolvedCredentialStore(
  deps: CliDependencies,
  credential: CredentialName = "deepseek",
): CredentialStore {
  const providerStore = deps.credentialStores?.[credential];
  if (providerStore) {
    return providerStore;
  }
  if (credential === "deepseek" && deps.credentialStore) {
    return deps.credentialStore;
  }
  return createCredentialStore({ env: deps.env, credential });
}

const CREDENTIAL_ENV: Record<CredentialName, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  gateway: "GATEWAY_API_KEY",
};

const CREDENTIAL_LABEL: Record<CredentialName, string> = {
  deepseek: "DeepSeek API key",
  firecrawl: "Firecrawl API key",
  gateway: "gateway API key",
};

function authStatus(
  env: NodeJS.ProcessEnv,
  store: CredentialStore,
  credential: CredentialName = "deepseek",
) {
  if (env[CREDENTIAL_ENV[credential]]?.trim()) {
    return { configured: true, source: "environment", backend: "environment" };
  }
  const stored = store.get()?.trim();
  return stored
    ? { configured: true, source: store.name, backend: store.name }
    : { configured: false, source: "missing", backend: store.name };
}

async function runAuthSet(
  command: Extract<ParsedCommand, { kind: "auth-set" }>,
  deps: CliDependencies,
) {
  const store = resolvedCredentialStore(deps, command.credential);
  const label = CREDENTIAL_LABEL[command.credential];
  const secret = await (deps.secretReader ?? (() => readSecret({ label })))();
  store.set(secret);
  deps.stdout.write(`${label} saved in ${store.name}.\n`);
  return 0;
}

async function runAuthStatus(
  command: Extract<ParsedCommand, { kind: "auth-status" }>,
  deps: CliDependencies,
) {
  const store = resolvedCredentialStore(deps, command.credential);
  const label = CREDENTIAL_LABEL[command.credential];
  const result = authStatus(deps.env, store, command.credential);
  if (command.json) {
    deps.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    deps.stdout.write(
      result.configured
        ? `${label} configured via ${result.source}.\n`
        : `${label} is not configured (${result.backend}).\n`,
    );
  }
  return 0;
}

async function runAuthRemove(
  command: Extract<ParsedCommand, { kind: "auth-remove" }>,
  deps: CliDependencies,
) {
  const store = resolvedCredentialStore(deps, command.credential);
  const label = CREDENTIAL_LABEL[command.credential];
  const existed = store.get() !== undefined;
  store.remove();
  const result = { removed: existed };
  deps.stdout.write(
    command.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : existed
        ? `Stored ${label} removed.\n`
        : `No stored ${label} was found.\n`,
  );
  return 0;
}

async function runInit(command: Extract<ParsedCommand, { kind: "init" }>, deps: CliDependencies) {
  const store = resolvedCredentialStore(deps);
  let auth = authStatus(deps.env, store);
  let changed = false;
  if (!auth.configured && !command.skipAuth) {
    const secret = await (deps.secretReader ?? readSecret)();
    store.set(secret);
    auth = authStatus(deps.env, store);
    changed = true;
  }

  const skills = command.skipSkills
    ? { skipped: true as const }
    : await installBundledSkill(command, deps);
  const doctor = await checkDoctor({
    env: deps.env,
    credentialStore: store,
    fetchImpl: deps.fetchImpl,
    live: false,
  });
  const result = {
    version: 1 as const,
    ok: doctor.result.ok,
    auth: {
      configured: auth.configured,
      source: auth.source,
      changed,
      skipped: command.skipAuth,
    },
    skills,
    doctor: doctor.result,
  };

  if (command.json) {
    deps.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const lines = [
      result.ok
        ? "DeepSeek Crawl initialization complete."
        : "DeepSeek Crawl initialization needs attention.",
      `Authentication: ${auth.configured ? `configured via ${auth.source}` : "missing"}`,
    ];
    if ("installs" in skills) {
      lines.push(...formatSkillSetupHuman(skills).split("\n"));
    }
    lines.push(
      `Doctor: ${doctor.result.ok ? "passed" : "failed"}`,
      ...(doctor.result.error ? [`Error: ${doctor.result.error}`] : []),
    );
    deps.stdout.write(`${lines.join("\n")}\n`);
  }
  return result.ok ? 0 : 1;
}

export async function runCli(
  argv: string[],
  dependencies: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = resolvedDependencies(dependencies);
  let command: ParsedCommand;
  try {
    command = parseCli(argv);
  } catch (error) {
    deps.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }

  try {
    switch (command.kind) {
      case "help":
        writeHelp(command.command, deps.stdout);
        return 0;
      case "version":
        deps.stdout.write(`${packageVersion}\n`);
        return 0;
      case "search":
        return await runSearch(command, deps);
      case "fetch":
        return await runFetch(command, deps);
      case "fetch-status":
        return await runBatchFetchJobStatus(command, deps);
      case "fetch-resume":
        return await runBatchFetchJobResume(command, deps);
      case "fetch-retry":
        return await runFetchRetry(command, deps);
      case "map":
        return await runMap(command, deps);
      case "crawl":
        return await runCrawl(command, deps);
      case "crawl-retry":
        return await runCrawlRetry(command, deps);
      case "crawl-resume":
        return await runCrawlResume(command, deps);
      case "crawl-status":
        return await runCrawlStatus(command, deps);
      case "crawl-monitor":
        return await runCrawlMonitor(command, deps);
      case "crawl-monitor-status":
        return await runCrawlMonitorStatus(command, deps);
      case "crawl-monitor-reset":
        return await runCrawlMonitorReset(command, deps);
      case "cache-clear":
        return await runCacheClear(command, deps);
      case "setup-skills":
        return await runSetupSkills(command, deps);
      case "auth-set":
        return await runAuthSet(command, deps);
      case "auth-status":
        return await runAuthStatus(command, deps);
      case "auth-remove":
        return await runAuthRemove(command, deps);
      case "doctor":
        return await runDoctor({
          env: deps.env,
          ...(deps.credentialStore === undefined ? {} : { credentialStore: deps.credentialStore }),
          fetchImpl: deps.fetchImpl,
          live: command.live,
          json: command.json,
          stdout: deps.stdout,
          stderr: deps.stderr,
        });
      case "balance":
        return await runBalance(command, deps);
      case "gateway":
        return await runGateway(command, deps);
      case "gateway-url":
        return await runGatewayUrl(command, deps);
      case "gateway-status":
        return await runGatewayStatus(command, deps);
      case "init":
        return await runInit(command, deps);
      case "mcp": {
        const { runMcpServer } = await import("../mcp/server.js");
        await runMcpServer({
          client: new DeepSeekClient({
            ...loadConfig(deps.env, deps.credentialStore),
            fetchImpl: deps.fetchImpl,
          }),
          sitemapReader: deps.sitemapReader ?? (await defaultSitemapReader()),
        });
        return 0;
      }
    }
  } catch (error) {
    deps.stderr.write(`${errorMessage(error)}\n`);
    if (deps.signal?.aborted) {
      return 130;
    }
    return error instanceof CliUsageError || error instanceof z.ZodError ? 2 : 1;
  }
}
