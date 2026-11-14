import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { FileFetchCache } from "../../src/cache/file-cache.js";
import { runCli } from "../../src/cli/run.js";
import { contentHash } from "../../src/content/hash.js";

const searchResponse = {
  results: [
    {
      rerank_score: 2.4,
      title: "Result",
      url: "https://example.com/result",
      snippet: "Short",
      summary: "Summary",
      content: "abcdef",
      site_name: "Example",
      site_icon: null,
      date: null,
      authority: 3,
    },
  ],
};

function writer() {
  let value = "";
  return {
    write(chunk: string) {
      value += chunk;
      return true;
    },
    value: () => value,
  };
}

function dependencies(
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "key" },
) {
  const stdout = writer();
  const stderr = writer();
  const credentialStore = {
    name: "keychain" as const,
    get: () => undefined,
    set: () => undefined,
    remove: () => undefined,
  };
  return {
    deps: { env, fetchImpl, stdout, stderr, credentialStore },
    stdout,
    stderr,
  };
}

function sitemap(urls: URL[] = []) {
  return {
    read: vi.fn(async () => ({
      entries: urls.map((url) => ({ url })),
      warnings: [],
      truncated: false,
    })),
  };
}

describe("runCli", () => {
  it("documents the Crawl Sitemap flag", async () => {
    const { deps, stdout } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(await runCli(["help", "crawl"], deps)).toBe(0);
    expect(stdout.value()).toContain("--sitemap <include|only|skip> (default: include)");
    expect(stdout.value()).toContain("--plan-only");
    expect(stdout.value()).toContain("--retry-failed");
    expect(stdout.value()).toContain("crawl monitor");
    expect(stdout.value()).toContain("--fail-on-change");
  });

  it("clears the configured Fetch cache without an API key", async () => {
    const fetchCache = {
      location: "/tmp/deepseek-cache",
      read: vi.fn(),
      write: vi.fn(),
      clear: vi.fn(async () => undefined),
    };
    const { deps, stdout } = dependencies(vi.fn() as unknown as typeof fetch, {});

    expect(await runCli(["cache", "clear", "--json"], { ...deps, fetchCache })).toBe(0);
    expect(fetchCache.clear).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout.value())).toEqual({
      cleared: true,
      location: "/tmp/deepseek-cache",
    });
  });

  it("renders deduplicated Map URLs in sorted human order", async () => {
    const sitemapReader = {
      read: vi.fn(async () => ({
        entries: [{ url: new URL("https://example.com/a") }],
        warnings: [],
        truncated: false,
      })),
    };
    const mapClient = {
      search: vi.fn(),
      fetch: vi.fn(async () => ({ title: "Seed", content: "[Docs](/docs)" })),
    };
    const { deps, stdout, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["map", "https://example.com/"], { ...deps, mapClient, sitemapReader }),
    ).toBe(0);
    expect(stdout.value()).toBe(
      "https://example.com/\nhttps://example.com/a\nhttps://example.com/docs\n",
    );
    expect(stderr.value()).toBe("");
  });

  it("prints complete Map JSON and maps warnings to stderr", async () => {
    const sitemapReader = {
      read: vi.fn(async () => Promise.reject(new Error("Sitemap missing"))),
    };
    const mapClient = {
      search: vi.fn(),
      fetch: vi.fn(async () => ({ title: "Seed", content: "[Docs](/docs)" })),
    };
    const { deps, stdout, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["map", "https://example.com/", "--limit", "1", "--json"], {
        ...deps,
        mapClient,
        sitemapReader,
      }),
    ).toBe(0);
    expect(JSON.parse(stdout.value())).toMatchObject({
      version: 1,
      seed_url: "https://example.com/",
      limit: 1,
      total: 1,
      truncated: true,
      urls: [{ url: "https://example.com/", sources: ["seed_url"] }],
      warnings: [{ code: "sitemap_unavailable" }],
    });
    expect(stderr.value()).toBe("sitemap_unavailable: Could not read Sitemap: Sitemap missing\n");
  });

  it("forwards Map search and returns only matching URLs", async () => {
    const sitemapReader = {
      read: vi.fn(async () => ({
        entries: [{ url: new URL("https://example.com/docs/guide") }],
        warnings: [],
        truncated: false,
      })),
    };
    const mapClient = {
      search: vi.fn(),
      fetch: vi.fn(async () => ({
        title: "Seed",
        content: "[API](/docs/api) [Blog](/blog)",
      })),
    };
    const { deps, stdout, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["map", "https://example.com/", "--search", "api"], {
        ...deps,
        mapClient,
        sitemapReader,
      }),
    ).toBe(0);
    expect(stdout.value()).toBe("https://example.com/docs/api\n");
    expect(stderr.value()).toBe("");
  });

  it("writes Map JSON without overwriting an existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-map-"));
    const output = join(root, "urls.json");
    await writeFile(output, "original", "utf8");
    const sitemapReader = {
      read: vi.fn(async () => ({ entries: [], warnings: [], truncated: false })),
    };
    const mapClient = {
      search: vi.fn(),
      fetch: vi.fn(async () => ({ title: "Seed", content: "No links" })),
    };
    const { deps, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["map", "https://example.com/", "--output", output], {
        ...deps,
        mapClient,
        sitemapReader,
      }),
    ).toBe(1);
    expect(mapClient.fetch).not.toHaveBeenCalled();
    expect(await readFile(output, "utf8")).toBe("original");
    expect(stderr.value()).toContain("already exists");
  });

  it("runs Crawl and writes the output directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-cli-"));
    const output = join(root, "crawl");
    const crawlClient = {
      search: vi.fn(),
      fetch: vi.fn(async ({ url }: { url: string }) => ({
        title: url.endsWith("/") ? "Example" : "Next",
        content: url.endsWith("/") ? "No Markdown links" : "# Next",
      })),
    };
    const sitemapReader = sitemap([new URL("https://example.com/next")]);
    const { deps, stdout, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(
        [
          "crawl",
          "https://example.com",
          "--max-depth",
          "1",
          "--max-pages",
          "2",
          "--delay-ms",
          "0",
          "--output",
          output,
        ],
        { ...deps, crawlClient, sitemapReader },
      ),
    ).toBe(0);
    expect(crawlClient.fetch).toHaveBeenCalledTimes(2);
    expect(sitemapReader.read).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(output, "crawl.json"), "utf8"))).toMatchObject({
      seed_url: "https://example.com/",
      settings: { sitemap_mode: "include" },
      stats: {
        discovered: 2,
        fetched: 2,
        failed: 0,
        sitemap_candidates: 1,
      },
      pages: [
        { path: "pages/0001-page.md", sources: ["seed_url"] },
        { path: "pages/0002-next.md", sources: ["sitemap"] },
      ],
      warnings: [],
    });
    expect(await readFile(join(output, "pages", "0001-page.md"), "utf8")).toContain("# Example");
    expect(stdout.value()).toContain(`Output: ${output}`);
    expect(stderr.value()).toBe("");
  });

  it("writes a Crawl plan without fetching discovered pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-plan-"));
    const output = join(root, "crawl-plan.json");
    const crawlClient = {
      search: vi.fn(),
      fetch: vi.fn(async () => ({ title: "Example", content: "No Markdown links" })),
    };
    const sitemapReader = sitemap([new URL("https://example.com/next")]);
    const { deps, stdout } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(
        [
          "crawl",
          "https://example.com/",
          "--plan-only",
          "--max-depth",
          "1",
          "--max-pages",
          "2",
          "--output",
          output,
          "--json",
        ],
        { ...deps, crawlClient, sitemapReader },
      ),
    ).toBe(0);

    expect(crawlClient.fetch).toHaveBeenCalledOnce();
    const plan = JSON.parse(await readFile(output, "utf8"));
    expect(plan).toMatchObject({
      seed_url: "https://example.com/",
      urls: [{ url: "https://example.com/next", sources: ["sitemap"] }],
      stats: {
        selected: 1,
        planned_pages: 2,
      },
    });
    expect(JSON.parse(stdout.value())).toEqual(plan);
  });

  it("does not overwrite an existing Crawl plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-plan-"));
    const output = join(root, "crawl-plan.json");
    await writeFile(output, "original", "utf8");
    const crawlClient = {
      search: vi.fn(),
      fetch: vi.fn(async () => ({ title: "Example", content: "No links" })),
    };
    const { deps, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(
        ["crawl", "https://example.com/", "--plan-only", "--max-depth", "0", "--output", output],
        { ...deps, crawlClient, sitemapReader: sitemap() },
      ),
    ).toBe(1);
    expect(crawlClient.fetch).not.toHaveBeenCalled();
    expect(await readFile(output, "utf8")).toBe("original");
    expect(stderr.value()).toContain("already exists");
  });

  it("runs batch Fetch from Map JSON and writes per-page output", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-batch-"));
    const input = join(root, "urls.json");
    const output = join(root, "pages");
    await writeFile(
      input,
      JSON.stringify({
        urls: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }],
      }),
    );
    const fetchClient = {
      search: vi.fn(),
      fetch: vi.fn(async ({ url }: { url: string }) => ({
        title: url.endsWith("/a") ? "A" : "B",
        content: `# ${url.endsWith("/a") ? "A" : "B"}`,
      })),
    };
    const { deps, stdout, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(
        [
          "fetch",
          "--input",
          input,
          "--output-dir",
          output,
          "--concurrency",
          "2",
          "--delay-ms",
          "0",
          "--json",
        ],
        { ...deps, fetchClient },
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.value())).toMatchObject({
      source: input,
      stats: { input: 2, unique: 2, fetched: 2, failed: 0 },
      pages: [{ path: "pages/0001-a.md" }, { path: "pages/0002-b.md" }],
    });
    expect(await readFile(join(output, "pages", "0001-a.md"), "utf8")).toContain("Source:");
    expect(stderr.value()).toBe("");
  });

  it("reuses cache across Batch Fetch runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-batch-cache-"));
    const input = join(root, "urls.json");
    const firstOutput = join(root, "first");
    const secondOutput = join(root, "second");
    const fetchCache = new FileFetchCache(join(root, "cache"));
    await writeFile(input, JSON.stringify(["https://example.com/page"]));
    const fetchClient = {
      search: vi.fn(),
      fetch: vi.fn(async () => ({ title: "Page", content: "body" })),
    };
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const invoke = async (output: string) => {
      const { deps } = dependencies(fetchImpl);
      return runCli(
        [
          "fetch",
          "--input",
          input,
          "--output-dir",
          output,
          "--cache-ttl",
          "60",
          "--delay-ms",
          "0",
          "--json",
        ],
        {
          ...deps,
          fetchClient,
          fetchCache,
          cacheClock: () => new Date("2026-11-14T01:00:00.000Z"),
        },
      );
    };

    expect(await invoke(firstOutput)).toBe(0);
    expect(await invoke(secondOutput)).toBe(0);
    expect(fetchClient.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(firstOutput, "fetch.json"), "utf8"))).toMatchObject({
      stats: { cache_hits: 0, cache_misses: 1 },
      pages: [{ retrieved_from: "api" }],
    });
    expect(JSON.parse(await readFile(join(secondOutput, "fetch.json"), "utf8"))).toMatchObject({
      stats: { cache_hits: 1, cache_misses: 0 },
      pages: [{ retrieved_from: "cache" }],
    });
  });

  it("retries only failed Batch Fetch URLs from an existing report", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-retry-"));
    const reportPath = join(root, "fetch.json");
    const output = join(root, "retry");
    await writeFile(
      reportPath,
      JSON.stringify({
        version: 1,
        source: "map.json",
        failures: [
          {
            index: 2,
            url: "https://example.com/fail",
            kind: "timeout",
            message: "timed out",
          },
        ],
      }),
    );
    const fetchClient = {
      search: vi.fn(),
      fetch: vi.fn(async ({ url }: { url: string }) => ({
        title: "Retried",
        content: `retried:${url}`,
      })),
    };
    const { deps, stdout } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(
        [
          "fetch",
          "--retry-failed",
          reportPath,
          "--output-dir",
          output,
          "--delay-ms",
          "0",
          "--json",
        ],
        { ...deps, fetchClient },
      ),
    ).toBe(0);

    expect(fetchClient.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(output, "fetch.json"), "utf8"))).toMatchObject({
      source: `${reportPath} [retry-failed]`,
      retry_of: {
        source: reportPath,
        original_failures: 1,
        attempted: 1,
      },
      pages: [
        {
          index: 2,
          url: "https://example.com/fail",
          path: "pages/0002-fail.md",
          retry_of: {
            index: 2,
            kind: "timeout",
            message: "timed out",
          },
        },
      ],
    });
    expect(JSON.parse(stdout.value())).toMatchObject({
      retry_of: { attempted: 1 },
    });
  });

  it("rejects an existing Batch retry output before making a Fetch request", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-retry-existing-"));
    const reportPath = join(root, "fetch.json");
    const output = join(root, "retry");
    await writeFile(
      reportPath,
      JSON.stringify({
        version: 1,
        source: "map.json",
        failures: [
          {
            index: 2,
            url: "https://example.com/fail",
            kind: "timeout",
            message: "timed out",
          },
        ],
      }),
    );
    await mkdir(output);
    const fetchClient = {
      search: vi.fn(),
      fetch: vi.fn(),
    };
    const { deps, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["fetch", "--retry-failed", reportPath, "--output-dir", output], {
        ...deps,
        fetchClient,
      }),
    ).toBe(1);
    expect(fetchClient.fetch).not.toHaveBeenCalled();
    expect(stderr.value()).toContain("already exists");
  });

  it("rejects oversized Batch input before making a Fetch request", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-input-limit-"));
    const input = join(root, "urls.json");
    const output = join(root, "pages");
    await writeFile(input, "");
    await truncate(input, 8 * 1024 * 1024 + 1);
    const fetchClient = {
      search: vi.fn(),
      fetch: vi.fn(),
    };
    const { deps, stdout, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["fetch", "--input", input, "--output-dir", output], { ...deps, fetchClient }),
    ).toBe(1);
    expect(fetchClient.fetch).not.toHaveBeenCalled();
    expect({ stdout: stdout.value(), stderr: stderr.value() }).toMatchObject({
      stderr: expect.stringContaining("8 MiB"),
    });
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects oversized retry reports before making a Fetch request", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-report-limit-"));
    const report = join(root, "fetch.json");
    const output = join(root, "retry");
    await writeFile(report, "");
    await truncate(report, 8 * 1024 * 1024 + 1);
    const fetchClient = {
      search: vi.fn(),
      fetch: vi.fn(),
    };
    const { deps, stdout, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["fetch", "--retry-failed", report, "--output-dir", output], {
        ...deps,
        fetchClient,
      }),
    ).toBe(1);
    expect(fetchClient.fetch).not.toHaveBeenCalled();
    expect({ stdout: stdout.value(), stderr: stderr.value() }).toMatchObject({
      stderr: expect.stringContaining("8 MiB"),
    });
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects oversized stdin before making a Fetch request", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-stdin-limit-"));
    const output = join(root, "pages");
    const fetchClient = {
      search: vi.fn(),
      fetch: vi.fn(),
    };
    const { deps, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["fetch", "--input", "-", "--output-dir", output], {
        ...deps,
        fetchClient,
        stdin: Readable.from([Buffer.alloc(5 * 1024 * 1024), Buffer.alloc(4 * 1024 * 1024)]),
      }),
    ).toBe(1);
    expect(fetchClient.fetch).not.toHaveBeenCalled();
    expect(stderr.value()).toContain("8 MiB");
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans Batch retry staging when the signal is already aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-retry-abort-"));
    const report = join(root, "fetch.json");
    const output = join(root, "retry");
    await writeFile(
      report,
      JSON.stringify({
        version: 1,
        source: "map.json",
        failures: [
          {
            index: 1,
            url: "https://example.com/fail",
            kind: "timeout",
            message: "timed out",
          },
        ],
      }),
    );
    const controller = new AbortController();
    controller.abort();
    const fetchClient = {
      search: vi.fn(),
      fetch: vi.fn(),
    };
    const { deps } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["fetch", "--retry-failed", report, "--output-dir", output], {
        ...deps,
        fetchClient,
        signal: controller.signal,
      }),
    ).toBe(130);
    expect(fetchClient.fetch).not.toHaveBeenCalled();
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads batch Fetch input from stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-batch-stdin-"));
    const output = join(root, "pages");
    const fetchClient = {
      search: vi.fn(),
      fetch: vi.fn(async () => ({ title: "Page", content: "Body" })),
    };
    const { deps } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["fetch", "--input", "-", "--output-dir", output, "--delay-ms", "0"], {
        ...deps,
        fetchClient,
        stdin: Readable.from("https://example.com/a\n"),
      }),
    ).toBe(0);
    expect(JSON.parse(await readFile(join(output, "fetch.json"), "utf8"))).toMatchObject({
      source: "stdin",
      stats: { fetched: 1 },
    });
  });

  it("publishes a batch report and exits 1 when every URL fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-batch-fail-"));
    const output = join(root, "pages");
    const fetchClient = {
      search: vi.fn(),
      fetch: vi.fn(async () => {
        throw new Error("page unavailable");
      }),
    };
    const { deps, stdout } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["fetch", "--input", "-", "--output-dir", output, "--delay-ms", "0", "--json"], {
        ...deps,
        fetchClient,
        stdin: Readable.from("https://example.com/a\n"),
      }),
    ).toBe(1);
    expect(JSON.parse(stdout.value())).toMatchObject({
      stats: { fetched: 0, failed: 1 },
    });
  });

  it("forwards Crawl path filters and query deduplication", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-filtered-"));
    const output = join(root, "crawl");
    const crawlClient = {
      search: vi.fn(),
      fetch: vi.fn(async ({ url }: { url: string }) => ({
        title: url,
        content:
          url === "https://example.com/"
            ? "[Doc](/docs/a?x=1) [Doc duplicate](/docs/a?x=2) [Blog](/blog)"
            : "No links",
      })),
    };
    const { deps } = dependencies(vi.fn() as unknown as typeof fetch);
    const sitemapReader = sitemap();

    expect(
      await runCli(
        [
          "crawl",
          "https://example.com/?from=seed",
          "--max-depth",
          "1",
          "--max-pages",
          "3",
          "--delay-ms",
          "0",
          "--include-paths",
          "/docs",
          "--ignore-query-parameters",
          "--output",
          output,
        ],
        { ...deps, crawlClient, sitemapReader },
      ),
    ).toBe(0);
    const report = JSON.parse(await readFile(join(output, "crawl.json"), "utf8")) as {
      seed_url: string;
      pages: Array<{ url: string }>;
    };
    expect(report.seed_url).toBe("https://example.com/");
    expect(report.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/docs/a",
    ]);
  });

  it("cleans Crawl staging when the signal is already aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-cli-"));
    const output = join(root, "crawl");
    const controller = new AbortController();
    controller.abort();
    const { deps, stderr } = dependencies(vi.fn() as unknown as typeof fetch);
    const sitemapReader = sitemap();

    expect(
      await runCli(["crawl", "https://example.com", "--output", output], {
        ...deps,
        sitemapReader,
        signal: controller.signal,
      }),
    ).toBe(130);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(stderr.value()).not.toBe("");
  });

  it("prints Crawl JSON with published page paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-cli-"));
    const output = join(root, "crawl");
    const crawlClient = {
      search: vi.fn(),
      fetch: vi.fn(async () => ({ title: "Example", content: "No links." })),
    };
    const sitemapReader = sitemap();
    const { deps, stdout } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(
        ["crawl", "https://example.com", "--max-depth", "0", "--output", output, "--json"],
        { ...deps, crawlClient, sitemapReader },
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.value())).toMatchObject({
      seed_url: "https://example.com/",
      pages: [{ path: "pages/0001-page.md", content_length: 9 }],
    });
  });

  it("writes only changed Crawl pages against a baseline directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-incremental-"));
    const baseline = join(root, "baseline");
    const output = join(root, "changes");
    await mkdir(baseline);
    const seedContent = "[Same](/same) [Changed](/changed)";
    await writeFile(
      join(baseline, "crawl.json"),
      JSON.stringify({
        version: 2,
        pages: [
          {
            url: "https://example.com/",
            title: "Seed",
            depth: 0,
            sources: ["seed_url"],
            content_length: seedContent.length,
            content_hash: contentHash(seedContent),
            content_truncated: false,
          },
          {
            url: "https://example.com/same",
            title: "Same",
            depth: 1,
            sources: ["markdown"],
            content_length: 4,
            content_hash: contentHash("same"),
            content_truncated: false,
          },
          {
            url: "https://example.com/changed",
            title: "Changed",
            depth: 1,
            sources: ["markdown"],
            content_length: 3,
            content_hash: contentHash("old"),
            content_truncated: false,
          },
          {
            url: "https://example.com/removed",
            title: "Removed",
            depth: 1,
            sources: ["markdown"],
            content_length: 7,
            content_hash: contentHash("removed"),
            content_truncated: false,
          },
        ],
      }),
    );
    const crawlClient = {
      search: vi.fn(),
      fetch: vi.fn(async ({ url }: { url: string }) => ({
        title: url,
        content:
          url === "https://example.com/"
            ? seedContent
            : url === "https://example.com/same"
              ? "same"
              : "new",
      })),
    };
    const { deps, stdout } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(
        [
          "crawl",
          "https://example.com/",
          "--max-depth",
          "1",
          "--max-pages",
          "3",
          "--delay-ms",
          "0",
          "--baseline",
          baseline,
          "--changed-only",
          "--output",
          output,
          "--json",
        ],
        { ...deps, crawlClient, sitemapReader: sitemap() },
      ),
    ).toBe(0);

    expect(crawlClient.fetch).toHaveBeenCalledTimes(3);
    const report = JSON.parse(stdout.value());
    expect(report).toMatchObject({
      baseline: { source: join(baseline, "crawl.json") },
      changes: {
        added: [],
        modified: [
          {
            url: "https://example.com/changed",
            content_hash: contentHash("new"),
            previous_content_hash: contentHash("old"),
          },
        ],
        unchanged: [
          { url: "https://example.com/", content_hash: contentHash(seedContent) },
          { url: "https://example.com/same", content_hash: contentHash("same") },
        ],
        removed: [
          {
            url: "https://example.com/removed",
            content_hash: contentHash("removed"),
          },
        ],
      },
      stats: { added: 0, modified: 1, unchanged: 2, removed: 1 },
      pages: [
        { url: "https://example.com/", written: false },
        { url: "https://example.com/changed", written: true },
        { url: "https://example.com/same", written: false },
      ],
    });
    expect(await readFile(join(output, "pages", "0002-changed.md"), "utf8")).toContain("new");
    await expect(stat(join(output, "pages", "0001-page.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("resumes an interrupted durable Crawl job and publishes the final output", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-job-cli-"));
    const jobDir = join(root, "job");
    const finalOutput = join(root, "final");
    const controller = new AbortController();
    const firstClient = {
      search: vi.fn(),
      fetch: vi.fn(async ({ url }: { url: string }) => {
        if (url === "https://example.com/a") {
          controller.abort(new Error("interrupted"));
          throw new Error("interrupted");
        }
        return {
          title: url,
          content: url === "https://example.com/" ? "[A](/a) [B](/b)" : "body",
        };
      }),
    };
    const firstDependencies = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(
        [
          "crawl",
          "https://example.com/",
          "--max-depth",
          "1",
          "--max-pages",
          "3",
          "--concurrency",
          "1",
          "--delay-ms",
          "0",
          "--sitemap",
          "skip",
          "--job-dir",
          jobDir,
          "--output",
          finalOutput,
        ],
        {
          ...firstDependencies.deps,
          crawlClient: firstClient,
          sitemapReader: sitemap(),
          signal: controller.signal,
        },
      ),
    ).toBe(130);
    await expect(stat(finalOutput)).rejects.toMatchObject({ code: "ENOENT" });

    const statusDependencies = dependencies(vi.fn() as unknown as typeof fetch, {});
    expect(await runCli(["crawl", "status", jobDir, "--json"], statusDependencies.deps)).toBe(0);
    expect(JSON.parse(statusDependencies.stdout.value())).toMatchObject({
      status: "interrupted",
      active_layer: {
        urls: ["https://example.com/a", "https://example.com/b"],
        completed: [],
      },
    });

    const resumedFetch = vi.fn(async ({ url }: { url: string }) => ({
      title: url,
      content: "body",
    }));
    const resumeDependencies = dependencies(vi.fn() as unknown as typeof fetch);
    expect(
      await runCli(["crawl", "resume", jobDir, "--output", finalOutput, "--json"], {
        ...resumeDependencies.deps,
        crawlClient: { search: vi.fn(), fetch: resumedFetch },
        sitemapReader: sitemap(),
      }),
    ).toBe(0);

    expect(resumedFetch.mock.calls.map(([input]) => input.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(JSON.parse(await readFile(join(finalOutput, "crawl.json"), "utf8"))).toMatchObject({
      pages: [
        { url: "https://example.com/", written: true },
        { url: "https://example.com/a", written: true },
        { url: "https://example.com/b", written: true },
      ],
    });
    const completedStatus = dependencies(vi.fn() as unknown as typeof fetch, {});
    expect(await runCli(["crawl", "status", jobDir, "--json"], completedStatus.deps)).toBe(0);
    const completed = JSON.parse(completedStatus.stdout.value());
    expect(completed.status).toBe("completed");
    expect(completed.active_layer).toBeUndefined();
  });

  it("records a Sitemap warning without failing Crawl", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-sitemap-warning-"));
    const output = join(root, "crawl");
    const crawlClient = {
      search: vi.fn(),
      fetch: vi.fn(async ({ url }: { url: string }) => ({
        title: url,
        content: url === "https://example.com/" ? "[Next](/next)" : "Body",
      })),
    };
    const sitemapReader = {
      read: vi.fn(async () => Promise.reject(new Error("Sitemap missing"))),
    };
    const { deps, stdout, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(
        [
          "crawl",
          "https://example.com/",
          "--max-depth",
          "1",
          "--max-pages",
          "2",
          "--delay-ms",
          "0",
          "--output",
          output,
        ],
        { ...deps, crawlClient, sitemapReader },
      ),
    ).toBe(0);
    expect(JSON.parse(await readFile(join(output, "crawl.json"), "utf8"))).toMatchObject({
      warnings: [
        {
          code: "sitemap_unavailable",
          message: "Could not read Sitemap: Sitemap missing",
        },
      ],
    });
    expect(stdout.value()).toContain("Warnings: 1");
    expect(stdout.value()).toContain(
      "sitemap_unavailable: Could not read Sitemap: Sitemap missing",
    );
    expect(stderr.value()).toBe("");
  });

  it("retries only failed Crawl URLs from an existing report", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-retry-"));
    const reportPath = join(root, "crawl.json");
    const output = join(root, "retry");
    await writeFile(
      reportPath,
      JSON.stringify({
        version: 2,
        seed_url: "https://example.com/",
        settings: {
          max_depth: 2,
          max_pages: 5,
          concurrency: 2,
          delay_ms: 0,
          sitemap_mode: "include",
        },
        failures: [
          {
            index: 3,
            url: "https://example.com/retry",
            depth: 2,
            sources: ["markdown"],
            kind: "timeout",
            message: "timed out",
          },
        ],
      }),
    );
    const crawlClient = {
      search: vi.fn(),
      fetch: vi.fn(async ({ url }: { url: string }) => ({
        title: "Retried",
        content: `retried:${url}`,
      })),
    };
    const { deps, stdout } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["crawl", "--retry-failed", reportPath, "-o", output, "--json"], {
        ...deps,
        crawlClient,
      }),
    ).toBe(0);

    expect(crawlClient.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(output, "crawl.json"), "utf8"))).toMatchObject({
      seed_url: "https://example.com/",
      retry_of: {
        source: reportPath,
        original_failures: 1,
        attempted: 1,
      },
      pages: [
        {
          index: 3,
          url: "https://example.com/retry",
          depth: 2,
          sources: ["markdown"],
          path: "pages/0003-retry.md",
          retry_of: {
            index: 3,
            kind: "timeout",
            message: "timed out",
          },
        },
      ],
    });
    expect(JSON.parse(stdout.value())).toMatchObject({
      retry_of: { attempted: 1 },
    });
  });

  it("does not read Sitemap when Crawl uses skip mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-sitemap-skip-"));
    const output = join(root, "crawl");
    const crawlClient = {
      search: vi.fn(),
      fetch: vi.fn(async () => ({ title: "Example", content: "No links" })),
    };
    const sitemapReader = sitemap([new URL("https://example.com/unused")]);
    const { deps } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(
        [
          "crawl",
          "https://example.com/",
          "--sitemap",
          "skip",
          "--max-depth",
          "1",
          "--output",
          output,
        ],
        { ...deps, crawlClient, sitemapReader },
      ),
    ).toBe(0);
    expect(sitemapReader.read).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(output, "crawl.json"), "utf8"))).toMatchObject({
      settings: { sitemap_mode: "skip" },
      stats: { sitemap_candidates: 0 },
      warnings: [],
    });
  });

  it("installs the bundled Skill into the common agents directory without an API key", async () => {
    const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "deepseek-crawl-project-"));
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const { deps, stdout, stderr } = dependencies(vi.fn() as unknown as typeof fetch, {});

    expect(
      await runCli(["setup", "skills"], {
        ...deps,
        setupEnvironment: { home, cwd, env: {}, packageRoot },
      }),
    ).toBe(0);
    const target = join(home, ".agents", "skills", "deepseek-crawl");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readlink(target)).toBe(join(packageRoot, "skills", "deepseek-crawl"));
    expect(stdout.value()).toContain(target);
    expect(stdout.value()).toContain("Start a new Agent session");
    expect(stderr.value()).toBe("");
  });

  it("prints setup JSON for a selected Codex install", async () => {
    const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "deepseek-crawl-project-"));
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const { deps, stdout } = dependencies(vi.fn() as unknown as typeof fetch, {});

    expect(
      await runCli(["setup", "skills", "--agent", "codex", "--json"], {
        ...deps,
        setupEnvironment: { home, cwd, env: {}, packageRoot },
      }),
    ).toBe(0);
    expect(JSON.parse(stdout.value())).toMatchObject({
      version: 1,
      scope: "global",
      mode: "symlink",
      installs: [
        {
          agents: ["codex"],
          path: join(home, ".codex", "skills", "deepseek-crawl"),
          status: "installed",
        },
      ],
      restart_required: true,
    });
  });

  it("renders human Search output with the inline limit", async () => {
    const fetchImpl = vi.fn(async () => Response.json(searchResponse)) as unknown as typeof fetch;
    const { deps, stdout, stderr } = dependencies(fetchImpl);

    expect(await runCli(["search", "test", "--content"], deps)).toBe(0);
    expect(stdout.value()).toContain("1. Result");
    expect(stdout.value()).toContain("abcdef");
    expect(stderr.value()).toBe("");
  });

  it("renders complete Search JSON unless a limit is explicit", async () => {
    const fetchImpl = vi.fn(async () => Response.json(searchResponse)) as unknown as typeof fetch;
    const { deps, stdout } = dependencies(fetchImpl);

    expect(await runCli(["search", "test", "--content", "--json"], deps)).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual(searchResponse);
  });

  it("writes a complete Search file without applying display limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-cli-"));
    const output = join(root, "nested", "search.json");
    const fetchImpl = vi.fn(async () => Response.json(searchResponse)) as unknown as typeof fetch;
    const { deps, stdout } = dependencies(fetchImpl);

    expect(
      await runCli(
        ["search", "test", "--content", "--max-content-chars", "1", "--output", output],
        deps,
      ),
    ).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(searchResponse);
    expect(stdout.value()).toContain(output);
  });

  it("writes complete Fetch Markdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-cli-"));
    const output = join(root, "page.md");
    const fetchImpl = vi.fn(async () =>
      Response.json({ title: "Page", content: "abcdef" }),
    ) as unknown as typeof fetch;
    const { deps } = dependencies(fetchImpl);

    expect(
      await runCli(
        ["fetch", "https://example.com/page", "--max-chars", "2", "--output", output],
        deps,
      ),
    ).toBe(0);
    expect(await readFile(output, "utf8")).toBe(
      "# Page\n\nSource: https://example.com/page\n\nabcdef\n",
    );
  });

  it("reuses Fetch cache and bypasses it with fresh mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-cache-"));
    const fetchCache = new FileFetchCache(join(root, "cache"));
    const fetchClient = {
      search: vi.fn(),
      fetch: vi.fn(async () => ({ title: "Cached page", content: "body" })),
    };
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const invoke = async (args: string[]) => {
      const { deps, stdout } = dependencies(fetchImpl);
      const code = await runCli(args, {
        ...deps,
        fetchClient,
        fetchCache,
        cacheClock: () => new Date("2026-11-14T01:00:00.000Z"),
      });
      return { code, output: stdout.value() };
    };

    const first = await invoke([
      "fetch",
      "https://example.com/page",
      "--cache-ttl",
      "60",
      "--json",
    ]);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.output)).toMatchObject({ retrieved_from: "api" });
    expect(fetchClient.fetch).toHaveBeenCalledOnce();

    const second = await invoke([
      "fetch",
      "https://example.com/page",
      "--cache-ttl",
      "60",
      "--json",
    ]);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.output)).toMatchObject({ retrieved_from: "cache" });
    expect(fetchClient.fetch).toHaveBeenCalledOnce();

    const third = await invoke([
      "fetch",
      "https://example.com/page",
      "--cache-ttl",
      "60",
      "--fresh",
      "--json",
    ]);
    expect(third.code).toBe(0);
    expect(JSON.parse(third.output)).toMatchObject({ retrieved_from: "api" });
    expect(fetchClient.fetch).toHaveBeenCalledTimes(2);
  });

  it("prints API errors to stderr and exits 1", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: { message: "balance empty" } }, { status: 402 }),
    ) as unknown as typeof fetch;
    const { deps, stdout, stderr } = dependencies(fetchImpl, {
      DEEPSEEK_API_KEY: "key",
      DEEPSEEK_MAX_RETRIES: "0",
    });

    expect(await runCli(["fetch", "https://example.com"], deps)).toBe(1);
    expect(stdout.value()).toBe("");
    expect(stderr.value()).toContain("HTTP 402");
  });

  it("prints usage errors to stderr and exits 2", async () => {
    const { deps, stderr } = dependencies(vi.fn() as unknown as typeof fetch);
    expect(await runCli(["search"], deps)).toBe(2);
    expect(stderr.value()).toMatch(/query is required/i);
  });

  it("reports a missing key without printing one", async () => {
    const { deps, stdout, stderr } = dependencies(vi.fn() as unknown as typeof fetch, {});
    expect(await runCli(["fetch", "https://example.com"], deps)).toBe(1);
    expect(stdout.value()).toBe("");
    expect(stderr.value()).toContain("DEEPSEEK_API_KEY");
  });

  it("runs doctor without a billable POST", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("ok", { status: 404 }),
    );
    const { deps, stdout } = dependencies(fetchImpl as unknown as typeof fetch);

    expect(await runCli(["doctor", "--json"], deps)).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe("GET");
    expect(JSON.parse(stdout.value())).toMatchObject({
      ok: true,
      api_key: "configured",
      credential_source: "environment",
      connectivity: "reachable",
      live: "not_requested",
    });
  });

  it("runs doctor --live with one Search attempt", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/")) {
        return new Response("ok");
      }
      return Response.json(searchResponse);
    });
    const { deps, stdout, stderr } = dependencies(fetchImpl as unknown as typeof fetch);

    expect(await runCli(["doctor", "--live", "--json"], deps)).toBe(0);
    const postCall = fetchImpl.mock.calls.find(
      ([url]) => String(url) === "https://api.deepseek.com/v1/tools/search",
    );
    expect(postCall).toBeDefined();
    expect(stderr.value()).toMatch(/billable/i);
    expect(JSON.parse(stdout.value())).toMatchObject({ ok: true, live: "passed" });
  });
});
