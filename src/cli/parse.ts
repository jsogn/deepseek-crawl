import { parseArgs } from "node:util";

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
      url: string;
      maxChars?: number;
      json: boolean;
      output?: string;
    }
  | { kind: "doctor"; live: boolean; json: boolean }
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
            json: { type: "boolean" },
            output: { type: "string", short: "o" },
            help: { type: "boolean", short: "h" },
          },
        });
        if (parsed.values.help) {
          return { kind: "help", command: "fetch" };
        }
        const result: ParsedCommand = {
          kind: "fetch",
          url: exactPositional(parsed.positionals, "url"),
          json: parsed.values.json ?? false,
        };
        if (parsed.values["max-chars"] !== undefined) {
          result.maxChars = parseContentLimit(parsed.values["max-chars"]);
        }
        if (parsed.values.output !== undefined) {
          result.output = parsed.values.output;
        }
        return result;
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
