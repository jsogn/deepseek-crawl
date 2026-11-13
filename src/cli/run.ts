import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { executeBatchFetch } from "../application/batch.js";
import {
  executeCrawl,
  executeFetch,
  executeMap,
  executeSearch,
  type MapSitemapReader,
} from "../application/index.js";
import { loadConfig } from "../config.js";
import { readSecret } from "../credentials/input.js";
import { type CredentialStore, createCredentialStore } from "../credentials/store.js";
import { DeepSeekClient } from "../deepseek/client.js";
import { DeepSeekError } from "../deepseek/errors.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import { runMcpServer } from "../mcp/server.js";
import { createBatchFetchOutputWriter, formatBatchFetchHuman } from "../output/batch.js";
import { createCrawlOutputWriter, formatCrawlHuman } from "../output/crawl.js";
import { writeFileAtomic, writeFileAtomicNoClobber } from "../output/files.js";
import { formatFetchHuman, formatSearchHuman } from "../output/format.js";
import { formatMapUrls, formatMapWarnings } from "../output/map.js";
import { type SkillSetupResult, setupSkills } from "../setup/skills.js";
import { SitemapReader } from "../sitemap/reader.js";
import { packageVersion } from "../version.js";
import { runDoctor } from "./doctor.js";
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
  sitemapReader?: MapSitemapReader;
  setupEnvironment?: {
    home: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    packageRoot: string;
  };
  credentialStore?: CredentialStore;
  secretReader?: () => Promise<string>;
  stdin: NodeJS.ReadableStream;
}

const MAIN_HELP = `deepseek-crawl ${packageVersion}

Usage:
  deepseek-crawl search <query> [options]
  deepseek-crawl fetch <url> [options]
  deepseek-crawl map <url> [options]
  deepseek-crawl crawl <url> [options]
  deepseek-crawl doctor [--live] [--json]
  deepseek-crawl setup skills [options]
  deepseek-crawl auth set
  deepseek-crawl auth status [--json]
  deepseek-crawl auth remove [--json]
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

Options:
  --max-chars <0..1000000>
  --input <path|->
  --output-dir <dir>
  --concurrency <1..5>
  --delay-ms <0..5000>
  --json
  --output, -o <path>
`,
  map: `Usage: deepseek-crawl map <url> [options]

Options:
  --limit <1..1000> (default: 500)
  --search <text>
  --json
  --output, -o <path>
`,
  crawl: `Usage: deepseek-crawl crawl <url> [options]

Options:
  --max-depth <0..5>
  --max-pages <1..100>
  --concurrency <1..5>
  --delay-ms <0..5000>
  --include-paths <patterns>
  --exclude-paths <patterns>
  --ignore-query-parameters
  --output, -o <dir>
  --json
`,
  doctor: `Usage: deepseek-crawl doctor [--live] [--json]

Without --live, doctor does not make a billable DeepSeek request.
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
  deepseek-crawl auth set
  deepseek-crawl auth status [--json]
  deepseek-crawl auth remove [--json]
`,
  mcp: "Usage: deepseek-crawl mcp\n\nStart the MCP server over stdio.\n",
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
    ...(dependencies.sitemapReader === undefined
      ? {}
      : { sitemapReader: dependencies.sitemapReader }),
    ...(dependencies.setupEnvironment === undefined
      ? {}
      : { setupEnvironment: dependencies.setupEnvironment }),
    ...(dependencies.credentialStore === undefined
      ? {}
      : { credentialStore: dependencies.credentialStore }),
    ...(dependencies.secretReader === undefined ? {} : { secretReader: dependencies.secretReader }),
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
  return error instanceof Error ? error.message : String(error);
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
  const client = deps.fetchClient ?? new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl });

  if (command.input) {
    const source = command.input === "-" ? "stdin" : command.input;
    let inputText: string;
    if (command.input === "-") {
      inputText = "";
      for await (const chunk of deps.stdin) {
        inputText += String(chunk);
      }
    } else {
      inputText = await readFile(command.input, "utf8");
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

async function runMap(command: Extract<ParsedCommand, { kind: "map" }>, deps: CliDependencies) {
  const config = loadConfig(deps.env, deps.credentialStore);
  const client = deps.mapClient ?? new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl });
  const reader = deps.sitemapReader ?? new SitemapReader();
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
  const client = deps.crawlClient ?? new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl });
  const writer = await createCrawlOutputWriter(command.output);

  try {
    const result = await executeCrawl(
      client,
      { url: command.url },
      {
        maxDepth: command.maxDepth,
        maxPages: command.maxPages,
        concurrency: command.concurrency,
        delayMs: command.delayMs,
        discoveryLimit: 10_000,
        pageContentLimit: 1_000_000,
        includePaths: command.includePaths ?? [],
        excludePaths: command.excludePaths ?? [],
        ignoreQueryParameters: command.ignoreQueryParameters ?? false,
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
        : `${formatCrawlHuman(output, command.output)}\n`,
    );
    return 0;
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
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

async function runSetupSkills(
  command: Extract<ParsedCommand, { kind: "setup-skills" }>,
  deps: CliDependencies,
) {
  const environment = deps.setupEnvironment;
  const packageRoot = environment?.packageRoot ?? fileURLToPath(new URL("../../", import.meta.url));
  const result = await setupSkills({
    agents: command.agents,
    scope: command.scope,
    home: environment?.home ?? homedir(),
    cwd: environment?.cwd ?? process.cwd(),
    env: environment?.env ?? deps.env,
    source: join(packageRoot, "skills", "deepseek-crawl"),
    copy: command.copy,
    force: command.force,
  });
  deps.stdout.write(
    command.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatSkillSetupHuman(result)}\n`,
  );
  return 0;
}

function resolvedCredentialStore(deps: CliDependencies): CredentialStore {
  return deps.credentialStore ?? createCredentialStore({ env: deps.env });
}

function authStatus(env: NodeJS.ProcessEnv, store: CredentialStore) {
  if (env.DEEPSEEK_API_KEY?.trim()) {
    return { configured: true, source: "environment", backend: "environment" };
  }
  const stored = store.get()?.trim();
  return stored
    ? { configured: true, source: store.name, backend: store.name }
    : { configured: false, source: "missing", backend: store.name };
}

async function runAuthSet(deps: CliDependencies) {
  const store = resolvedCredentialStore(deps);
  const secret = await (deps.secretReader ?? readSecret)();
  store.set(secret);
  deps.stdout.write(`DeepSeek API key saved in ${store.name}.\n`);
  return 0;
}

async function runAuthStatus(
  command: Extract<ParsedCommand, { kind: "auth-status" }>,
  deps: CliDependencies,
) {
  const result = authStatus(deps.env, resolvedCredentialStore(deps));
  if (command.json) {
    deps.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    deps.stdout.write(
      result.configured
        ? `DeepSeek API key configured via ${result.source}.\n`
        : `DeepSeek API key is not configured (${result.backend}).\n`,
    );
  }
  return 0;
}

async function runAuthRemove(
  command: Extract<ParsedCommand, { kind: "auth-remove" }>,
  deps: CliDependencies,
) {
  const store = resolvedCredentialStore(deps);
  const existed = store.get() !== undefined;
  store.remove();
  const result = { removed: existed };
  deps.stdout.write(
    command.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : existed
        ? "Stored DeepSeek API key removed.\n"
        : "No stored DeepSeek API key was found.\n",
  );
  return 0;
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
      case "map":
        return await runMap(command, deps);
      case "crawl":
        return await runCrawl(command, deps);
      case "setup-skills":
        return await runSetupSkills(command, deps);
      case "auth-set":
        return await runAuthSet(deps);
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
      case "mcp":
        await runMcpServer({
          client: new DeepSeekClient({
            ...loadConfig(deps.env, deps.credentialStore),
            fetchImpl: deps.fetchImpl,
          }),
          sitemapReader: deps.sitemapReader ?? new SitemapReader(),
        });
        return 0;
    }
  } catch (error) {
    deps.stderr.write(`${errorMessage(error)}\n`);
    if (deps.signal?.aborted) {
      return 130;
    }
    return error instanceof CliUsageError || error instanceof z.ZodError ? 2 : 1;
  }
}
