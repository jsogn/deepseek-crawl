import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { DeepSeekGateway } from "../../src/deepseek/gateway.js";
import { CrawlJobManager } from "../../src/gateway/crawl-jobs.js";
import { type GatewayServer, startGatewayServer } from "../../src/gateway/server.js";

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

  it("requires the gateway token and keeps it out of Firecrawl upstream auth", async () => {
    let upstreamAuthorization: string | null = null;
    const server = await startGatewayServer({
      config: {
        ...testConfig(),
        gatewayApiKey: "gateway-token",
      },
      env: {
        FIRECRAWL_API_KEY: "fc-upstream",
        GATEWAY_API_KEY: "gateway-token",
      },
      fetchImpl: async (_input, init) => {
        upstreamAuthorization = new Headers(init?.headers).get("authorization");
        return Response.json({ success: true, data: { markdown: "# Example" } });
      },
    });
    servers.push(server);

    const unauthorized = await fetch(new URL("/v2/scrape", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/" }),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe(
      'Bearer realm="deepseek-crawl-gateway"',
    );
    expect(await unauthorized.json()).toMatchObject({ code: "unauthorized" });
    expect(upstreamAuthorization).toBeNull();

    const wrongToken = await fetch(new URL("/v2/scrape", server.url), {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com/" }),
    });
    expect(wrongToken.status).toBe(401);
    expect(upstreamAuthorization).toBeNull();

    const authorized = await fetch(new URL("/v2/scrape", server.url), {
      method: "POST",
      headers: {
        Authorization: "Bearer gateway-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com/" }),
    });
    expect(authorized.status).toBe(200);
    expect(upstreamAuthorization).toBe("Bearer fc-upstream");
  });

  it("streams upstream response bytes before the upstream response completes", async () => {
    let releaseUpstream: () => void = () => undefined;
    const upstreamCanFinish = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstream = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the request before streaming the response.
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"success":true,');
      await upstreamCanFinish;
      response.end('"data":{"markdown":"# Example"}}');
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    servers.push(upstream);
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("Streaming upstream did not expose a TCP address.");
    }
    const gateway = await startGatewayServer({
      config: {
        ...testConfig(),
        upstreamUrl: new URL(`http://127.0.0.1:${address.port}/`),
      },
      env: { FIRECRAWL_API_KEY: "fc-test" },
      fetchImpl: fetch,
    });
    servers.push(gateway);

    const firstChunk = (async () => {
      const response = await fetch(new URL("/v2/scrape", gateway.url), {
        method: "POST",
        headers: {
          Authorization: "Bearer fc-test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/" }),
      });
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Gateway response did not expose a body.");
      }
      return { reader, chunk: await reader.read() };
    })();
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("Gateway buffered the upstream response.")), 500);
    });

    const { reader, chunk } = await Promise.race([firstChunk, timeout]).finally(releaseUpstream);
    expect(chunk.done).toBe(false);
    const decoder = new TextDecoder();
    let body = chunk.value ? decoder.decode(chunk.value, { stream: true }) : "";

    releaseUpstream();
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
    expect(JSON.parse(body)).toEqual({
      success: true,
      data: { markdown: "# Example" },
    });
  });

  it("cancels active DeepSeek crawl jobs when the gateway closes", async () => {
    const crawlJobs = new CrawlJobManager({ idFactory: () => "dsc_close" });
    const server = await startGatewayServer({
      config: testConfig(),
      env: {},
      crawlJobs,
      deepseekClient: {
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
      },
      fetchImpl: async () => {
        throw new Error("Unexpected Firecrawl request.");
      },
    });

    const response = await fetch(new URL("/v2/crawl", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/",
        limit: 1,
        maxDiscoveryDepth: 0,
        sitemap: "skip",
      }),
    });
    expect(response.status).toBe(200);
    expect(crawlJobs.status("dsc_close")?.status).toBe("scraping");

    await server.close();

    expect(crawlJobs.status("dsc_close")?.status).toBe("cancelled");
    await crawlJobs.waitForIdle("dsc_close");
  });

  it("automatically moves to the next available local port", async () => {
    const blocker = createServer((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    servers.push(blocker);
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("Port blocker did not expose a TCP address.");
    }

    const gateway = await startGatewayServer({
      config: {
        ...testConfig(),
        port: address.port,
        autoPort: true,
      },
      env: {},
      fetchImpl: async () => {
        throw new Error("Unexpected Firecrawl request.");
      },
    });
    servers.push(gateway);

    expect(Number(gateway.url.port)).toBeGreaterThan(address.port);
  });

  it("keeps an explicit port strict when it is occupied", async () => {
    const blocker = createServer((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    servers.push(blocker);
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("Port blocker did not expose a TCP address.");
    }

    await expect(
      startGatewayServer({
        config: {
          ...testConfig(),
          port: address.port,
          autoPort: false,
        },
        env: {},
        fetchImpl: async () => {
          throw new Error("Unexpected Firecrawl request.");
        },
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
