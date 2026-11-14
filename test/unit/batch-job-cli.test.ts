import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BatchFetchJobStore } from "../../src/batch/job.js";
import { runCli } from "../../src/cli/run.js";
import { contentHash } from "../../src/content/hash.js";
import type { DeepSeekGateway } from "../../src/deepseek/gateway.js";
import { cliDependencies as dependencies } from "../helpers/cli.js";

describe("Batch Fetch job CLI", () => {
  it("documents job creation, status, and resume", async () => {
    const { deps, stdout } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(await runCli(["help", "fetch"], deps)).toBe(0);

    expect(stdout.value()).toContain("--job-dir <dir>");
    expect(stdout.value()).toContain("fetch resume <job-dir>");
    expect(stdout.value()).toContain("fetch status <job-dir>");
  });

  it("resumes an interrupted batch without requesting completed pages again", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-batch-job-cli-"));
    const input = join(root, "urls.txt");
    const jobDir = join(root, "job");
    const output = join(root, "final");
    await writeFile(
      input,
      ["https://example.com/a", "https://example.com/b", "https://example.com/c", ""].join("\n"),
      "utf8",
    );

    const controller = new AbortController();
    const firstFetch = vi.fn(async ({ url }: { url: string }) => {
      if (url === "https://example.com/b") {
        controller.abort(new Error("interrupted"));
        throw new Error("interrupted");
      }
      return { title: url, content: `first:${url}` };
    });
    const firstDependencies = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(
        [
          "fetch",
          "--input",
          input,
          "--output-dir",
          output,
          "--job-dir",
          jobDir,
          "--concurrency",
          "1",
          "--delay-ms",
          "0",
          "--json",
        ],
        {
          ...firstDependencies.deps,
          fetchClient: {
            search: vi.fn(),
            fetch: firstFetch as unknown as DeepSeekGateway["fetch"],
          },
          signal: controller.signal,
        },
      ),
    ).toBe(130);
    expect(firstFetch.mock.calls.map(([request]) => request.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });

    const statusDependencies = dependencies(vi.fn() as unknown as typeof fetch, {});
    expect(await runCli(["fetch", "status", jobDir, "--json"], statusDependencies.deps)).toBe(0);
    expect(JSON.parse(statusDependencies.stdout.value())).toMatchObject({
      status: "interrupted",
      input: 3,
      requests: 3,
      pages: 1,
      failures: 0,
      pending: 2,
    });

    const resumedFetch = vi.fn(async ({ url }: { url: string }) => ({
      title: url,
      content: `resumed:${url}`,
    }));
    const resumeDependencies = dependencies(vi.fn() as unknown as typeof fetch);
    expect(
      await runCli(["fetch", "resume", jobDir, "--json"], {
        ...resumeDependencies.deps,
        fetchClient: {
          search: vi.fn(),
          fetch: resumedFetch as unknown as DeepSeekGateway["fetch"],
        },
      }),
    ).toBe(0);

    expect(resumedFetch.mock.calls.map(([request]) => request.url)).toEqual([
      "https://example.com/b",
      "https://example.com/c",
    ]);
    const report = JSON.parse(await readFile(join(output, "fetch.json"), "utf8"));
    expect(report).toMatchObject({
      stats: { input: 3, unique: 3, fetched: 3, failed: 0 },
      pages: [
        { index: 1, url: "https://example.com/a" },
        { index: 2, url: "https://example.com/b" },
        { index: 3, url: "https://example.com/c" },
      ],
    });

    const completedDependencies = dependencies(vi.fn() as unknown as typeof fetch, {});
    expect(await runCli(["fetch", "status", jobDir, "--json"], completedDependencies.deps)).toBe(0);
    expect(JSON.parse(completedDependencies.stdout.value())).toMatchObject({
      status: "completed",
      pages: 3,
      failures: 0,
      pending: 0,
    });
  });

  it("does not skip a valid request when an invalid failure shares its index", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-batch-job-cli-"));
    const input = join(root, "urls.txt");
    const jobDir = join(root, "job");
    const output = join(root, "final");
    await writeFile(
      input,
      "file:///etc/passwd\nhttps://example.com/a\nhttps://example.com/b\n",
      "utf8",
    );
    const controller = new AbortController();
    const first = await runCli(
      [
        "fetch",
        "--input",
        input,
        "--output-dir",
        output,
        "--job-dir",
        jobDir,
        "--concurrency",
        "1",
        "--delay-ms",
        "0",
      ],
      {
        ...dependencies(vi.fn() as unknown as typeof fetch).deps,
        fetchClient: {
          search: vi.fn(),
          fetch: (async ({ url }: { url: string }) => {
            controller.abort(new Error("interrupted"));
            throw new Error(`interrupted:${url}`);
          }) as unknown as DeepSeekGateway["fetch"],
        },
        signal: controller.signal,
      },
    );
    expect(first).toBe(130);

    const statusDependencies = dependencies(vi.fn() as unknown as typeof fetch, {});
    expect(await runCli(["fetch", "status", jobDir, "--json"], statusDependencies.deps)).toBe(0);
    expect(JSON.parse(statusDependencies.stdout.value())).toMatchObject({
      pending: 2,
      failures: 1,
    });

    const resumedFetch = vi.fn(async ({ url }: { url: string }) => ({
      title: url,
      content: "body",
    }));
    expect(
      await runCli(["fetch", "resume", jobDir, "--json"], {
        ...dependencies(vi.fn() as unknown as typeof fetch).deps,
        fetchClient: {
          search: vi.fn(),
          fetch: resumedFetch as unknown as DeepSeekGateway["fetch"],
        },
      }),
    ).toBe(0);

    expect(resumedFetch.mock.calls.map(([request]) => request.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(JSON.parse(await readFile(join(output, "fetch.json"), "utf8"))).toMatchObject({
      stats: { input: 3, unique: 2, fetched: 2, failed: 1 },
      pages: [{ url: "https://example.com/a" }, { url: "https://example.com/b" }],
    });
  });

  it("publishes a completed job with recorded failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-batch-job-cli-"));
    const input = join(root, "urls.txt");
    const jobDir = join(root, "job");
    const output = join(root, "final");
    await writeFile(input, "https://example.com/a\nhttps://example.com/b\n", "utf8");
    const fetchPage = vi.fn(async ({ url }: { url: string }) => {
      if (url === "https://example.com/b") {
        throw new Error("page unavailable");
      }
      return { title: url, content: "body" };
    });
    const { deps } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(
        [
          "fetch",
          "--input",
          input,
          "--output-dir",
          output,
          "--job-dir",
          jobDir,
          "--concurrency",
          "1",
          "--delay-ms",
          "0",
          "--json",
        ],
        {
          ...deps,
          fetchClient: {
            search: vi.fn(),
            fetch: fetchPage as unknown as DeepSeekGateway["fetch"],
          },
        },
      ),
    ).toBe(0);

    expect(JSON.parse(await readFile(join(output, "fetch.json"), "utf8"))).toMatchObject({
      stats: { input: 2, unique: 2, fetched: 1, failed: 1 },
      failures: [
        {
          index: 2,
          url: "https://example.com/b",
          kind: "fetch",
          message: "page unavailable",
        },
      ],
    });
    const statusDependencies = dependencies(vi.fn() as unknown as typeof fetch, {});
    expect(await runCli(["fetch", "status", jobDir, "--json"], statusDependencies.deps)).toBe(0);
    expect(JSON.parse(statusDependencies.stdout.value())).toMatchObject({
      status: "completed",
      pages: 1,
      failures: 1,
      pending: 0,
    });
  });

  it("republishes completed job state when the final output is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-batch-job-cli-"));
    const jobDir = join(root, "job");
    const output = join(root, "final");
    const startedAt = "2026-11-14T01:00:00.000Z";
    const store = await BatchFetchJobStore.create(jobDir, {
      version: 1,
      status: "running",
      source: "map.json",
      output_dir: output,
      started_at: startedAt,
      updated_at: startedAt,
      input: 1,
      settings: { concurrency: 1, delay_ms: 0, max_chars: 0 },
      requests: [{ index: 1, url: "https://example.com/a" }],
      pages: [],
      failures: [],
    });
    await store.recordPage({
      index: 1,
      url: "https://example.com/a",
      title: "A",
      content: "# A",
      contentHash: contentHash("# A"),
      contentTruncated: false,
      contentOriginalLength: 3,
    });
    await store.markCompleted();
    await store.release();

    const fetchPage = vi.fn();
    const { deps } = dependencies(vi.fn() as unknown as typeof fetch, {});
    expect(
      await runCli(["fetch", "resume", jobDir, "--json"], {
        ...deps,
        fetchClient: {
          search: vi.fn(),
          fetch: fetchPage as unknown as DeepSeekGateway["fetch"],
        },
      }),
    ).toBe(0);

    expect(fetchPage).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(output, "fetch.json"), "utf8"))).toMatchObject({
      stats: { fetched: 1, failed: 0 },
    });
  });

  it("fails before network requests when the final output already exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-batch-job-cli-"));
    const input = join(root, "urls.txt");
    const jobDir = join(root, "job");
    const output = join(root, "final");
    await writeFile(input, "https://example.com/a\n", "utf8");
    await mkdir(output);
    const fetchPage = vi.fn();
    const { deps, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["fetch", "--input", input, "--output-dir", output, "--job-dir", jobDir], {
        ...deps,
        fetchClient: {
          search: vi.fn(),
          fetch: fetchPage as unknown as DeepSeekGateway["fetch"],
        },
      }),
    ).toBe(1);

    expect(fetchPage).not.toHaveBeenCalled();
    await expect(lstat(jobDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(stderr.value()).toContain("already exists");
  });

  it.each(["same", "job-inside-output", "output-inside-job"])(
    "rejects overlapping job and output paths: %s",
    async (layout) => {
      const root = await mkdtemp(join(tmpdir(), "deepseek-batch-job-cli-"));
      const input = join(root, "urls.txt");
      const base = join(root, "paths");
      const jobDir =
        layout === "output-inside-job"
          ? base
          : layout === "job-inside-output"
            ? join(base, "job")
            : base;
      const output =
        layout === "job-inside-output"
          ? base
          : layout === "output-inside-job"
            ? join(base, "output")
            : base;
      await writeFile(input, "https://example.com/a\n", "utf8");
      const fetchPage = vi.fn();
      const { deps, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

      expect(
        await runCli(["fetch", "--input", input, "--output-dir", output, "--job-dir", jobDir], {
          ...deps,
          fetchClient: {
            search: vi.fn(),
            fetch: fetchPage as unknown as DeepSeekGateway["fetch"],
          },
        }),
      ).toBe(2);

      expect(fetchPage).not.toHaveBeenCalled();
      await expect(lstat(jobDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(stderr.value()).toMatch(/job-dir.*output-dir|overlap|separate/i);
    },
  );
});
