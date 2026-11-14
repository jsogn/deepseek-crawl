import { parseArgs } from "node:util";
import type { CrawlSitemapMode } from "../crawl/types.js";
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
      jobDir?: string;
      maxChars?: number;
      concurrency?: number;
      delayMs?: number;
      cacheTtl?: number;
      fresh?: boolean;
      json: boolean;
      output?: string;
    }
  | {
      kind: "fetch-retry";
      report: string;
      outputDir: string;
      maxChars?: number;
      concurrency: number;
      delayMs: number;
      cacheTtl?: number;
      fresh?: boolean;
      json: boolean;
    }
  | { kind: "fetch-status"; jobDir: string; json: boolean }
  | {
      kind: "fetch-resume";
      jobDir: string;
      cacheTtl?: number;
      fresh?: boolean;
      json: boolean;
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
      sitemapMode: CrawlSitemapMode;
      planOnly: boolean;
      cacheTtl?: number;
      fresh?: boolean;
      baseline?: string;
      changedOnly?: boolean;
      jobDir?: string;
      output: string;
      json: boolean;
    }
  | {
      kind: "crawl-retry";
      report: string;
      output: string;
      cacheTtl?: number;
      fresh?: boolean;
      json: boolean;
    }
  | {
      kind: "crawl-resume";
      jobDir: string;
      output: string;
      cacheTtl?: number;
      fresh?: boolean;
      json: boolean;
    }
  | { kind: "crawl-status"; jobDir: string; json: boolean }
  | {
      kind: "crawl-monitor";
      url: string;
      monitorDir: string;
      maxDepth: number;
      maxPages: number;
      concurrency: number;
      delayMs: number;
      includePaths?: string[];
      excludePaths?: string[];
      ignoreQueryParameters?: boolean;
      sitemapMode: CrawlSitemapMode;
      cacheTtl?: number;
      fresh?: boolean;
      failOnChange: boolean;
      onlyModified: boolean;
      ignoreRemoved: boolean;
      output: string;
      json: boolean;
    }
  | { kind: "crawl-monitor-status"; monitorDir: string; json: boolean }
  | { kind: "crawl-monitor-reset"; monitorDir: string; json: boolean }
  | { kind: "cache-clear"; json: boolean }
  | { kind: "doctor"; live: boolean; json: boolean }
  | { kind: "balance"; json: boolean; output?: string }
  | {
      kind: "init";
      skipAuth: boolean;
      skipSkills: boolean;
      scope: "global" | "project";
      agents: SkillAgent[];
      copy: boolean;
      force: boolean;
      json: boolean;
    }
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
  | {
      kind: "gateway";
      host: string;
      port: number;
      allowRemote: boolean;
    }
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

function parseSitemapMode(value: string): CrawlSitemapMode {
  if (!["include", "only", "skip"].includes(value)) {
    throw new CliUsageError("sitemap must be include, only, or skip.");
  }
  return value as CrawlSitemapMode;
}

function parsePatterns(value: string, name: string): string[] {
  const patterns = value.split(",").map((pattern) => pattern.trim());
  if (patterns.some((pattern) => !pattern)) {
    throw new CliUsageError(`${name} patterns must not be empty.`);
  }
  return patterns;
}

function parseCacheOptions(
  ttl: string | undefined,
  fresh: boolean | undefined,
): { cacheTtl?: number; fresh?: boolean } {
  if (fresh && ttl === undefined) {
    throw new CliUsageError("--fresh requires --cache-ttl.");
  }
  return {
    ...(ttl === undefined ? {} : { cacheTtl: parseInteger(ttl, "cache-ttl", 1, 31_536_000) }),
    ...(fresh ? { fresh: true } : {}),
  };
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
        if (args[0] === "status") {
          const parsed = parseArgs({
            args: args.slice(1),
            allowPositionals: true,
            strict: true,
            options: {
              json: { type: "boolean" },
              help: { type: "boolean", short: "h" },
            },
          });
          if (parsed.values.help) {
            return { kind: "help", command: "fetch" };
          }
          return {
            kind: "fetch-status",
            jobDir: exactPositional(parsed.positionals, "job-dir"),
            json: parsed.values.json ?? false,
          };
        }
        if (args[0] === "resume") {
          const parsed = parseArgs({
            args: args.slice(1),
            allowPositionals: true,
            strict: true,
            options: {
              "cache-ttl": { type: "string" },
              fresh: { type: "boolean" },
              json: { type: "boolean" },
              help: { type: "boolean", short: "h" },
            },
          });
          if (parsed.values.help) {
            return { kind: "help", command: "fetch" };
          }
          return {
            kind: "fetch-resume",
            jobDir: exactPositional(parsed.positionals, "job-dir"),
            ...parseCacheOptions(parsed.values["cache-ttl"], parsed.values.fresh),
            json: parsed.values.json ?? false,
          };
        }
        const parsed = parseArgs({
          args,
          allowPositionals: true,
          strict: true,
          options: {
            "max-chars": { type: "string" },
            "cache-ttl": { type: "string" },
            fresh: { type: "boolean" },
            input: { type: "string" },
            "retry-failed": { type: "string" },
            "output-dir": { type: "string" },
            "job-dir": { type: "string" },
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
        const retryFailed = parsed.values["retry-failed"]?.trim();
        const jobDir = parsed.values["job-dir"]?.trim();
        if (parsed.values["job-dir"] !== undefined && !jobDir) {
          throw new CliUsageError("job-dir requires a directory path.");
        }
        if (retryFailed !== undefined) {
          if (jobDir) {
            throw new CliUsageError("--job-dir cannot be used with --retry-failed.");
          }
          if (!retryFailed) {
            throw new CliUsageError("retry-failed requires a report path.");
          }
          if (parsed.positionals.length > 0) {
            throw new CliUsageError("fetch retry does not accept a URL.");
          }
          if (input) {
            throw new CliUsageError("--input and --retry-failed cannot be used together.");
          }
          if (!outputDir) {
            throw new CliUsageError("output-dir is required with --retry-failed.");
          }
          if (parsed.values.output !== undefined) {
            throw new CliUsageError(
              "--output cannot be used with --retry-failed; use --output-dir.",
            );
          }
          return {
            kind: "fetch-retry",
            report: retryFailed,
            outputDir,
            concurrency:
              parsed.values.concurrency === undefined
                ? 3
                : parseInteger(parsed.values.concurrency, "concurrency", 1, 5),
            delayMs:
              parsed.values["delay-ms"] === undefined
                ? 250
                : parseInteger(parsed.values["delay-ms"], "delay-ms", 0, 5000),
            ...(parsed.values["max-chars"] === undefined
              ? {}
              : { maxChars: parseContentLimit(parsed.values["max-chars"]) }),
            ...parseCacheOptions(parsed.values["cache-ttl"], parsed.values.fresh),
            json: parsed.values.json ?? false,
          };
        }
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
          if (jobDir) {
            result.jobDir = jobDir;
          }
          result.concurrency =
            parsed.values.concurrency === undefined
              ? 3
              : parseInteger(parsed.values.concurrency, "concurrency", 1, 5);
          result.delayMs =
            parsed.values["delay-ms"] === undefined
              ? 250
              : parseInteger(parsed.values["delay-ms"], "delay-ms", 0, 5000);
        } else {
          if (jobDir) {
            throw new CliUsageError("--job-dir requires --input.");
          }
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
        Object.assign(result, parseCacheOptions(parsed.values["cache-ttl"], parsed.values.fresh));
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
        if (args[0] === "monitor") {
          const subcommand = args[1];
          if (subcommand === "status" || subcommand === "reset") {
            const parsed = parseArgs({
              args: args.slice(2),
              allowPositionals: true,
              strict: true,
              options: {
                json: { type: "boolean" },
                help: { type: "boolean", short: "h" },
              },
            });
            if (parsed.values.help) {
              return { kind: "help", command: "crawl" };
            }
            return {
              kind: subcommand === "status" ? "crawl-monitor-status" : "crawl-monitor-reset",
              monitorDir: exactPositional(parsed.positionals, "monitor-dir"),
              json: parsed.values.json ?? false,
            };
          }

          const parsed = parseArgs({
            args: args.slice(1),
            allowPositionals: true,
            strict: true,
            options: {
              "monitor-dir": { type: "string" },
              "max-depth": { type: "string" },
              "max-pages": { type: "string" },
              concurrency: { type: "string" },
              "delay-ms": { type: "string" },
              "include-paths": { type: "string" },
              "exclude-paths": { type: "string" },
              "ignore-query-parameters": { type: "boolean" },
              sitemap: { type: "string" },
              "cache-ttl": { type: "string" },
              fresh: { type: "boolean" },
              "fail-on-change": { type: "boolean" },
              "only-modified": { type: "boolean" },
              "ignore-removed": { type: "boolean" },
              output: { type: "string", short: "o" },
              json: { type: "boolean" },
              help: { type: "boolean", short: "h" },
            },
          });
          if (parsed.values.help) {
            return { kind: "help", command: "crawl" };
          }
          const monitorDir = parsed.values["monitor-dir"]?.trim();
          if (!monitorDir) {
            throw new CliUsageError("monitor-dir is required.");
          }
          const output = parsed.values.output?.trim();
          if (!output) {
            throw new CliUsageError("output is required.");
          }
          return {
            kind: "crawl-monitor",
            url: exactPositional(parsed.positionals, "url"),
            monitorDir,
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
            ...(parsed.values["ignore-query-parameters"] ? { ignoreQueryParameters: true } : {}),
            sitemapMode:
              parsed.values.sitemap === undefined
                ? "include"
                : parseSitemapMode(parsed.values.sitemap),
            ...parseCacheOptions(parsed.values["cache-ttl"], parsed.values.fresh),
            failOnChange: parsed.values["fail-on-change"] ?? false,
            onlyModified: parsed.values["only-modified"] ?? false,
            ignoreRemoved: parsed.values["ignore-removed"] ?? false,
            output,
            json: parsed.values.json ?? false,
          };
        }
        if (args[0] === "resume") {
          const parsed = parseArgs({
            args: args.slice(1),
            allowPositionals: true,
            strict: true,
            options: {
              "cache-ttl": { type: "string" },
              fresh: { type: "boolean" },
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
            kind: "crawl-resume",
            jobDir: exactPositional(parsed.positionals, "job-dir"),
            output,
            ...parseCacheOptions(parsed.values["cache-ttl"], parsed.values.fresh),
            json: parsed.values.json ?? false,
          };
        }
        if (args[0] === "status") {
          const parsed = parseArgs({
            args: args.slice(1),
            allowPositionals: true,
            strict: true,
            options: {
              json: { type: "boolean" },
              help: { type: "boolean", short: "h" },
            },
          });
          if (parsed.values.help) {
            return { kind: "help", command: "crawl" };
          }
          return {
            kind: "crawl-status",
            jobDir: exactPositional(parsed.positionals, "job-dir"),
            json: parsed.values.json ?? false,
          };
        }
        const parsed = parseArgs({
          args,
          allowPositionals: true,
          strict: true,
          options: {
            "max-depth": { type: "string" },
            "max-pages": { type: "string" },
            baseline: { type: "string" },
            "changed-only": { type: "boolean" },
            "job-dir": { type: "string" },
            "cache-ttl": { type: "string" },
            fresh: { type: "boolean" },
            concurrency: { type: "string" },
            "delay-ms": { type: "string" },
            "include-paths": { type: "string" },
            "exclude-paths": { type: "string" },
            "ignore-query-parameters": { type: "boolean" },
            "plan-only": { type: "boolean" },
            "retry-failed": { type: "string" },
            sitemap: { type: "string" },
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
        const retryFailed = parsed.values["retry-failed"]?.trim();
        if (retryFailed !== undefined) {
          if (!retryFailed) {
            throw new CliUsageError("retry-failed requires a report path.");
          }
          if (parsed.positionals.length > 0) {
            throw new CliUsageError("crawl retry does not accept a URL.");
          }
          if (parsed.values["plan-only"]) {
            throw new CliUsageError("--plan-only cannot be used with --retry-failed.");
          }
          const incompatible =
            parsed.values["max-depth"] !== undefined ||
            parsed.values["max-pages"] !== undefined ||
            parsed.values.concurrency !== undefined ||
            parsed.values["delay-ms"] !== undefined ||
            parsed.values["include-paths"] !== undefined ||
            parsed.values["exclude-paths"] !== undefined ||
            parsed.values["ignore-query-parameters"] ||
            parsed.values.baseline !== undefined ||
            parsed.values["changed-only"] ||
            parsed.values["job-dir"] !== undefined ||
            parsed.values.sitemap !== undefined;
          if (incompatible) {
            throw new CliUsageError("Crawl retry uses settings from the existing report.");
          }
          return {
            kind: "crawl-retry",
            report: retryFailed,
            output,
            ...parseCacheOptions(parsed.values["cache-ttl"], parsed.values.fresh),
            json: parsed.values.json ?? false,
          };
        }
        const baseline = parsed.values.baseline?.trim();
        const changedOnly = parsed.values["changed-only"] ?? false;
        const jobDir = parsed.values["job-dir"]?.trim();
        if (parsed.values.baseline !== undefined && !baseline) {
          throw new CliUsageError("baseline requires a report path.");
        }
        if (changedOnly && !baseline) {
          throw new CliUsageError("--changed-only requires --baseline.");
        }
        if (parsed.values["plan-only"] && baseline) {
          throw new CliUsageError("--baseline cannot be used with --plan-only.");
        }
        if (parsed.values["job-dir"] !== undefined && !jobDir) {
          throw new CliUsageError("job-dir requires a directory path.");
        }
        if (jobDir && parsed.values["plan-only"]) {
          throw new CliUsageError("--job-dir cannot be used with --plan-only.");
        }
        if (jobDir && baseline) {
          throw new CliUsageError("--job-dir cannot be used with --baseline.");
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
          ...(parsed.values["ignore-query-parameters"] ? { ignoreQueryParameters: true } : {}),
          sitemapMode:
            parsed.values.sitemap === undefined
              ? "include"
              : parseSitemapMode(parsed.values.sitemap),
          planOnly: parsed.values["plan-only"] ?? false,
          ...parseCacheOptions(parsed.values["cache-ttl"], parsed.values.fresh),
          ...(baseline ? { baseline, changedOnly } : {}),
          ...(jobDir ? { jobDir } : {}),
          output,
          json: parsed.values.json ?? false,
        };
      }
      case "cache": {
        if (args[0] === "--help" || args[0] === "-h") {
          return { kind: "help", command: "cache" };
        }
        if (args[0] !== "clear") {
          throw new CliUsageError("cache subcommand clear is required.");
        }
        const parsed = parseArgs({
          args: args.slice(1),
          allowPositionals: false,
          strict: true,
          options: {
            json: { type: "boolean" },
            help: { type: "boolean", short: "h" },
          },
        });
        return parsed.values.help
          ? { kind: "help", command: "cache" }
          : { kind: "cache-clear", json: parsed.values.json ?? false };
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
      case "balance": {
        const parsed = parseArgs({
          args,
          allowPositionals: false,
          strict: true,
          options: {
            json: { type: "boolean" },
            output: { type: "string", short: "o" },
            help: { type: "boolean", short: "h" },
          },
        });
        if (parsed.values.help) {
          return { kind: "help", command: "balance" };
        }
        return {
          kind: "balance",
          json: parsed.values.json ?? false,
          ...(parsed.values.output === undefined ? {} : { output: parsed.values.output }),
        };
      }
      case "init": {
        const parsed = parseArgs({
          args,
          allowPositionals: false,
          strict: true,
          options: {
            "skip-auth": { type: "boolean" },
            "skip-skills": { type: "boolean" },
            project: { type: "boolean", short: "p" },
            agent: { type: "string", short: "a" },
            copy: { type: "boolean" },
            force: { type: "boolean" },
            json: { type: "boolean" },
            help: { type: "boolean", short: "h" },
          },
        });
        if (parsed.values.help) {
          return { kind: "help", command: "init" };
        }
        if (
          parsed.values["skip-skills"] &&
          (parsed.values.project ||
            parsed.values.agent !== undefined ||
            parsed.values.copy ||
            parsed.values.force)
        ) {
          throw new CliUsageError(
            "--project, --agent, --copy, and --force cannot be used with --skip-skills.",
          );
        }
        return {
          kind: "init",
          skipAuth: parsed.values["skip-auth"] ?? false,
          skipSkills: parsed.values["skip-skills"] ?? false,
          scope: parsed.values.project ? "project" : "global",
          agents: parseSkillAgents(parsed.values.agent),
          copy: parsed.values.copy ?? false,
          force: parsed.values.force ?? false,
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
      case "gateway": {
        const parsed = parseArgs({
          args,
          allowPositionals: false,
          strict: true,
          options: {
            host: { type: "string" },
            port: { type: "string" },
            "allow-remote": { type: "boolean" },
            help: { type: "boolean", short: "h" },
          },
        });
        if (parsed.values.help) {
          return { kind: "help", command: "gateway" };
        }
        const host = parsed.values.host === undefined ? "127.0.0.1" : parsed.values.host.trim();
        if (!host) {
          throw new CliUsageError("Gateway host is required.");
        }
        return {
          kind: "gateway",
          host,
          port:
            parsed.values.port === undefined
              ? 8787
              : parseInteger(parsed.values.port, "port", 1, 65_535),
          allowRemote: parsed.values["allow-remote"] ?? false,
        };
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
