import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MapSitemapReader } from "../../src/application/index.js";
import { runCli } from "../../src/cli/run.js";
import { contentHash } from "../../src/content/hash.js";
import { CrawlMonitorStore, readCrawlMonitorState } from "../../src/crawl/monitor.js";
import type { CrawlMonitorState } from "../../src/crawl/types.js";
import type { DeepSeekGateway } from "../../src/deepseek/gateway.js";

const RUN_AT = new Date("2026-11-14T01:02:03.456Z");

function outputWriter() {
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
  crawlClient: DeepSeekGateway,
  sitemapReader: MapSitemapReader,
  clock = () => RUN_AT,
) {
  const stdout = outputWriter();
  const stderr = outputWriter();
  return {
    deps: {
      env: { DEEPSEEK_API_KEY: "key" },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      stdout,
      stderr,
      crawlClient,
      sitemapReader,
      monitorClock: clock,
    },
    stdout,
    stderr,
  };
}

function crawlClient(fetchPage: (url: string) => Promise<{ title: string; content: string }>) {
  return {
    search: vi.fn(),
    fetch: vi.fn(async ({ url }: { url: string }) => fetchPage(url)),
  };
}

function monitorArguments(monitorDir: string, runsDir: string, extra: string[] = []) {
  return [
    "crawl",
    "monitor",
    "https://example.com/",
    "--monitor-dir",
    monitorDir,
    "--sitemap",
    "skip",
    "--max-depth",
    "1",
    "--max-pages",
    "3",
    "--concurrency",
    "1",
    "--delay-ms",
    "0",
    "--fail-on-change",
    "--output",
    runsDir,
    "--json",
    ...extra,
  ];
}

function storedState(overrides: Partial<CrawlMonitorState> = {}): CrawlMonitorState {
  return {
    version: 1,
    seed_url: "https://example.com/",
    options: {
      maxDepth: 2,
      maxPages: 5,
      concurrency: 2,
      delayMs: 0,
      includePaths: [],
      excludePaths: [],
      ignoreQueryParameters: false,
      sitemapMode: "skip",
    },
    baseline: [{ url: "https://example.com/", content_hash: "a".repeat(64) }],
    last_run_at: RUN_AT.toISOString(),
    last_run_id: "run-1",
    last_output: "/tmp/run-1",
    last_changes: { added: [], modified: [], unchanged: [], removed: [] },
    last_has_changes: false,
    ...overrides,
  };
}

describe("CrawlMonitorStore", () => {
  it("checkpoints, reopens, and resets monitor state", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-monitor-store-"));
    const directory = join(root, "monitor");
    const store = await CrawlMonitorStore.open(directory);
    expect(store.state).toBeNull();
    await store.checkpoint(storedState());
    await store.release();

    const reopened = await CrawlMonitorStore.open(directory);
    expect(reopened.state).toMatchObject({
      seed_url: "https://example.com/",
      baseline: [{ url: "https://example.com/" }],
    });
    expect(await reopened.reset()).toBe(true);
    expect(reopened.state).toBeNull();
    await reopened.release();
    expect(await readCrawlMonitorState(directory)).toBeNull();
    await expect(lstat(join(directory, "writer.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows one writer and recovers a lock left by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-monitor-store-"));
    const directory = join(root, "monitor");
    const first = await CrawlMonitorStore.open(directory);
    await expect(CrawlMonitorStore.open(directory)).rejects.toMatchObject({ code: "EEXIST" });
    await first.release();

    await writeFile(join(directory, "writer.lock"), JSON.stringify({ pid: 99_999_999 }));
    const recovered = await CrawlMonitorStore.open(directory);
    await recovered.release();
  });

  it("rejects incompatible persisted state", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-monitor-store-"));
    const directory = join(root, "monitor");
    await mkdir(directory);
    await writeFile(join(directory, "state.json"), JSON.stringify({ version: 2 }));

    await expect(CrawlMonitorStore.open(directory)).rejects.toThrow(/version|invalid/i);
    await expect(lstat(join(directory, "writer.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Crawl monitor CLI", () => {
  it("creates a baseline, reports a later modification, and exits 3", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-monitor-cli-"));
    const monitorDir = join(root, "state");
    const runsDir = join(root, "runs");
    let changedContent = "old";
    const client = crawlClient(async (url) =>
      url === "https://example.com/"
        ? {
            title: "Seed",
            content: "[Same](/same) [Changed](/changed)",
          }
        : { title: url, content: url.endsWith("/same") ? "same" : changedContent },
    );
    const reader = { read: vi.fn(async () => ({ urls: [], warnings: [], truncated: false })) };

    const firstDependencies = dependencies(client, reader);
    expect(await runCli(monitorArguments(monitorDir, runsDir), firstDependencies.deps)).toBe(0);
    const first = JSON.parse(firstDependencies.stdout.value());
    expect(first).toMatchObject({
      monitor: {
        first_run: true,
        has_changes: false,
        triggered: false,
      },
      stats: { fetched: 3, failed: 0 },
    });
    expect(first.changes).toBeUndefined();

    changedContent = "new";
    const secondDependencies = dependencies(client, reader);
    expect(await runCli(monitorArguments(monitorDir, runsDir), secondDependencies.deps)).toBe(3);
    const second = JSON.parse(secondDependencies.stdout.value());
    expect(second).toMatchObject({
      monitor: {
        first_run: false,
        has_changes: true,
        triggered: true,
        fail_on_change: true,
      },
      changes: {
        added: [],
        modified: [{ url: "https://example.com/changed" }],
        removed: [],
      },
      stats: { modified: 1, unchanged: 2 },
    });
    expect(second.pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://example.com/changed",
          written: true,
        }),
        expect.objectContaining({
          url: "https://example.com/",
          written: false,
        }),
        expect.objectContaining({
          url: "https://example.com/same",
          written: false,
        }),
      ]),
    );

    const firstRun = join(runsDir, first.monitor.run_id as string);
    const secondRun = join(runsDir, second.monitor.run_id as string);
    expect(await readFile(join(firstRun, "crawl.json"), "utf8")).toContain('"first_run": true');
    expect(await readFile(join(secondRun, "crawl.json"), "utf8")).toContain('"has_changes": true');
    expect(await readdir(runsDir)).toHaveLength(2);
  });

  it("does not trigger or write added pages with --only-modified", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-monitor-only-"));
    const monitorDir = join(root, "state");
    const runsDir = join(root, "runs");
    const client = crawlClient(async () => ({ title: "Seed", content: "No links" }));
    const read = vi
      .fn()
      .mockResolvedValueOnce({ urls: [], warnings: [], truncated: false })
      .mockResolvedValue({
        urls: [new URL("https://example.com/new")],
        warnings: [],
        truncated: false,
      });
    const reader = { read };
    const baseArguments = [
      "crawl",
      "monitor",
      "https://example.com/",
      "--monitor-dir",
      monitorDir,
      "--max-depth",
      "1",
      "--max-pages",
      "2",
      "--delay-ms",
      "0",
      "--fail-on-change",
      "--output",
      runsDir,
      "--json",
    ];

    const firstDependencies = dependencies(client, reader);
    expect(await runCli(baseArguments, firstDependencies.deps)).toBe(0);

    const secondDependencies = dependencies(client, reader);
    expect(await runCli([...baseArguments, "--only-modified"], secondDependencies.deps)).toBe(0);
    const report = JSON.parse(secondDependencies.stdout.value());
    expect(report).toMatchObject({
      monitor: {
        has_changes: false,
        only_modified: true,
      },
      changes: {
        added: [{ url: "https://example.com/new" }],
        modified: [],
      },
    });
    expect(report.pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://example.com/new",
          written: false,
        }),
      ]),
    );
  });

  it("can ignore removals while still rotating the baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-monitor-removed-"));
    const monitorDir = join(root, "state");
    const runsDir = join(root, "runs");
    const client = crawlClient(async () => ({ title: "Seed", content: "No links" }));
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        urls: [new URL("https://example.com/old")],
        warnings: [],
        truncated: false,
      })
      .mockResolvedValue({ urls: [], warnings: [], truncated: false });
    const reader = { read };
    const arguments_ = [
      "crawl",
      "monitor",
      "https://example.com/",
      "--monitor-dir",
      monitorDir,
      "--max-depth",
      "1",
      "--max-pages",
      "2",
      "--delay-ms",
      "0",
      "--fail-on-change",
      "--output",
      runsDir,
      "--json",
    ];

    expect(await runCli(arguments_, dependencies(client, reader).deps)).toBe(0);
    const secondDependencies = dependencies(client, reader);
    expect(await runCli([...arguments_, "--ignore-removed"], secondDependencies.deps)).toBe(0);
    const report = JSON.parse(secondDependencies.stdout.value());
    expect(report).toMatchObject({
      monitor: {
        has_changes: false,
        ignore_removed: true,
      },
      changes: {
        removed: [{ url: "https://example.com/old" }],
      },
    });
    expect(await readCrawlMonitorState(monitorDir)).toMatchObject({
      baseline: [{ url: "https://example.com/" }],
    });
  });

  it("preserves baseline hashes when a page fetch fails transiently", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-monitor-failure-"));
    const monitorDir = join(root, "state");
    const runsDir = join(root, "runs");
    let failChild = false;
    const client = crawlClient(async (url) => {
      if (url === "https://example.com/") {
        return { title: "Seed", content: "[Child](/child)" };
      }
      if (failChild) {
        throw new Error("temporary failure");
      }
      return { title: "Child", content: "child body" };
    });
    const reader = { read: vi.fn(async () => ({ urls: [], warnings: [], truncated: false })) };

    expect(
      await runCli(monitorArguments(monitorDir, runsDir), dependencies(client, reader).deps),
    ).toBe(0);
    const first = await readCrawlMonitorState(monitorDir);
    expect(first?.baseline).toHaveLength(2);

    failChild = true;
    const secondDependencies = dependencies(client, reader);
    expect(await runCli(monitorArguments(monitorDir, runsDir), secondDependencies.deps)).toBe(0);
    expect(JSON.parse(secondDependencies.stdout.value())).toMatchObject({
      stats: { failed: 1, removed: 0 },
    });
    const second = await readCrawlMonitorState(monitorDir);
    expect(second?.baseline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://example.com/child",
          content_hash: contentHash("child body"),
        }),
      ]),
    );
  });

  it("does not overwrite reports when runs share a timestamp", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-monitor-runs-"));
    const monitorDir = join(root, "state");
    const runsDir = join(root, "runs");
    const client = crawlClient(async () => ({ title: "Seed", content: "No links" }));
    const reader = { read: vi.fn(async () => ({ urls: [], warnings: [], truncated: false })) };
    const args = [
      "crawl",
      "monitor",
      "https://example.com/",
      "--monitor-dir",
      monitorDir,
      "--max-depth",
      "0",
      "--delay-ms",
      "0",
      "--output",
      runsDir,
      "--json",
    ];

    const firstDependencies = dependencies(client, reader);
    const secondDependencies = dependencies(client, reader);
    expect(await runCli(args, firstDependencies.deps)).toBe(0);
    expect(await runCli(args, secondDependencies.deps)).toBe(0);
    expect(JSON.parse(firstDependencies.stdout.value()).monitor.run_id).toBe("20261114T010203456Z");
    expect(JSON.parse(secondDependencies.stdout.value()).monitor.run_id).toBe(
      "20261114T010203456Z-2",
    );
    expect(await readdir(runsDir)).toHaveLength(2);
  });

  it("reuses the crawl scope captured by the first baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-monitor-scope-"));
    const monitorDir = join(root, "state");
    const runsDir = join(root, "runs");
    let secondRun = false;
    const client = crawlClient(async (url) => {
      if (url === "https://example.com/") {
        return {
          title: "Seed",
          content: secondRun ? "[Child](/child)" : "No links",
        };
      }
      return { title: "Child", content: "child" };
    });
    const reader = { read: vi.fn(async () => ({ urls: [], warnings: [], truncated: false })) };
    const firstArguments = [
      "crawl",
      "monitor",
      "https://example.com/",
      "--monitor-dir",
      monitorDir,
      "--max-depth",
      "0",
      "--sitemap",
      "skip",
      "--output",
      runsDir,
      "--json",
    ];
    expect(await runCli(firstArguments, dependencies(client, reader).deps)).toBe(0);

    secondRun = true;
    const secondDependencies = dependencies(client, reader);
    expect(
      await runCli(
        [
          "crawl",
          "monitor",
          "https://example.com/",
          "--monitor-dir",
          monitorDir,
          "--output",
          runsDir,
          "--json",
        ],
        secondDependencies.deps,
      ),
    ).toBe(0);
    expect(JSON.parse(secondDependencies.stdout.value())).toMatchObject({
      settings: { max_depth: 0 },
      stats: { discovered: 1, fetched: 1 },
    });
    expect(client.fetch).toHaveBeenCalledTimes(2);
    expect((await readCrawlMonitorState(monitorDir))?.options.maxDepth).toBe(0);
  });

  it("supports status and reset without a billable request", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-monitor-status-"));
    const monitorDir = join(root, "state");
    const runsDir = join(root, "runs");
    const client = crawlClient(async () => ({ title: "Seed", content: "No links" }));
    const reader = { read: vi.fn(async () => ({ urls: [], warnings: [], truncated: false })) };
    expect(
      await runCli(
        [
          "crawl",
          "monitor",
          "https://example.com/",
          "--monitor-dir",
          monitorDir,
          "--max-depth",
          "0",
          "--delay-ms",
          "0",
          "--output",
          runsDir,
        ],
        dependencies(client, reader).deps,
      ),
    ).toBe(0);

    const statusDependencies = dependencies(client, reader);
    expect(
      await runCli(["crawl", "monitor", "status", monitorDir, "--json"], statusDependencies.deps),
    ).toBe(0);
    expect(JSON.parse(statusDependencies.stdout.value())).toMatchObject({
      state_dir: monitorDir,
      seed_url: "https://example.com/",
      baseline: [{ url: "https://example.com/" }],
    });

    const resetDependencies = dependencies(client, reader);
    expect(
      await runCli(["crawl", "monitor", "reset", monitorDir, "--json"], resetDependencies.deps),
    ).toBe(0);
    expect(JSON.parse(resetDependencies.stdout.value())).toEqual({
      state_dir: monitorDir,
      removed: true,
    });
    expect(await readCrawlMonitorState(monitorDir)).toBeNull();
  });

  it("releases its lock and leaves no report when the initial Crawl fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-monitor-error-"));
    const monitorDir = join(root, "state");
    const runsDir = join(root, "runs");
    const client = crawlClient(async () => Promise.reject(new Error("seed failed")));
    const reader = { read: vi.fn(async () => ({ urls: [], warnings: [], truncated: false })) };
    const invocation = dependencies(client, reader);

    expect(
      await runCli(
        [
          "crawl",
          "monitor",
          "https://example.com/",
          "--monitor-dir",
          monitorDir,
          "--max-depth",
          "0",
          "--sitemap",
          "skip",
          "--output",
          runsDir,
        ],
        invocation.deps,
      ),
    ).toBe(1);
    expect(invocation.stderr.value()).toContain("seed failed");
    expect(await readCrawlMonitorState(monitorDir)).toBeNull();
    await expect(lstat(join(monitorDir, "writer.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(runsDir)).toEqual([]);
  });

  it("rejects a second monitor writer before making a request", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-monitor-lock-"));
    const monitorDir = join(root, "state");
    const runsDir = join(root, "runs");
    const client = crawlClient(async () => ({ title: "Seed", content: "No links" }));
    const reader = { read: vi.fn(async () => ({ urls: [], warnings: [], truncated: false })) };
    const active = await CrawlMonitorStore.open(monitorDir);
    const invocation = dependencies(client, reader);

    expect(
      await runCli(
        [
          "crawl",
          "monitor",
          "https://example.com/",
          "--monitor-dir",
          monitorDir,
          "--max-depth",
          "0",
          "--sitemap",
          "skip",
          "--output",
          runsDir,
        ],
        invocation.deps,
      ),
    ).toBe(1);
    expect(invocation.stderr.value()).toMatch(/writer\.lock|exists/i);
    expect(client.fetch).not.toHaveBeenCalled();
    await active.release();
  });
});
