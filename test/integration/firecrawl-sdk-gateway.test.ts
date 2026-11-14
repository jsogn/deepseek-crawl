import { createServer, type Server } from "node:http";
import { Firecrawl } from "firecrawl";
import { afterEach, describe, expect, it } from "vitest";
import type { DeepSeekGateway } from "../../src/deepseek/gateway.js";
import { type GatewayServer, startGatewayServer } from "../../src/gateway/server.js";

interface MockResponse {
  status?: number;
  body: unknown;
}

interface MockRequest {
  method: string;
  path: string;
  authorization: string | undefined;
}

const servers: Array<GatewayServer | Server> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      if ("url" in server) {
        return server.close();
      }
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }),
  );
});

async function startMockUpstream(
  handler: (request: MockRequest) => MockResponse,
): Promise<{ url: URL; requests: MockRequest[] }> {
  const requests: MockRequest[] = [];
  const server = createServer(async (request, response) => {
    const captured = {
      method: request.method ?? "GET",
      path: request.url ?? "/",
      authorization: request.headers.authorization,
    };
    requests.push(captured);
    for await (const _chunk of request) {
      // Drain the body so the client can reuse the connection.
    }
    const result = handler(captured);
    const body = Buffer.from(JSON.stringify(result.body));
    response.writeHead(result.status ?? 200, {
      "content-type": "application/json",
      "content-length": String(body.byteLength),
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock upstream did not expose a TCP address.");
  }
  return {
    url: new URL(`http://127.0.0.1:${address.port}/`),
    requests,
  };
}

function testConfig(upstreamUrl: URL) {
  return {
    host: "127.0.0.1",
    port: 0,
    allowRemote: false,
    upstreamUrl,
    requestBodyLimit: 8 * 1024 * 1024,
    timeoutMs: 5000,
  };
}

describe("Firecrawl SDK against the gateway", () => {
  it("uses the official SDK to parse Firecrawl Search, Scrape, and Map passthrough", async () => {
    const upstream = await startMockUpstream((request) => {
      switch (request.path) {
        case "/v2/search":
          return {
            body: {
              success: true,
              data: {
                web: [
                  {
                    title: "Example",
                    description: "Example result",
                    url: "https://example.com/",
                  },
                ],
              },
              creditsUsed: 1,
            },
          };
        case "/v2/scrape":
          return {
            body: {
              success: true,
              data: {
                markdown: "# Example",
                metadata: {
                  title: "Example",
                  sourceURL: "https://example.com/",
                  url: "https://example.com/",
                  statusCode: 200,
                },
              },
            },
          };
        case "/v2/map":
          return {
            body: {
              success: true,
              links: [{ url: "https://example.com/docs" }],
            },
          };
        default:
          return { status: 404, body: { success: false, error: "not found" } };
      }
    });
    const gateway = await startGatewayServer({
      config: testConfig(upstream.url),
      env: { FIRECRAWL_API_KEY: "fc-test" },
      fetchImpl: fetch,
    });
    servers.push(gateway);
    const client = new Firecrawl({
      apiKey: "fc-test",
      apiUrl: gateway.url.href.replace(/\/$/, ""),
    });

    const search = await client.search("example", { limit: 1 });
    const firstSearchResult = search.web?.[0];
    expect(
      firstSearchResult && "url" in firstSearchResult ? firstSearchResult.url : undefined,
    ).toBe("https://example.com/");

    const scraped = await client.scrape("https://example.com/", {
      formats: ["markdown"],
    });
    expect(scraped.markdown).toBe("# Example");

    const mapped = await client.map("https://example.com/", { limit: 1 });
    expect(mapped.links[0]?.url).toBe("https://example.com/docs");

    expect(upstream.requests.map((request) => request.path)).toEqual([
      "/v2/search",
      "/v2/scrape",
      "/v2/map",
    ]);
    expect(upstream.requests.every((request) => request.authorization === "Bearer fc-test")).toBe(
      true,
    );
  });

  it("uses the official SDK unchanged when Firecrawl credits require a DeepSeek fallback", async () => {
    const upstream = await startMockUpstream(() => ({
      status: 402,
      body: { success: false, error: "Payment required." },
    }));
    const deepseek: DeepSeekGateway = {
      async search() {
        return {
          results: [
            {
              rerank_score: 1,
              title: "Example",
              url: "https://example.com/",
              snippet: "Example result",
              summary: "Example result",
              content: "# Example",
              site_name: "Example",
              site_icon: null,
              date: null,
              authority: 1,
            },
          ],
        };
      },
      async fetch() {
        return {
          title: "Example",
          content: "# Example",
        };
      },
    };
    const gateway = await startGatewayServer({
      config: testConfig(upstream.url),
      env: { FIRECRAWL_API_KEY: "fc-test" },
      fetchImpl: fetch,
      deepseekClient: deepseek,
      sitemapReader: {
        async read() {
          return {
            entries: [{ url: new URL("https://example.com/docs") }],
            warnings: [],
            truncated: false,
          };
        },
      },
    });
    servers.push(gateway);
    const client = new Firecrawl({
      apiKey: "fc-test",
      apiUrl: gateway.url.href.replace(/\/$/, ""),
    });

    const search = await client.search("example", {
      limit: 1,
      scrapeOptions: { formats: ["markdown"] },
    });
    const firstSearchResult = search.web?.[0];
    expect(
      firstSearchResult && "url" in firstSearchResult ? firstSearchResult.url : undefined,
    ).toBe("https://example.com/");
    expect(
      firstSearchResult && "markdown" in firstSearchResult ? firstSearchResult.markdown : undefined,
    ).toBe("# Example");

    const scraped = await client.scrape("https://example.com/", {
      formats: ["markdown"],
    });
    expect(scraped.markdown).toBe("# Example");

    const mapped = await client.map("https://example.com/", { limit: 2 });
    expect(mapped.links.map((link) => link.url)).toContain("https://example.com/docs");

    expect(upstream.requests).toHaveLength(1);
  });

  it("runs the official SDK crawl lifecycle through a DeepSeek-backed gateway job", async () => {
    const upstream = await startMockUpstream(() => ({
      status: 402,
      body: { success: false, error: "Payment required." },
    }));
    const gateway = await startGatewayServer({
      config: testConfig(upstream.url),
      env: { FIRECRAWL_API_KEY: "fc-test" },
      fetchImpl: fetch,
      deepseekClient: {
        async search() {
          throw new Error("Unexpected Search call.");
        },
        async fetch() {
          return { title: "Example", content: "# Example" };
        },
      },
      sitemapReader: {
        async read() {
          return { entries: [], warnings: [], truncated: false };
        },
      },
    });
    servers.push(gateway);
    const client = new Firecrawl({
      apiKey: "fc-test",
      apiUrl: gateway.url.href.replace(/\/$/, ""),
    });

    const started = await client.startCrawl("https://example.com/", {
      limit: 1,
      maxDiscoveryDepth: 0,
      sitemap: "skip",
    });
    expect(started.id).toMatch(/^dsc_/);

    let status = await client.getCrawlStatus(started.id);
    for (let attempt = 0; attempt < 50 && status.status === "scraping"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await client.getCrawlStatus(started.id);
    }
    expect(status.status).toBe("completed");
    expect(status.data[0]?.markdown).toBe("# Example");

    const errors = await client.getCrawlErrors(started.id);
    expect(errors).toEqual({ errors: [], robotsBlocked: [] });
    await expect(client.cancelCrawl(started.id)).resolves.toBe(false);
    expect(upstream.requests).toHaveLength(1);
  });

  it("passes an official SDK Firecrawl-owned crawl lifecycle through unchanged", async () => {
    const upstream = await startMockUpstream((request) => {
      if (request.method === "POST" && request.path === "/v2/crawl") {
        return {
          body: { success: true, id: "fc_crawl", url: "https://example.com/" },
        };
      }
      if (request.method === "GET" && request.path === "/v2/crawl/fc_crawl") {
        return {
          body: {
            success: true,
            status: "completed",
            completed: 1,
            total: 1,
            creditsUsed: 1,
            data: [
              {
                markdown: "# Example",
                metadata: {
                  title: "Example",
                  sourceURL: "https://example.com/",
                  url: "https://example.com/",
                  statusCode: 200,
                },
              },
            ],
            next: null,
          },
        };
      }
      if (request.method === "GET" && request.path === "/v2/crawl/fc_crawl/errors") {
        return {
          body: { errors: [], robotsBlocked: [] },
        };
      }
      if (request.method === "DELETE" && request.path === "/v2/crawl/fc_crawl") {
        return {
          body: { status: "cancelled" },
        };
      }
      return { status: 404, body: { success: false, error: "not found" } };
    });
    const gateway = await startGatewayServer({
      config: testConfig(upstream.url),
      env: { FIRECRAWL_API_KEY: "fc-test" },
      fetchImpl: fetch,
    });
    servers.push(gateway);
    const client = new Firecrawl({
      apiKey: "fc-test",
      apiUrl: gateway.url.href.replace(/\/$/, ""),
    });

    const started = await client.startCrawl("https://example.com/", { limit: 1 });
    expect(started).toEqual({ id: "fc_crawl", url: "https://example.com/" });

    const status = await client.getCrawlStatus(started.id);
    expect(status.status).toBe("completed");
    expect(status.data[0]?.markdown).toBe("# Example");

    await expect(client.getCrawlErrors(started.id)).resolves.toEqual({
      errors: [],
      robotsBlocked: [],
    });
    await expect(client.cancelCrawl(started.id)).resolves.toBe(true);
    expect(upstream.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v2/crawl",
      "GET /v2/crawl/fc_crawl",
      "GET /v2/crawl/fc_crawl/errors",
      "DELETE /v2/crawl/fc_crawl",
    ]);
  });

  it("surfaces unsupported fallback features as official SDK errors", async () => {
    const upstream = await startMockUpstream(() => ({
      status: 402,
      body: { success: false, error: "Payment required." },
    }));
    const gateway = await startGatewayServer({
      config: testConfig(upstream.url),
      env: { FIRECRAWL_API_KEY: "fc-test" },
      fetchImpl: fetch,
      deepseekClient: {
        async search() {
          throw new Error("Unexpected Search call.");
        },
        async fetch() {
          throw new Error("Unexpected Fetch call.");
        },
      },
    });
    servers.push(gateway);
    const client = new Firecrawl({
      apiKey: "fc-test",
      apiUrl: gateway.url.href.replace(/\/$/, ""),
    });

    await expect(
      client.scrape("https://example.com/", {
        formats: ["screenshot"],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "unsupported_fallback_feature",
    });
  });
});
