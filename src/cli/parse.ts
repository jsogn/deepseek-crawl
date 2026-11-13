import { parseArgs } from "node:util";
import { parseSkillAgents, type SkillAgent } from "../setup/skills.js";

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export type ParsedCommand =
  | {
      kind: "search";
      query: string;
      count?: number;
      needContent: boolean;
      maxContentChars?: number;
      oriQuestion?: string;
      localization?: string;
      json: boolean;
      output?: string;
    }
  | {
      kind: "fetch";
      url?: string;
      input?: string;
      outputDir?: string;
      maxChars?: number;
      concurrency?: number;
      delayMs?: number;
      json: boolean;
      output?: string;
    }
  | {
      kind: "map";
      url: string;
      limit: number;
      search?: string;
      json: boolean;
      output?: string;
    }
  | {
      kind: "crawl";
      url: string;
      maxDepth: number;
      maxPages: number;
      concurrency: number;
      delayMs: number;
      includePaths?: string[];
      excludePaths?: string[];
      ignoreQueryParameters?: boolean;
      output: string;
      json: boolean;
    }
  | { kind: "doctor"; live: boolean; json: boolean }
  | {
      kind: "setup-skills";
      scope: "global" | "project";
      agents: SkillAgent[];
      copy: boolean;
      force: boolean;
      json: boolean;
    }
  | { kind: "auth-set" }
  | { kind: "auth-status"; json: boolean }
  | { kind: "auth-remove"; json: boolean }
  | { kind: "mcp" }
  | { kind: "help"; command?: string }
  | { kind: "version" };

function parseInteger(value: string, label: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) {
    throw new CliUsageError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliUsageError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function parseContentLimit(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CliUsageError("Content limit must be an integer from 0 to 1000000.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1000000) {
    throw new CliUsageError("Content limit must be an integer from 0 to 1000000.");
  }
  return parsed;
}

function parsePatterns(value: string, name: string): string[] {
  const patterns = value.split(",").map((pattern) => pattern.trim());
  if (patterns.some((pattern) => !pattern)) {
    throw new CliUsageError(`${name} patterns must not be empty.`);
  }
  return patterns;
}

function exactPositional(positionals: string[], name: string): string {
  if (positionals.length === 0) {
    throw new CliUsageError(`${name} is required.`);
  }
  if (positionals.length > 1) {
    throw new CliUsageError(`Unexpected argument: ${positionals.slice(1).join(" ")}`);
  }
  const value = positionals[0];
  if (value === undefined || value.trim() === "") {
    throw new CliUsageError(`${name} is required.`);
  }
  return value;
}

export function parseCli(argv: string[]): ParsedCommand {
  if (argv.length === 1 && ["--version", "-v"].includes(argv[0] ?? "")) {
    return { kind: "version" };
  }
  if (argv.length === 0 || ["--help", "-h"].includes(argv[0] ?? "")) {
    return { kind: "help" };
  }

  const command = argv[0];
  const args = argv.slice(1);
  if (command === "help") {
    return args[0] ? { kind: "help", command: args[0] } : { kind: "help" };
  }

  try {
    switch (command) {
      case "search": {
        const parsed = parseArgs({
          args,
          allowPositionals: true,
          strict: true,
          options: {
            count: { type: "string" },
            content: { type: "boolean" },
            "max-content-chars": { type: "string" },
            "ori-question": { type: "string" },
            localization: { type: "string" },
            json: { type: "boolean" },
            output: { type: "string", short: "o" },
            help: { type: "boolean", short: "h" },
          },
        });
        if (parsed.values.help) {
          return { kind: "help", command: "search" };
        }
        const result: ParsedCommand = {
          kind: "search",
          query: exactPositional(parsed.positionals, "query"),
          needContent: parsed.values.content ?? false,
          json: parsed.values.json ?? false,
        };
        if (parsed.values.count !== undefined) {
          result.count = parseInteger(parsed.values.count, "count", 1, 50);
        }
        if (parsed.values["max-content-chars"] !== undefined) {
          result.maxContentChars = parseContentLimit(parsed.values["max-content-chars"]);
        }
        if (parsed.values["ori-question"] !== undefined) {
          result.oriQuestion = parsed.values["ori-question"];
        }
        if (parsed.values.localization !== undefined) {
          result.localization = parsed.values.localization;
        }
        if (parsed.values.output !== undefined) {
          result.output = parsed.values.output;
        }
        return result;
      }
      case "fetch": {
        const parsed = parseArgs({
          args,
          allowPositionals: true,
          strict: true,
          options: {
            "max-chars": { type: "string" },
            input: { type: "string" },
            "output-dir": { type: "string" },
            concurrency: { type: "string" },
            "delay-ms": { type: "string" },
            json: { type: "boolean" },
            output: { type: "string", short: "o" },
            help: { type: "boolean", short: "h" },
          },
        });
        if (parsed.values.help) {
          return { kind: "help", command: "fetch" };
        }
        const result: ParsedCommand = { kind: "fetch", json: parsed.values.json ?? false };
        const input = parsed.values.input?.trim();
        const outputDir = parsed.values["output-dir"]?.trim();
        if (input) {
          if (parsed.positionals.length > 0) {
            throw new CliUsageError("fetch accepts either a URL or --input, not both.");
          }
          if (!outputDir) {
            throw new CliUsageError("output-dir is required with --input.");
          }
          if (parsed.values.output !== undefined) {
            throw new CliUsageError("--output cannot be used with --input; use --output-dir.");
          }
          result.input = input;
          result.outputDir = outputDir;
          result.concurrency =
            parsed.values.concurrency === undefined
              ? 3
              : parseInteger(parsed.values.concurrency, "concurrency", 1, 5);
          result.delayMs =
            parsed.values["delay-ms"] === undefined
              ? 250
              : parseInteger(parsed.values["delay-ms"], "delay-ms", 0, 5000);
        } else {
          result.url = exactPositional(parsed.positionals, "url");
          if (outputDir !== undefined) {
            throw new CliUsageError("--output-dir requires --input.");
          }
          if (parsed.values.concurrency !== undefined) {
            throw new CliUsageError("--concurrency requires --input.");
          }
          if (parsed.values["delay-ms"] !== undefined) {
            throw new CliUsageError("--delay-ms requires --input.");
          }
        }
        if (parsed.values["max-chars"] !== undefined) {
          result.maxChars = parseContentLimit(parsed.values["max-chars"]);
        }
        if (parsed.values.output !== undefined) {
          result.output = parsed.values.output;
        }
        return result;
      }
      case "map": {
        const parsed = parseArgs({
          args,
          allowPositionals: true,
          strict: true,
          options: {
            limit: { type: "string" },
            search: { type: "string" },
            json: { type: "boolean" },
            output: { type: "string", short: "o" },
            help: { type: "boolean", short: "h" },
          },
        });
        if (parsed.values.help) {
          return { kind: "help", command: "map" };
        }
        const result: ParsedCommand = {
          kind: "map",
          url: exactPositional(parsed.positionals, "url"),
          limit:
            parsed.values.limit === undefined
              ? 500
              : parseInteger(parsed.values.limit, "limit", 1, 1000),
          json: parsed.values.json ?? false,
        };
        if (parsed.values.search !== undefined) {
          const search = parsed.values.search.trim();
          if (!search) {
            throw new CliUsageError("search must contain non-whitespace text.");
          }
          result.search = search;
        }
        if (parsed.values.output !== undefined) {
          result.output = parsed.values.output;
        }
        return result;
      }
      case "crawl": {
        const parsed = parseArgs({
          args,
          allowPositionals: true,
          strict: true,
          options: {
            "max-depth": { type: "string" },
            "max-pages": { type: "string" },
            concurrency: { type: "string" },
            "delay-ms": { type: "string" },
            "include-paths": { type: "string" },
            "exclude-paths": { type: "string" },
            "ignore-query-parameters": { type: "boolean" },
            output: { type: "string", short: "o" },
            json: { type: "boolean" },
            help: { type: "boolean", short: "h" },
          },
        });
        if (parsed.values.help) {
          return { kind: "help", command: "crawl" };
        }
        const output = parsed.values.output?.trim();
        if (!output) {
          throw new CliUsageError("output is required.");
        }
        return {
          kind: "crawl",
          url: exactPositional(parsed.positionals, "url"),
          maxDepth:
            parsed.values["max-depth"] === undefined
              ? 2
              : parseInteger(parsed.values["max-depth"], "max-depth", 0, 5),
          maxPages:
            parsed.values["max-pages"] === undefined
              ? 20
              : parseInteger(parsed.values["max-pages"], "max-pages", 1, 100),
          concurrency:
            parsed.values.concurrency === undefined
              ? 2
              : parseInteger(parsed.values.concurrency, "concurrency", 1, 5),
          delayMs:
            parsed.values["delay-ms"] === undefined
              ? 250
              : parseInteger(parsed.values["delay-ms"], "delay-ms", 0, 5000),
          ...(parsed.values["include-paths"] === undefined
            ? {}
            : { includePaths: parsePatterns(parsed.values["include-paths"], "include-paths") }),
          ...(parsed.values["exclude-paths"] === undefined
            ? {}
            : { excludePaths: parsePatterns(parsed.values["exclude-paths"], "exclude-paths") }),
          ...(parsed.values["ignore-query-parameters"]
            ? { ignoreQueryParameters: true }
            : {}),
          output,
          json: parsed.values.json ?? false,
        };
      }
      case "doctor": {
        const parsed = parseArgs({
          args,
          allowPositionals: false,
          strict: true,
          options: {
            live: { type: "boolean" },
            json: { type: "boolean" },
            help: { type: "boolean", short: "h" },
          },
        });
        return parsed.values.help
          ? { kind: "help", command: "doctor" }
          : {
              kind: "doctor",
              live: parsed.values.live ?? false,
              json: parsed.values.json ?? false,
            };
      }
      case "setup": {
        if (args[0] === "--help" || args[0] === "-h") {
          return { kind: "help", command: "setup" };
        }
        if (args[0] !== "skills") {
          throw new CliUsageError("setup subcommand skills is required.");
        }
        const parsed = parseArgs({
          args: args.slice(1),
          allowPositionals: false,
          strict: true,
          options: {
            global: { type: "boolean", short: "g" },
            project: { type: "boolean", short: "p" },
            agent: { type: "string", short: "a" },
            copy: { type: "boolean" },
            force: { type: "boolean" },
            json: { type: "boolean" },
            help: { type: "boolean", short: "h" },
          },
        });
        if (parsed.values.help) {
          return { kind: "help", command: "setup" };
        }
        if (parsed.values.global && parsed.values.project) {
          throw new CliUsageError("--global and --project cannot be used together.");
        }
        return {
          kind: "setup-skills",
          scope: parsed.values.project ? "project" : "global",
          agents: parseSkillAgents(parsed.values.agent),
          copy: parsed.values.copy ?? false,
          force: parsed.values.force ?? false,
          json: parsed.values.json ?? false,
        };
      }
      case "auth": {
        const subcommand = args[0];
        if (subcommand === "--help" || subcommand === "-h") {
          return { kind: "help", command: "auth" };
        }
        if (subcommand === "set") {
          const parsed = parseArgs({
            args: args.slice(1),
            allowPositionals: false,
            strict: true,
            options: { help: { type: "boolean", short: "h" } },
          });
          return parsed.values.help ? { kind: "help", command: "auth" } : { kind: "auth-set" };
        }
        if (subcommand === "status" || subcommand === "remove") {
          const parsed = parseArgs({
            args: args.slice(1),
            allowPositionals: false,
            strict: true,
            options: {
              json: { type: "boolean" },
              help: { type: "boolean", short: "h" },
            },
          });
          if (parsed.values.help) {
            return { kind: "help", command: "auth" };
          }
          return {
            kind: subcommand === "status" ? "auth-status" : "auth-remove",
            json: parsed.values.json ?? false,
          };
        }
        throw new CliUsageError(
          subcommand
            ? `Unknown auth subcommand: ${subcommand}`
            : "auth subcommand set, status, or remove is required.",
        );
      }
      case "mcp": {
        const parsed = parseArgs({
          args,
          allowPositionals: false,
          strict: true,
          options: { help: { type: "boolean", short: "h" } },
        });
        return parsed.values.help ? { kind: "help", command: "mcp" } : { kind: "mcp" };
      }
      default:
        throw new CliUsageError(`Unknown command: ${command ?? ""}`);
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw error;
    }
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}
