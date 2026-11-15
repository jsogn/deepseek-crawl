import { describe, expect, it } from "vitest";
import {
  type AdvancedBackendError,
  createPageSiftBackend,
  probePageSift,
} from "../../src/gateway/advanced-backend.js";

const config = {
  provider: "pagesift" as const,
  url: new URL("http://127.0.0.1:3002/"),
  apiKey: "pagesift-secret",
};

describe("PageSift backend", () => {
  it("probes health and authenticated active jobs without redirects", async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      redirect: RequestInit["redirect"] | undefined;
    }> = [];
    const status = await probePageSift(config, async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        redirect: init?.redirect,
      });
      return String(input).endsWith("/healthz")
        ? new Response("ok", { status: 200 })
        : Response.json([]);
    });

    expect(status).toEqual({
      enabled: true,
      provider: "pagesift",
      url: "http://127.0.0.1:3002/",
      reachable: true,
      api_ready: true,
      credential_configured: true,
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:3002/healthz",
        authorization: "Bearer pagesift-secret",
        redirect: "manual",
      },
      {
        url: "http://127.0.0.1:3002/v2/crawl/active",
        authorization: "Bearer pagesift-secret",
        redirect: "manual",
      },
    ]);
  });

  it("reports reachable but not API-ready on active-jobs 401", async () => {
    const status = await probePageSift(config, async (input) =>
      String(input).endsWith("/healthz")
        ? new Response("ok")
        : Response.json({ success: false }, { status: 401 }),
    );
    expect(status).toMatchObject({ reachable: true, api_ready: false });
  });

  it("strips inbound authorization and injects only the PageSift key", async () => {
    let authorization: string | null = null;
    const backend = createPageSiftBackend(config, async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ ok: true });
    });
    await backend.request({
      method: "POST",
      path: "/v2/scrape",
      headers: new Headers({ Authorization: "Bearer firecrawl-secret" }),
      body: Buffer.from("{}"),
    });
    expect(authorization).toBe("Bearer pagesift-secret");
  });

  it("reads a bounded scrape JSON response", async () => {
    const backend = createPageSiftBackend(config, async () =>
      Response.json({ success: true, data: { metadata: { scrapeId: "upstream" } } }),
    );
    const response = await backend.request({
      method: "POST",
      path: "/v2/scrape",
      headers: new Headers(),
    });
    await expect(backend.readJsonResponse(response)).resolves.toMatchObject({
      data: { metadata: { scrapeId: "upstream" } },
    });
  });

  it("rejects oversized advanced scrape bodies", async () => {
    const backend = createPageSiftBackend(
      config,
      async () => new Response("x".repeat(16 * 1024 * 1024 + 1)),
    );
    const response = await backend.request({
      method: "POST",
      path: "/v2/scrape",
      headers: new Headers(),
    });
    await expect(backend.readJsonResponse(response)).rejects.toMatchObject({
      code: "advanced_backend_response_too_large",
      statusCode: 502,
    } satisfies Partial<AdvancedBackendError>);
  });

  it("allows four JSON buffers and waits for the fifth", async () => {
    const backend = createPageSiftBackend(config, async () => Response.json({}));
    let started = 0;
    const releases: Array<() => void> = [];
    const blocked = () =>
      ({
        body: {
          getReader() {
            started += 1;
            return new ReadableStream({
              pull(controller) {
                return new Promise<void>((resolve) => {
                  releases.push(() => {
                    controller.enqueue(new TextEncoder().encode("{}"));
                    controller.close();
                    resolve();
                  });
                });
              },
            }).getReader();
          },
        },
      }) as Response;

    const reads = Array.from({ length: 5 }, () => backend.readJsonResponse(blocked()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(4);
    releases.shift()?.();
    while (started < 5) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (const release of releases.splice(0)) {
      release();
    }
    await Promise.all(reads);
  });
});
