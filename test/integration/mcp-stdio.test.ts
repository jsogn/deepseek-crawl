import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map(async (close) => close()));
});

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

async function startMockDeepSeek() {
  const searchBody = await fixture("search-success.json");
  const fetchBody = await fixture("fetch-success.json");
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/tools/search") {
        response.end(searchBody);
        return;
      }
      if (request.url === "/v1/tools/fetch") {
        response.end(fetchBody);
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock server did not bind a TCP port.");
  }
  closers.push(
    async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return `http://127.0.0.1:${address.port}/`;
}

describe("MCP over stdio", () => {
  it("negotiates and calls Search and Fetch against a local DeepSeek mock", async () => {
    const baseUrl = await startMockDeepSeek();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/bin.js", "mcp"],
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "offline-test-key",
        DEEPSEEK_BASE_URL: baseUrl,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-integration", version: "1.0.0" });
    closers.push(async () => client.close());
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "deepseek_crawl",
      "deepseek_fetch",
      "deepseek_map",
      "deepseek_search",
    ]);

    const search = await client.callTool({
      name: "deepseek_search",
      arguments: { query: "DeepSeek Search", count: 1 },
    });
    expect(search.isError).toBeUndefined();
    expect(search.structuredContent).toMatchObject({
      results: [{ title: "DeepSeek Search" }],
    });

    const fetched = await client.callTool({
      name: "deepseek_fetch",
      arguments: { url: "https://api-docs.deepseek.com/guides/search/" },
    });
    expect(fetched.isError).toBeUndefined();
    expect(fetched.structuredContent).toMatchObject({
      title: "DeepSeek Search",
      content: "# Search and Fetch\n\nMarkdown content.",
    });
  });
});
