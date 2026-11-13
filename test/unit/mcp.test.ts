import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekError } from "../../src/deepseek/errors.js";
import { createMcpServer, resolveMcpCrawlLimits } from "../../src/mcp/server.js";

const baseResult = {
  rerank_score: 2.4,
  title: "Result",
  url: "https://example.com/result",
  snippet: "Short",
  summary: "Summary",
  content: "",
  site_name: "Example",
  site_icon: null,
  date: null,
  authority: 3,
};

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map(async (close) => close()));
});

async function connectedServer() {
  const gateway = {
    search: vi.fn(async () => ({ results: [baseResult] })),
    fetch: vi.fn(async () => ({ title: "Page", content: "# Body" })),
  };
  const server = createMcpServer({ client: gateway });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, gateway };
}

describe("MCP server", () => {
  it("clamps oversized Crawl resource overrides to hard caps", () => {
    expect(
      resolveMcpCrawlLimits({
        discoveryLimit: 5000,
        pageContentLimit: 2000000,
        aggregateContentLimit: 500000,
      }),
    ).toEqual({
      discoveryLimit: 2000,
      pageContentLimit: 1000000,
      aggregateContentLimit: 100000,
    });
  });

  it.each([
    [{ discoveryLimit: -1 }, /discoveryLimit/i],
    [{ pageContentLimit: 1.5 }, /pageContentLimit/i],
    [{ aggregateContentLimit: Number.NaN }, /aggregateContentLimit/i],
  ])("rejects invalid Crawl resource overrides", (crawl, message) => {
    expect(() => resolveMcpCrawlLimits(crawl)).toThrow(message);
  });

  it("lists exactly the DeepSeek tools with read-only annotations", async () => {
    const { client } = await connectedServer();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "deepseek_crawl",
      "deepseek_fetch",
      "deepseek_search",
    ]);
    expect(tools.every((tool) => tool.outputSchema)).toBe(true);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("describes web content as untrusted", async () => {
    const { client } = await connectedServer();
    expect(client.getInstructions()).toMatch(/untrusted/i);
  });

  it("bounds Search content by default and does not forward MCP-only options", async () => {
    const { client, gateway } = await connectedServer();
    const content = "x".repeat(5000);
    gateway.search.mockResolvedValueOnce({ results: [{ ...baseResult, content }] });

    const result = await client.callTool({
      name: "deepseek_search",
      arguments: { query: "test", need_content: true },
    });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      results: Array<{ content: string; content_truncated?: boolean }>;
    };
    expect(structured.results[0]?.content).toHaveLength(4000);
    expect(structured.results[0]?.content_truncated).toBe(true);
    expect(gateway.search.mock.calls[0]?.[0]).toEqual({
      query: "test",
      count: 10,
      need_content: true,
    });
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("Result") }),
    ]);
  });

  it("bounds Fetch content by default", async () => {
    const { client, gateway } = await connectedServer();
    gateway.fetch.mockResolvedValueOnce({ title: "Page", content: "x".repeat(30001) });
    const result = await client.callTool({
      name: "deepseek_fetch",
      arguments: { url: "https://example.com/page" },
    });
    const structured = result.structuredContent as { content: string; truncated?: boolean };
    expect(structured.content).toHaveLength(30000);
    expect(structured.truncated).toBe(true);
  });

  it("returns bounded Crawl pages without writing files", async () => {
    const { client, gateway } = await connectedServer();
    const result = await client.callTool({
      name: "deepseek_crawl",
      arguments: { url: "https://example.com/", max_pages: 2, delay_ms: 0 },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      version: 1,
      seed_url: "https://example.com/",
      settings: {
        max_depth: 2,
        max_pages: 2,
        concurrency: 2,
        delay_ms: 0,
      },
      stats: {
        discovered: 1,
        fetched: 1,
        failed: 0,
      },
      pages: [
        {
          url: "https://example.com/",
          title: "Page",
          depth: 0,
          content: "# Body",
        },
      ],
      failures: [],
    });
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.not.stringContaining("# Body\n"),
      }),
    ]);
    expect(gateway.fetch).toHaveBeenCalledTimes(1);
    expect(
      (result as { structuredContent?: { pages?: Array<{ path?: string }> } }).structuredContent
        ?.pages?.[0]?.path,
    ).toBeUndefined();
  });

  it("bounds each Crawl page to 4000 characters by default", async () => {
    const { client, gateway } = await connectedServer();
    gateway.fetch.mockResolvedValueOnce({ title: "Long", content: "x".repeat(5000) });

    const result = await client.callTool({
      name: "deepseek_crawl",
      arguments: { url: "https://example.com/", delay_ms: 0 },
    });
    const structured = result.structuredContent as {
      pages: Array<{
        content: string;
        content_truncated?: boolean;
        content_original_length?: number;
      }>;
    };

    expect(structured.pages[0]).toMatchObject({
      content: "x".repeat(4000),
      content_truncated: true,
      content_original_length: 5000,
    });
  });

  it("never returns more than 100,000 aggregate content characters", async () => {
    const { client, gateway } = await connectedServer();
    gateway.fetch.mockImplementation(async ({ url }) => {
      const path = new URL(url).pathname;
      const links =
        path === "/"
          ? Array.from({ length: 19 }, (_, index) => `[Page ${index + 1}](/${index + 1})`).join(" ")
          : "";
      return {
        title: path,
        content: `${"x".repeat(6000)}\n${links}`,
      };
    });

    const result = await client.callTool({
      name: "deepseek_crawl",
      arguments: {
        url: "https://example.com/",
        max_depth: 1,
        max_pages: 20,
        max_chars: 6000,
        delay_ms: 0,
      },
    });
    const structured = result.structuredContent as {
      pages: Array<{ content: string; content_omitted?: boolean }>;
    };

    expect(
      structured.pages.reduce((total, page) => total + [...page.content].length, 0),
    ).toBeLessThanOrEqual(100000);
    expect(structured.pages.some((page) => page.content_omitted === true)).toBe(true);
  });

  it("keeps successful Crawl pages when a child page fails", async () => {
    const { client, gateway } = await connectedServer();
    gateway.fetch.mockImplementation(async ({ url }) => {
      if (url === "https://example.com/") {
        return {
          title: "Seed",
          content: "[Missing](/missing) [Good](/good)",
        };
      }
      if (url === "https://example.com/missing") {
        throw new DeepSeekError("Missing", { kind: "not_found" });
      }
      return { title: "Good", content: "available" };
    });

    const result = await client.callTool({
      name: "deepseek_crawl",
      arguments: {
        url: "https://example.com/",
        max_depth: 1,
        delay_ms: 0,
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      stats: { fetched: 2, failed: 1 },
      pages: [{ url: "https://example.com/" }, { url: "https://example.com/good" }],
      failures: [{ url: "https://example.com/missing", kind: "not_found" }],
    });
  });

  it("returns a tool error when the Crawl seed fails", async () => {
    const { client, gateway } = await connectedServer();
    gateway.fetch.mockRejectedValueOnce(new DeepSeekError("Seed unavailable", { kind: "network" }));

    const result = await client.callTool({
      name: "deepseek_crawl",
      arguments: { url: "https://example.com/", delay_ms: 0 },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Seed unavailable");
  });

  it("rejects invalid input before calling the gateway", async () => {
    const { client, gateway } = await connectedServer();
    const result = await client.callTool({
      name: "deepseek_search",
      arguments: { query: "" },
    });
    expect(result.isError).toBe(true);
    expect(gateway.search).not.toHaveBeenCalled();
  });

  it("returns API failures as tool errors", async () => {
    const { client, gateway } = await connectedServer();
    gateway.fetch.mockRejectedValueOnce(
      new DeepSeekError("DeepSeek account balance is insufficient.", {
        kind: "balance",
        status: 402,
      }),
    );
    const result = await client.callTool({
      name: "deepseek_fetch",
      arguments: { url: "https://example.com/page" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("balance is insufficient");
  });
});
