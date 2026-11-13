import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/run.js";

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
  return {
    deps: { env, fetchImpl, stdout, stderr },
    stdout,
    stderr,
  };
}

describe("runCli", () => {
  it("renders deduplicated Map URLs in sorted human order", async () => {
    const sitemapReader = {
      read: vi.fn(async () => ({
        urls: [new URL("https://example.com/a")],
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

  it("writes Map JSON without overwriting an existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-map-"));
    const output = join(root, "urls.json");
    await writeFile(output, "original", "utf8");
    const sitemapReader = {
      read: vi.fn(async () => ({ urls: [], warnings: [], truncated: false })),
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
    expect(await readFile(output, "utf8")).toBe("original");
    expect(stderr.value()).toContain("EEXIST");
  });

  it("runs Crawl and writes the output directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-cli-"));
    const output = join(root, "crawl");
    const crawlClient = {
      search: vi.fn(),
      fetch: vi.fn(async ({ url }: { url: string }) => ({
        title: url.endsWith("/") ? "Example" : "Next",
        content: url.endsWith("/") ? "[Next](/next)" : "# Next",
      })),
    };
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
        { ...deps, crawlClient },
      ),
    ).toBe(0);
    expect(crawlClient.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(join(output, "crawl.json"), "utf8"))).toMatchObject({
      seed_url: "https://example.com/",
      stats: { discovered: 2, fetched: 2, failed: 0 },
      pages: [{ path: "pages/0001-page.md" }, { path: "pages/0002-next.md" }],
    });
    expect(await readFile(join(output, "pages", "0001-page.md"), "utf8")).toContain("# Example");
    expect(stdout.value()).toContain(`Output: ${output}`);
    expect(stderr.value()).toBe("");
  });

  it("cleans Crawl staging when the signal is already aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-cli-"));
    const output = join(root, "crawl");
    const controller = new AbortController();
    controller.abort();
    const { deps, stderr } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(["crawl", "https://example.com", "--output", output], {
        ...deps,
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
    const { deps, stdout } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(
      await runCli(
        ["crawl", "https://example.com", "--max-depth", "0", "--output", output, "--json"],
        { ...deps, crawlClient },
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.value())).toMatchObject({
      seed_url: "https://example.com/",
      pages: [{ path: "pages/0001-page.md", content_length: 9 }],
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
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 404 }));
    const { deps, stdout } = dependencies(fetchImpl as unknown as typeof fetch);

    expect(await runCli(["doctor", "--json"], deps)).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe("GET");
    expect(JSON.parse(stdout.value())).toMatchObject({
      ok: true,
      api_key: "configured",
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
