import { afterEach, describe, expect, it } from "vitest";
import type { DeepSeekGateway } from "../../src/deepseek/gateway.js";
import { type GatewayServer, startGatewayServer } from "../../src/gateway/server.js";

const servers: GatewayServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function testConfig() {
  return {
    host: "127.0.0.1",
    port: 0,
    allowRemote: false,
    upstreamUrl: new URL("https://api.firecrawl.dev/"),
    requestBodyLimit: 1024 * 1024,
    timeoutMs: 2000,
  };
}

describe("Firecrawl-compatible gateway", () => {
  it("passes an incoming Firecrawl request through to the upstream API", async () => {
    const upstreamResponse = {
      success: true,
      data: {
        markdown: "# Example",
        metadata: { sourceURL: "https://example.com/", url: "https://example.com/" },
      },
    };
    let upstreamRequest:
      | { url: string; method: string; authorization: string | null; body: string }
      | undefined;
    const server = await startGatewayServer({
      config: testConfig(),
      env: {},
      fetchImpl: async (input, init) => {
        upstreamRequest = {
          url: String(input),
          method: init?.method ?? "GET",
          authorization: new Headers(init?.headers).get("authorization"),
          body: String(init?.body ?? ""),
        };
        return Response.json(upstreamResponse);
      },
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/scrape?source=test", server.url), {
      method: "POST",
      headers: {
        Authorization: "Bearer fc-test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com/", formats: ["markdown"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(upstreamResponse);
    expect(upstreamRequest).toEqual({
      url: "https://api.firecrawl.dev/v2/scrape?source=test",
      method: "POST",
      authorization: "Bearer fc-test",
      body: JSON.stringify({ url: "https://example.com/", formats: ["markdown"] }),
    });
  });

  it("falls back to DeepSeek when Firecrawl reports exhausted credits", async () => {
    let deepSeekCalls = 0;
    const deepseekClient: DeepSeekGateway = {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch() {
        deepSeekCalls += 1;
        return {
          title: "Example",
          content: "# Example",
        };
      },
    };
    const server = await startGatewayServer({
      config: testConfig(),
      env: { FIRECRAWL_API_KEY: "fc-test" },
      deepseekClient,
      fetchImpl: async () =>
        Response.json(
          { success: false, error: "Payment required to access this resource." },
          { status: 402 },
        ),
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/scrape", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/", formats: ["markdown"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        markdown: "# Example",
        metadata: {
          title: "Example",
          sourceURL: "https://example.com/",
          url: "https://example.com/",
        },
      },
    });
    expect(deepSeekCalls).toBe(1);
  });

  it("exposes a DeepSeek-backed crawl through Firecrawl job endpoints", async () => {
    const deepseekClient: DeepSeekGateway = {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch() {
        return {
          title: "Example",
          content: "# Example",
        };
      },
    };
    const sitemapReader = {
      async read() {
        return {
          entries: [],
          warnings: [],
          truncated: false,
        };
      },
    };
    const server = await startGatewayServer({
      config: testConfig(),
      env: {},
      deepseekClient,
      sitemapReader,
      fetchImpl: async () => {
        throw new Error("Unexpected Firecrawl request.");
      },
    });
    servers.push(server);

    const createResponse = await fetch(new URL("/v2/crawl", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/",
        limit: 1,
        maxDiscoveryDepth: 0,
        sitemap: "skip",
      }),
    });
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { id: string; success: boolean; url: string };
    expect(created).toMatchObject({
      success: true,
      url: "https://example.com/",
    });
    expect(created.id).toMatch(/^dsc_/);

    let status: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const statusResponse = await fetch(new URL(`/v2/crawl/${created.id}`, server.url));
      expect(statusResponse.status).toBe(200);
      status = (await statusResponse.json()) as Record<string, unknown>;
      if (status.status !== "scraping") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status).toMatchObject({
      status: "completed",
      completed: 1,
      total: 1,
      creditsUsed: 0,
      data: [{ markdown: "# Example" }],
    });

    const errorsResponse = await fetch(new URL(`/v2/crawl/${created.id}/errors`, server.url));
    expect(errorsResponse.status).toBe(200);
    expect(await errorsResponse.json()).toEqual({
      errors: [],
      robotsBlocked: [],
    });
  });

  it("cancels a DeepSeek-backed crawl through the Firecrawl delete endpoint", async () => {
    const deepseekClient: DeepSeekGateway = {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      fetch(_input, signal) {
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const server = await startGatewayServer({
      config: testConfig(),
      env: {},
      deepseekClient,
      sitemapReader: {
        async read() {
          return { entries: [], warnings: [], truncated: false };
        },
      },
      fetchImpl: async () => {
        throw new Error("Unexpected Firecrawl request.");
      },
    });
    servers.push(server);

    const createResponse = await fetch(new URL("/v2/crawl", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/",
        limit: 1,
        maxDiscoveryDepth: 0,
        sitemap: "skip",
      }),
    });
    const created = (await createResponse.json()) as { id: string };

    const cancelResponse = await fetch(new URL(`/v2/crawl/${created.id}`, server.url), {
      method: "DELETE",
    });
    expect(cancelResponse.status).toBe(200);
    expect(await cancelResponse.json()).toEqual({ status: "cancelled" });

    const statusResponse = await fetch(new URL(`/v2/crawl/${created.id}`, server.url));
    expect(await statusResponse.json()).toMatchObject({ status: "cancelled" });
  });

  it("avoids repeated Firecrawl attempts while exhausted credits are cooling down", async () => {
    let firecrawlCalls = 0;
    let deepSeekCalls = 0;
    const server = await startGatewayServer({
      config: testConfig(),
      env: { FIRECRAWL_API_KEY: "fc-test" },
      deepseekClient: {
        async search() {
          throw new Error("Unexpected Search call.");
        },
        async fetch() {
          deepSeekCalls += 1;
          return { title: "Example", content: "# Example" };
        },
      },
      fetchImpl: async () => {
        firecrawlCalls += 1;
        return Response.json({ success: false, error: "Payment required." }, { status: 402 });
      },
    });
    servers.push(server);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(new URL("/v2/scrape", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/", formats: ["markdown"] }),
      });
      expect(response.status).toBe(200);
    }

    expect(firecrawlCalls).toBe(1);
    expect(deepSeekCalls).toBe(2);
  });

  it("passes a Firecrawl-owned crawl ID through without using DeepSeek job state", async () => {
    let upstreamUrl = "";
    const server = await startGatewayServer({
      config: testConfig(),
      env: { FIRECRAWL_API_KEY: "fc-test" },
      deepseekClient: {
        async search() {
          throw new Error("Unexpected Search call.");
        },
        async fetch() {
          throw new Error("Unexpected Fetch call.");
        },
      },
      fetchImpl: async (input) => {
        upstreamUrl = String(input);
        return Response.json({
          status: "scraping",
          completed: 1,
          total: 3,
          creditsUsed: 1,
          data: [],
        });
      },
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/crawl/fc_remote", server.url));

    expect(response.status).toBe(200);
    expect(upstreamUrl).toBe("https://api.firecrawl.dev/v2/crawl/fc_remote");
  });

  it("returns 404 for an unknown local crawl job", async () => {
    const server = await startGatewayServer({
      config: testConfig(),
      env: {},
      fetchImpl: async () => {
        throw new Error("Unexpected Firecrawl request.");
      },
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/crawl/dsc_missing", server.url));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  it("returns a Firecrawl-shaped 400 for malformed fallback JSON", async () => {
    const server = await startGatewayServer({
      config: testConfig(),
      env: {},
      deepseekClient: {
        async search() {
          throw new Error("Unexpected Search call.");
        },
        async fetch() {
          throw new Error("Unexpected Fetch call.");
        },
      },
      fetchImpl: async () => {
        throw new Error("Unexpected Firecrawl request.");
      },
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/search", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });

  it("rejects fallback features that DeepSeek cannot reproduce", async () => {
    const server = await startGatewayServer({
      config: testConfig(),
      env: {},
      deepseekClient: {
        async search() {
          throw new Error("Unexpected Search call.");
        },
        async fetch() {
          throw new Error("Unexpected Fetch call.");
        },
      },
      fetchImpl: async () => {
        throw new Error("Unexpected Firecrawl request.");
      },
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/scrape", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/",
        formats: ["screenshot"],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "unsupported_fallback_feature",
    });
  });

  it("rejects inbound bodies above the configured gateway limit", async () => {
    let upstreamCalls = 0;
    const server = await startGatewayServer({
      config: { ...testConfig(), requestBodyLimit: 8 },
      env: { FIRECRAWL_API_KEY: "fc-test" },
      fetchImpl: async () => {
        upstreamCalls += 1;
        return Response.json({ success: true });
      },
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/search", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"query":"too large"}',
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "request_too_large" });
    expect(upstreamCalls).toBe(0);
  });
});
