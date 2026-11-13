import { z } from "zod";
import { executeFetch, executeSearch } from "../application/index.js";
import { loadConfig } from "../config.js";
import { DeepSeekClient } from "../deepseek/client.js";
import { DeepSeekError } from "../deepseek/errors.js";
import { runMcpServer } from "../mcp/server.js";
import { writeFileAtomic } from "../output/files.js";
import { formatFetchHuman, formatSearchHuman } from "../output/format.js";
import { packageVersion } from "../version.js";
import { runDoctor } from "./doctor.js";
import { CliUsageError, type ParsedCommand, parseCli } from "./parse.js";

export interface CliDependencies {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
}

const MAIN_HELP = `deepseek-websearch ${packageVersion}

Usage:
  deepseek-websearch search <query> [options]
  deepseek-websearch fetch <url> [options]
  deepseek-websearch doctor [--live] [--json]
  deepseek-websearch mcp

Run "deepseek-websearch help <command>" for command details.
`;

const COMMAND_HELP: Record<string, string> = {
  search: `Usage: deepseek-websearch search <query> [options]

Options:
  --count <1..50>
  --content
  --max-content-chars <0..1000000>
  --ori-question <text>
  --localization <ip>
  --json
  --output, -o <path>
`,
  fetch: `Usage: deepseek-websearch fetch <url> [options]

Options:
  --max-chars <0..1000000>
  --json
  --output, -o <path>
`,
  doctor: `Usage: deepseek-websearch doctor [--live] [--json]

Without --live, doctor does not make a billable DeepSeek request.
`,
  mcp: "Usage: deepseek-websearch mcp\n\nStart the MCP server over stdio.\n",
};

function resolvedDependencies(dependencies: Partial<CliDependencies>): CliDependencies {
  return {
    env: dependencies.env ?? process.env,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
    stdout: dependencies.stdout ?? process.stdout,
    stderr: dependencies.stderr ?? process.stderr,
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
  const config = loadConfig(deps.env);
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
  const config = loadConfig(deps.env);
  const client = new DeepSeekClient({ ...config, fetchImpl: deps.fetchImpl });
  const maxChars = command.output ? 0 : (command.maxChars ?? (command.json ? 0 : 30000));
  const output = await executeFetch(client, { url: command.url }, { maxChars });

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
      case "doctor":
        return await runDoctor({
          env: deps.env,
          fetchImpl: deps.fetchImpl,
          live: command.live,
          json: command.json,
          stdout: deps.stdout,
          stderr: deps.stderr,
        });
      case "mcp":
        await runMcpServer({
          client: new DeepSeekClient({ ...loadConfig(deps.env), fetchImpl: deps.fetchImpl }),
        });
        return 0;
    }
  } catch (error) {
    deps.stderr.write(`${errorMessage(error)}\n`);
    return error instanceof CliUsageError || error instanceof z.ZodError ? 2 : 1;
  }
}
