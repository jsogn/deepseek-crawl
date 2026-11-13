import { describe, expect, it } from "vitest";
import { CliUsageError, parseCli } from "../../src/cli/parse.js";

describe("parseCli", () => {
  it("parses search defaults and explicit options", () => {
    expect(
      parseCli([
        "search",
        "DeepSeek docs",
        "--count",
        "3",
        "--content",
        "--max-content-chars",
        "0",
        "--ori-question",
        "What is new?",
        "--localization",
        "203.0.113.7",
        "--json",
        "--output",
        "out.json",
      ]),
    ).toEqual({
      kind: "search",
      query: "DeepSeek docs",
      count: 3,
      needContent: true,
      maxContentChars: 0,
      oriQuestion: "What is new?",
      localization: "203.0.113.7",
      json: true,
      output: "out.json",
    });
  });

  it("parses fetch options", () => {
    expect(parseCli(["fetch", "https://example.com", "--max-chars", "20", "--json"])).toEqual({
      kind: "fetch",
      url: "https://example.com",
      maxChars: 20,
      json: true,
    });
  });

  it("parses Map options and defaults", () => {
    expect(
      parseCli(["map", "https://example.com", "--limit", "25", "--output", "urls.json"]),
    ).toEqual({
      kind: "map",
      url: "https://example.com",
      limit: 25,
      json: false,
      output: "urls.json",
    });

    expect(parseCli(["map", "https://example.com", "--json"])).toEqual({
      kind: "map",
      url: "https://example.com",
      limit: 500,
      json: true,
    });

    expect(parseCli(["map", "https://example.com", "--search", "docs", "--limit", "20"])).toEqual({
      kind: "map",
      url: "https://example.com",
      limit: 20,
      search: "docs",
      json: false,
    });
  });

  it("parses crawl options and defaults", () => {
    expect(
      parseCli([
        "crawl",
        "https://example.com",
        "--max-depth",
        "1",
        "--max-pages",
        "4",
        "--concurrency",
        "2",
        "--delay-ms",
        "0",
        "--output",
        "out",
        "--json",
      ]),
    ).toEqual({
      kind: "crawl",
      url: "https://example.com",
      maxDepth: 1,
      maxPages: 4,
      concurrency: 2,
      delayMs: 0,
      output: "out",
      json: true,
    });

    expect(parseCli(["crawl", "https://example.com", "--output", "out"])).toEqual({
      kind: "crawl",
      url: "https://example.com",
      maxDepth: 2,
      maxPages: 20,
      concurrency: 2,
      delayMs: 250,
      output: "out",
      json: false,
    });

    expect(parseCli(["crawl", "https://example.com", "-o", "out"])).toMatchObject({
      kind: "crawl",
      output: "out",
    });
  });

  it("parses doctor and help", () => {
    expect(parseCli(["doctor", "--live", "--json"])).toEqual({
      kind: "doctor",
      live: true,
      json: true,
    });
    expect(parseCli(["search", "--help"])).toEqual({ kind: "help", command: "search" });
    expect(parseCli(["--version"])).toEqual({ kind: "version" });
  });

  it("parses setup skills defaults and explicit options", () => {
    expect(parseCli(["setup", "skills"])).toEqual({
      kind: "setup-skills",
      scope: "global",
      agents: ["agents"],
      copy: false,
      force: false,
      json: false,
    });

    expect(
      parseCli([
        "setup",
        "skills",
        "--project",
        "--agent",
        "codex,cursor",
        "--copy",
        "--force",
        "--json",
      ]),
    ).toEqual({
      kind: "setup-skills",
      scope: "project",
      agents: ["codex", "cursor"],
      copy: true,
      force: true,
      json: true,
    });
  });

  it("parses auth commands", () => {
    expect(parseCli(["auth", "set"])).toEqual({ kind: "auth-set" });
    expect(parseCli(["auth", "status", "--json"])).toEqual({
      kind: "auth-status",
      json: true,
    });
    expect(parseCli(["auth", "remove", "--json"])).toEqual({
      kind: "auth-remove",
      json: true,
    });
  });

  it.each([
    [["search"], /query is required/i],
    [["fetch"], /url is required/i],
    [["search", "x", "--count", "0"], /count/i],
    [["search", "x", "--count", "1.5"], /count/i],
    [["search", "x", "--max-content-chars=-1"], /content limit/i],
    [["fetch", "https://example.com", "--max-chars=1000001"], /content limit/i],
    [["map", "https://example.com", "--limit", "0"], /limit/i],
    [["map", "https://example.com", "--limit", "1001"], /limit/i],
    [["map", "https://example.com", "--search", "   "], /search/i],
    [["map", "https://example.com", "--unknown"], /unknown option/i],
    [["crawl", "https://example.com"], /output is required/i],
    [["crawl", "https://example.com", "--output", "out", "--max-depth", "6"], /max-depth/i],
    [["crawl", "https://example.com", "--output", "out", "--max-pages", "0"], /max-pages/i],
    [["crawl", "https://example.com", "--output", "out", "--concurrency", "6"], /concurrency/i],
    [["crawl", "https://example.com", "--output", "out", "--delay-ms", "5001"], /delay-ms/i],
    [["setup"], /skills|subcommand/i],
    [["setup", "unknown"], /unknown|skills/i],
    [["setup", "skills", "--global", "--project"], /global|project/i],
    [["setup", "skills", "--agent", "unknown"], /agent/i],
    [["setup", "skills", "--unknown"], /unknown option/i],
    [["auth"], /auth|subcommand/i],
    [["auth", "unknown"], /auth|subcommand/i],
    [["auth", "set", "--json"], /unknown option/i],
    [["unknown"], /unknown command/i],
    [["search", "x", "--unknown"], /unknown option/i],
  ])("rejects invalid input %#", (argv, message) => {
    expect(() => parseCli(argv as string[])).toThrow(CliUsageError);
    expect(() => parseCli(argv as string[])).toThrow(message);
  });
});
