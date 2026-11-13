import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekError } from "../../src/deepseek/errors.js";
import { createMcpServer } from "../../src/mcp/server.js";

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
  it("lists exactly the DeepSeek tools with read-only annotations", async () => {
    const { client } = await connectedServer();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["deepseek_fetch", "deepseek_search"]);
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
