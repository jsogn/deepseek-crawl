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

    expect(
      parseCli([
        "fetch",
        "--input",
        "urls.json",
        "--output-dir",
        "pages",
        "--concurrency",
        "3",
        "--delay-ms",
        "100",
        "--max-chars",
        "5000",
        "--json",
      ]),
    ).toEqual({
      kind: "fetch",
      input: "urls.json",
      outputDir: "pages",
      maxChars: 5000,
      concurrency: 3,
      delayMs: 100,
      json: true,
    });

    expect(
      parseCli([
        "fetch",
        "--retry-failed",
        "fetch.json",
        "--output-dir",
        "retry",
        "--concurrency",
        "2",
        "--delay-ms",
        "0",
        "--max-chars",
        "5000",
        "--cache-ttl",
        "30",
        "--fresh",
        "--json",
      ]),
    ).toEqual({
      kind: "fetch-retry",
      report: "fetch.json",
      outputDir: "retry",
      maxChars: 5000,
      concurrency: 2,
      delayMs: 0,
      cacheTtl: 30,
      fresh: true,
      json: true,
    });

    expect(
      parseCli(["fetch", "https://example.com", "--cache-ttl", "60", "--fresh", "--json"]),
    ).toEqual({
      kind: "fetch",
      url: "https://example.com",
      cacheTtl: 60,
      fresh: true,
      json: true,
    });
  });

  it("parses Batch Fetch job commands", () => {
    expect(
      parseCli([
        "fetch",
        "--input",
        "urls.json",
        "--output-dir",
        "pages",
        "--job-dir",
        "job",
        "--json",
      ]),
    ).toEqual({
      kind: "fetch",
      input: "urls.json",
      outputDir: "pages",
      jobDir: "job",
      concurrency: 3,
      delayMs: 250,
      json: true,
    });
    expect(parseCli(["fetch", "status", "job", "--json"])).toEqual({
      kind: "fetch-status",
      jobDir: "job",
      json: true,
    });
    expect(parseCli(["fetch", "resume", "job", "--cache-ttl", "60", "--fresh", "--json"])).toEqual({
      kind: "fetch-resume",
      jobDir: "job",
      cacheTtl: 60,
      fresh: true,
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
        "--include-paths",
        "/docs/*,/api/?",
        "--exclude-paths",
        "/docs/private/*",
        "--ignore-query-parameters",
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
      includePaths: ["/docs/*", "/api/?"],
      excludePaths: ["/docs/private/*"],
      ignoreQueryParameters: true,
      sitemapMode: "include",
      planOnly: false,
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
      sitemapMode: "include",
      planOnly: false,
      output: "out",
      json: false,
    });

    expect(
      parseCli(["crawl", "https://example.com", "--sitemap", "only", "--output", "out"]),
    ).toMatchObject({
      kind: "crawl",
      sitemapMode: "only",
      planOnly: false,
      output: "out",
    });

    expect(
      parseCli([
        "crawl",
        "https://example.com",
        "--baseline",
        "previous/crawl.json",
        "--changed-only",
        "--output",
        "changes",
      ]),
    ).toMatchObject({
      kind: "crawl",
      baseline: "previous/crawl.json",
      changedOnly: true,
      output: "changes",
    });

    expect(parseCli(["crawl", "https://example.com", "-o", "out"])).toMatchObject({
      kind: "crawl",
      sitemapMode: "include",
      planOnly: false,
      output: "out",
    });

    expect(
      parseCli(["crawl", "https://example.com", "--plan-only", "-o", "plan.json"]),
    ).toMatchObject({
      kind: "crawl",
      sitemapMode: "include",
      planOnly: true,
      output: "plan.json",
    });

    expect(
      parseCli([
        "crawl",
        "--retry-failed",
        "crawl.json",
        "-o",
        "retry",
        "--cache-ttl",
        "30",
        "--fresh",
        "--json",
      ]),
    ).toEqual({
      kind: "crawl-retry",
      report: "crawl.json",
      output: "retry",
      cacheTtl: 30,
      fresh: true,
      json: true,
    });

    expect(
      parseCli([
        "crawl",
        "https://example.com",
        "--cache-ttl",
        "120",
        "--fresh",
        "--output",
        "out",
      ]),
    ).toMatchObject({
      kind: "crawl",
      cacheTtl: 120,
      fresh: true,
      output: "out",
    });

    expect(
      parseCli(["crawl", "https://example.com", "--job-dir", "job", "--output", "out"]),
    ).toMatchObject({
      kind: "crawl",
      jobDir: "job",
      output: "out",
    });
  });

  it("parses cache clear", () => {
    expect(parseCli(["cache", "clear"])).toEqual({ kind: "cache-clear", json: false });
    expect(parseCli(["cache", "clear", "--json"])).toEqual({
      kind: "cache-clear",
      json: true,
    });
  });

  it("parses Crawl resume and status commands", () => {
    expect(
      parseCli(["crawl", "resume", "job", "--output", "out", "--cache-ttl", "60", "--json"]),
    ).toEqual({
      kind: "crawl-resume",
      jobDir: "job",
      output: "out",
      cacheTtl: 60,
      json: true,
    });
    expect(parseCli(["crawl", "status", "job", "--json"])).toEqual({
      kind: "crawl-status",
      jobDir: "job",
      json: true,
    });
  });

  it("parses Crawl monitor commands", () => {
    expect(
      parseCli([
        "crawl",
        "monitor",
        "https://example.com/",
        "--monitor-dir",
        "monitor",
        "--output",
        "runs",
        "--max-depth",
        "1",
        "--fail-on-change",
        "--only-modified",
        "--ignore-removed",
        "--cache-ttl",
        "60",
        "--json",
      ]),
    ).toMatchObject({
      kind: "crawl-monitor",
      url: "https://example.com/",
      monitorDir: "monitor",
      output: "runs",
      maxDepth: 1,
      failOnChange: true,
      onlyModified: true,
      ignoreRemoved: true,
      cacheTtl: 60,
      json: true,
    });
    expect(parseCli(["crawl", "monitor", "status", "monitor", "--json"])).toEqual({
      kind: "crawl-monitor-status",
      monitorDir: "monitor",
      json: true,
    });
    expect(parseCli(["crawl", "monitor", "reset", "monitor", "--json"])).toEqual({
      kind: "crawl-monitor-reset",
      monitorDir: "monitor",
      json: true,
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

  it("parses balance output options", () => {
    expect(parseCli(["balance"])).toEqual({
      kind: "balance",
      json: false,
    });
    expect(parseCli(["balance", "--json", "--output", "balance.json"])).toEqual({
      kind: "balance",
      json: true,
      output: "balance.json",
    });
  });

  it("parses init setup options", () => {
    expect(parseCli(["init"])).toEqual({
      kind: "init",
      skipAuth: false,
      skipSkills: false,
      scope: "global",
      agents: ["agents"],
      copy: false,
      force: false,
      json: false,
    });
    expect(
      parseCli([
        "init",
        "--skip-auth",
        "--project",
        "--agent",
        "codex,cursor",
        "--copy",
        "--force",
        "--json",
      ]),
    ).toEqual({
      kind: "init",
      skipAuth: true,
      skipSkills: false,
      scope: "project",
      agents: ["codex", "cursor"],
      copy: true,
      force: true,
      json: true,
    });
    expect(parseCli(["init", "--skip-auth", "--skip-skills"])).toEqual({
      kind: "init",
      skipAuth: true,
      skipSkills: true,
      scope: "global",
      agents: ["agents"],
      copy: false,
      force: false,
      json: false,
    });
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
    [["fetch", "https://example.com", "--input", "urls.json"], /input|url/i],
    [["fetch", "https://example.com", "--job-dir", "job"], /job-dir|input/i],
    [["fetch", "--input", "urls.json"], /output-dir/i],
    [["fetch", "--input", "urls.json", "--job-dir", "job"], /output-dir/i],
    [["fetch", "--input", "urls.json", "--output-dir", "pages", "--output", "out"], /output/i],
    [["fetch", "--retry-failed", "fetch.json", "--output-dir", "retry", "url"], /retry|URL/i],
    [
      ["fetch", "--retry-failed", "fetch.json", "--input", "urls.json", "--output-dir", "retry"],
      /retry|input/i,
    ],
    [["fetch", "--retry-failed", "fetch.json"], /output-dir/i],
    [
      ["fetch", "--retry-failed", "fetch.json", "--output-dir", "retry", "--job-dir", "job"],
      /job-dir|retry/i,
    ],
    [
      ["fetch", "--retry-failed", "fetch.json", "--output-dir", "retry", "--output", "out"],
      /output/i,
    ],
    [["fetch", "status"], /job-dir|required/i],
    [["fetch", "resume"], /job-dir|required/i],
    [["fetch", "https://example.com", "--concurrency", "2"], /concurrency/i],
    [["map", "https://example.com", "--limit", "0"], /limit/i],
    [["map", "https://example.com", "--limit", "1001"], /limit/i],
    [["map", "https://example.com", "--search", "   "], /search/i],
    [["map", "https://example.com", "--unknown"], /unknown option/i],
    [["crawl", "https://example.com"], /output is required/i],
    [["crawl", "https://example.com", "--output", "out", "--max-depth", "6"], /max-depth/i],
    [["crawl", "https://example.com", "--output", "out", "--max-pages", "0"], /max-pages/i],
    [["crawl", "https://example.com", "--output", "out", "--concurrency", "6"], /concurrency/i],
    [["crawl", "https://example.com", "--output", "out", "--delay-ms", "5001"], /delay-ms/i],
    [["crawl", "https://example.com", "--output", "out", "--sitemap", "sometimes"], /sitemap/i],
    [["crawl", "--retry-failed", "crawl.json"], /output is required/i],
    [
      ["crawl", "--retry-failed", "crawl.json", "https://example.com", "-o", "retry"],
      /retry|argument/i,
    ],
    [["crawl", "--retry-failed", "crawl.json", "-o", "retry", "--plan-only"], /retry|plan/i],
    [["crawl", "https://example.com", "-o", "out", "--changed-only"], /baseline/i],
    [
      [
        "crawl",
        "https://example.com",
        "-o",
        "plan.json",
        "--plan-only",
        "--baseline",
        "crawl.json",
      ],
      /baseline|plan/i,
    ],
    [["crawl", "https://example.com", "-o", "out", "--job-dir", "job", "--plan-only"], /job|plan/i],
    [["crawl", "resume", "job"], /output is required/i],
    [["crawl", "status"], /job-dir|required/i],
    [["crawl", "monitor", "https://example.com/", "--output", "runs"], /monitor-dir/i],
    [["crawl", "monitor", "https://example.com/", "--monitor-dir", "state"], /output is required/i],
    [["crawl", "monitor", "status"], /monitor-dir|required/i],
    [["setup"], /skills|subcommand/i],
    [["setup", "unknown"], /unknown|skills/i],
    [["setup", "skills", "--global", "--project"], /global|project/i],
    [["setup", "skills", "--agent", "unknown"], /agent/i],
    [["setup", "skills", "--unknown"], /unknown option/i],
    [["auth"], /auth|subcommand/i],
    [["auth", "unknown"], /auth|subcommand/i],
    [["auth", "set", "--json"], /unknown option/i],
    [["balance", "extra"], /argument|unknown option/i],
    [["balance", "--live"], /unknown option/i],
    [["init", "--skip-skills", "--project"], /skip-skills|project/i],
    [["init", "--skip-skills", "--agent", "codex"], /skip-skills|agent/i],
    [["init", "--skip-skills", "--copy"], /skip-skills|copy/i],
    [["init", "--skip-skills", "--force"], /skip-skills|force/i],
    [["unknown"], /unknown command/i],
    [["search", "x", "--unknown"], /unknown option/i],
    [["fetch", "https://example.com", "--cache-ttl", "0"], /cache-ttl/i],
    [["fetch", "https://example.com", "--fresh"], /fresh|cache-ttl/i],
    [["crawl", "https://example.com", "--output", "out", "--cache-ttl", "0"], /cache-ttl/i],
    [["cache"], /clear|subcommand/i],
    [["cache", "unknown"], /clear|subcommand/i],
  ])("rejects invalid input %#", (argv, message) => {
    expect(() => parseCli(argv as string[])).toThrow(CliUsageError);
    expect(() => parseCli(argv as string[])).toThrow(message);
  });
});
