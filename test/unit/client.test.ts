import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../../src/deepseek/client.js";
import { DeepSeekError } from "../../src/deepseek/errors.js";

const searchResponse = {
  results: [
    {
      rerank_score: 2.4,
      title: "Result",
      url: "https://example.com/result",
      snippet: "Short",
      summary: "Longer",
      content: "",
      site_name: "Example",
      site_icon: null,
      date: null,
      authority: 3,
    },
  ],
};

function createClient(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof DeepSeekClient>[0]> = {},
) {
  const delays: number[] = [];
  const client = new DeepSeekClient({
    apiKey: "test-key",
    baseUrl: new URL("https://api.deepseek.com/"),
    timeoutMs: 1000,
    maxRetries: 2,
    fetchImpl,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
    random: () => 0.5,
    ...overrides,
  });
  return { client, delays };
}

describe("DeepSeekClient", () => {
  it("posts search input and parses the response", async () => {
    let requestUrl = "";
    let requestOptions: RequestInit | undefined;
    const { client } = createClient(async (url, options) => {
      requestUrl = String(url);
      requestOptions = options;
      return Response.json(searchResponse);
    });

    const result = await client.search({
      query: "DeepSeek",
      count: 3,
      need_content: true,
    });

    expect(result).toEqual(searchResponse);
    expect(requestUrl).toBe("https://api.deepseek.com/v1/tools/search");
    expect(requestOptions?.method).toBe("POST");
    expect(requestOptions?.redirect).toBe("error");
    expect(new Headers(requestOptions?.headers).get("authorization")).toBe("Bearer test-key");
    expect(JSON.parse(String(requestOptions?.body))).toEqual({
      query: "DeepSeek",
      count: 3,
      need_content: true,
    });
  });

  it("posts fetch input and parses the response", async () => {
    const expected = { title: "Page", content: "# Body" };
    let requestUrl = "";
    const { client } = createClient(async (url) => {
      requestUrl = String(url);
      return Response.json(expected);
    });

    expect(await client.fetch({ url: "https://example.com/page" })).toEqual(expected);
    expect(requestUrl).toBe("https://api.deepseek.com/v1/tools/fetch");
  });

  it("rejects Fetch bodies above the configured byte limit", async () => {
    const { client } = createClient(
      async () =>
        new Response(JSON.stringify({ title: "Large", content: "x".repeat(100) }), {
          headers: { "content-type": "application/json" },
        }),
      { fetchResponseByteLimit: 32 },
    );

    await expect(client.fetch({ url: "https://example.com" })).rejects.toMatchObject({
      kind: "resource_limit",
    });
  });

  it("does not apply the Fetch byte limit to Search", async () => {
    const { client } = createClient(async () => Response.json(searchResponse), {
      fetchResponseByteLimit: 1,
    });

    await expect(client.search({ query: "test", count: 1, need_content: false })).resolves.toEqual(
      searchResponse,
    );
  });

  it("clamps an oversized Fetch response byte limit to 8 MiB", async () => {
    const { client } = createClient(
      async () =>
        new Response("", {
          headers: { "content-length": String(8 * 1024 * 1024 + 1) },
          status: 200,
        }),
      { fetchResponseByteLimit: 16 * 1024 * 1024 },
    );

    await expect(client.fetch({ url: "https://example.com" })).rejects.toMatchObject({
      kind: "resource_limit",
    });
  });

  it("rejects a non-positive Fetch response byte limit", () => {
    expect(() =>
      createClient(async () => Response.json({ title: "Page", content: "" }), {
        fetchResponseByteLimit: 0,
      }),
    ).toThrow(/fetchResponseByteLimit/i);
  });

  it.each([408, 429, 500, 502, 503, 504])("retries HTTP %s", async (status) => {
    let calls = 0;
    const { client, delays } = createClient(async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ error: { message: "temporary" } }, { status })
        : Response.json(searchResponse);
    });

    await client.search({ query: "test", count: 1, need_content: false });
    expect(calls).toBe(2);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThan(0);
  });

  it.each([
    [400, "invalid_request"],
    [401, "auth"],
    [402, "balance"],
    [403, "forbidden"],
    [404, "not_found"],
    [413, "invalid_request"],
  ])("does not retry HTTP %s", async (status, kind) => {
    let calls = 0;
    const { client, delays } = createClient(async () => {
      calls += 1;
      return Response.json({ error: { message: "request failed" } }, { status });
    });

    await expect(client.fetch({ url: "https://example.com" })).rejects.toMatchObject({
      kind,
      status,
    });
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("honors Retry-After seconds and caps it at 5000 ms", async () => {
    let calls = 0;
    const { client, delays } = createClient(
      async () => {
        calls += 1;
        return calls === 1
          ? Response.json({ error: {} }, { status: 429, headers: { "retry-after": "10" } })
          : Response.json(searchResponse);
      },
      { random: () => 0 },
    );

    await client.search({ query: "test", count: 1, need_content: false });
    expect(delays).toEqual([5000]);
  });

  it("does not retry caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      if (options?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      throw new Error("unexpected request");
    }) as unknown as typeof fetch;
    const { client, delays } = createClient(fetchImpl);

    await expect(
      client.search({ query: "test", count: 1, need_content: false }, controller.signal),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(delays).toEqual([]);
  });

  it("does not retry local timeout", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;
    const { client, delays } = createClient(fetchImpl, { timeoutMs: 10 });

    await expect(
      client.search({ query: "test", count: 1, need_content: false }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("keeps the timeout active while reading the response body", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, options?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              options?.signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            },
          }),
        ),
    ) as unknown as typeof fetch;
    const { client } = createClient(fetchImpl, { timeoutMs: 10 });

    await expect(
      client.search({ query: "test", count: 1, need_content: false }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the timeout active while reading a bounded Fetch body", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      return new Response(
        new ReadableStream({
          start(controller) {
            options?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          },
        }),
      );
    }) as unknown as typeof fetch;
    const { client } = createClient(fetchImpl, { timeoutMs: 10 });

    await expect(client.fetch({ url: "https://example.com/page" })).rejects.toMatchObject({
      kind: "timeout",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON and schema-invalid success bodies", async () => {
    for (const response of [
      new Response("not json"),
      Response.json({}),
      Response.json({ results: "wrong" }),
    ]) {
      const { client } = createClient(async () => response.clone());
      await expect(
        client.search({ query: "test", count: 1, need_content: false }),
      ).rejects.toMatchObject({ kind: "invalid_response" });
    }
  });

  it("does not include request bodies in errors", async () => {
    const secretQuery = "do-not-echo-this-query";
    const { client } = createClient(async () =>
      Response.json(
        { error: { message: "bad request with a very long internal explanation ".repeat(30) } },
        { status: 400 },
      ),
    );

    try {
      await client.search({ query: secretQuery, count: 1, need_content: false });
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DeepSeekError);
      expect((error as Error).message).not.toContain(secretQuery);
      expect((error as Error).message.length).toBeLessThan(700);
    }
  });

  it("bounds oversized error response bodies and keeps request IDs", async () => {
    const { client } = createClient(
      async () =>
        new Response("x".repeat(100_000), {
          status: 502,
          headers: {
            "content-length": "100000",
            "x-request-id": "request-123",
          },
        }),
      { maxRetries: 0 },
    );

    await expect(client.fetch({ url: "https://example.com" })).rejects.toMatchObject({
      kind: "server",
      status: 502,
      requestId: "request-123",
    });
  });
});
