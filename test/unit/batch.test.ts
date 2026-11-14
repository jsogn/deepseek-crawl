import { describe, expect, it, vi } from "vitest";
import {
  executeBatchFetch,
  executeBatchFetchPrepared,
  executeBatchFetchRetry,
  parseBatchFetchInput,
  prepareBatchFetch,
} from "../../src/application/batch.js";
import { DeepSeekError } from "../../src/deepseek/errors.js";

const now = () => new Date("2026-11-14T01:00:00.000Z");
const options = {
  concurrency: 2,
  delayMs: 0,
  maxChars: 1000,
  now,
};

describe("parseBatchFetchInput", () => {
  it("reads Map results, string arrays, object arrays, and newline lists", () => {
    expect(parseBatchFetchInput('{"urls":[{"url":"https://example.com/a"}]}')).toEqual([
      "https://example.com/a",
    ]);
    expect(parseBatchFetchInput('["https://example.com/a","https://example.com/b"]')).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(parseBatchFetchInput('[{"url":"https://example.com/a"}]')).toEqual([
      "https://example.com/a",
    ]);
    expect(parseBatchFetchInput(" https://example.com/a\n\nhttps://example.com/b \n")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it.each(["", "[]", '{"urls":[]}', '{"wrong":true}'])(
    "rejects empty or unsupported input %s",
    (input) => {
      expect(() => parseBatchFetchInput(input)).toThrow(/input|URL/i);
    },
  );

  it("rejects string input over the 8 MiB boundary", () => {
    expect(() => parseBatchFetchInput("x".repeat(8 * 1024 * 1024 + 1))).toThrow(/8 MiB/i);
  });
});

describe("executeBatchFetch", () => {
  it("resumes only pending requests and merges completed state", async () => {
    const prepared = prepareBatchFetch({
      urls: [
        { url: "https://example.com/a" },
        { url: "https://example.com/b" },
        { url: "https://example.com/c" },
        { url: "file:///etc/passwd" },
      ],
    });
    const fetch = vi.fn(async ({ url }: { url: string }) => ({
      title: url,
      content: `body:${url}`,
    }));
    const written: number[] = [];
    const recordedFailures: string[] = [];

    const result = await executeBatchFetchPrepared(
      { search: vi.fn(), fetch },
      {
        ...prepared,
        requests: prepared.requests.filter((request) => request.index === 3),
      },
      "resume.json",
      options,
      async (page) => {
        written.push(page.index);
      },
      undefined,
      {
        uniqueCount: prepared.requests.length,
        initialPages: [
          {
            index: 1,
            url: "https://example.com/a",
            title: "A",
            content_length: 6,
            content_hash: "a".repeat(64),
            content_truncated: false,
          },
        ],
        initialFailures: [
          ...prepared.failures,
          {
            index: 2,
            url: "https://example.com/b",
            kind: "timeout",
            message: "timed out",
          },
        ],
        onFailure: async (failure) => {
          recordedFailures.push(failure.url);
        },
      },
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith({ url: "https://example.com/c" }, expect.any(AbortSignal));
    expect(written).toEqual([3]);
    expect(recordedFailures).toEqual([]);
    expect(result).toMatchObject({
      stats: { input: 4, unique: 3, fetched: 2, failed: 2 },
      pages: [
        { index: 1, url: "https://example.com/a" },
        { index: 3, url: "https://example.com/c" },
      ],
      failures: [
        { index: 2, url: "https://example.com/b", kind: "timeout" },
        { index: 4, url: "file:///etc/passwd", kind: "invalid_url" },
      ],
    });
  });

  it("records a provider failure through the job callback", async () => {
    const prepared = prepareBatchFetch("https://example.com/fail");
    const recordedFailures: string[] = [];
    const result = await executeBatchFetchPrepared(
      {
        search: vi.fn(),
        fetch: vi.fn(async () => Promise.reject(new Error("down"))),
      },
      prepared,
      "job",
      options,
      async () => undefined,
      undefined,
      {
        onFailure: async (failure) => {
          recordedFailures.push(`${failure.index}:${failure.kind}:${failure.message}`);
        },
      },
    );

    expect(recordedFailures).toEqual(["1:fetch:down"]);
    expect(result.failures).toEqual([
      {
        index: 1,
        url: "https://example.com/fail",
        kind: "fetch",
        message: "down",
      },
    ]);
  });

  it("rejects more than 10,000 input entries before making requests", async () => {
    const fetch = vi.fn();
    const input = Array.from({ length: 10_001 }, (_, index) => `https://example.com/${index}`);

    await expect(
      executeBatchFetch({ search: vi.fn(), fetch }, input, "bench", options, async () => undefined),
    ).rejects.toThrow(/10,?000/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deduplicates, records invalid and failed URLs, and preserves indexes", async () => {
    const pages = new Map<number, string>();
    const fetch = vi.fn(async ({ url }: { url: string }) => {
      if (url === "https://example.com/fail") {
        throw new DeepSeekError("missing", { kind: "not_found" });
      }
      return { title: url, content: `content:${url}` };
    });
    const result = await executeBatchFetch(
      { search: vi.fn(), fetch },
      {
        urls: [
          { url: "https://example.com/b#fragment" },
          { url: "https://example.com/a" },
          { url: "https://example.com/b" },
          { url: "file:///etc/passwd" },
          { url: "https://example.com/fail" },
        ],
      },
      "map.json",
      options,
      async (page) => {
        pages.set(page.index, page.url);
      },
    );

    expect(fetch).toHaveBeenCalledTimes(3);
    expect([...pages.entries()]).toEqual([
      [1, "https://example.com/b"],
      [2, "https://example.com/a"],
    ]);
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/b",
      "https://example.com/a",
    ]);
    expect(result.failures).toEqual([
      expect.objectContaining({ url: "https://example.com/fail", kind: "not_found" }),
      expect.objectContaining({ url: "file:///etc/passwd", kind: "invalid_url" }),
    ]);
    expect(result.stats).toEqual({
      input: 5,
      unique: 3,
      fetched: 2,
      failed: 2,
    });
  });

  it("bounds page content and returns a result when every page fails", async () => {
    const gateway = {
      search: vi.fn(),
      fetch: vi.fn(async () => Promise.reject(new Error("down"))),
    };
    const result = await executeBatchFetch(
      gateway,
      "https://example.com/a\nhttps://example.com/b",
      "stdin",
      options,
      async () => undefined,
    );

    expect(result.pages).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.stats.failed).toBe(2);

    const success = await executeBatchFetch(
      { search: vi.fn(), fetch: vi.fn(async () => ({ title: "T", content: "abcdef" })) },
      "https://example.com/a",
      "stdin",
      { ...options, maxChars: 4 },
      async () => undefined,
    );
    expect(success.pages[0]).toMatchObject({
      content_length: 4,
      content_truncated: true,
      content_original_length: 6,
    });
  });
});

describe("executeBatchFetchRetry", () => {
  it("rejects more than 10,000 failures before making requests", async () => {
    const fetch = vi.fn();
    const failures = Array.from({ length: 10_001 }, (_, index) => ({
      index: index + 1,
      url: `https://example.com/${index}`,
      kind: "timeout",
      message: "timed out",
    }));

    await expect(
      executeBatchFetchRetry(
        { search: vi.fn(), fetch },
        { version: 1, source: "map.json", failures },
        "fetch.json",
        options,
        async () => undefined,
      ),
    ).rejects.toThrow(/10,?000/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries only failed URLs, preserves indexes, and records skipped failures", async () => {
    const pages: Array<{ index: number; url: string; retryOf?: unknown }> = [];
    const fetch = vi.fn(async ({ url }: { url: string }) => ({
      title: url,
      content: `retried:${url}`,
    }));
    const report = {
      version: 1,
      source: "map.json",
      failures: [
        {
          index: 2,
          url: "https://example.com/fail",
          kind: "timeout",
          message: "request timed out",
        },
        {
          index: 2,
          url: "https://example.com/fail",
          kind: "timeout",
          message: "request timed out again",
        },
        {
          index: 3,
          url: "file:///etc/passwd",
          kind: "invalid_url",
          message: "not HTTP(S)",
        },
      ],
    };

    const result = await executeBatchFetchRetry(
      { search: vi.fn(), fetch },
      report,
      "fetch.json",
      options,
      async (page) => {
        pages.push({
          index: page.index,
          url: page.url,
          retryOf: page.retryOf,
        });
      },
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      { url: "https://example.com/fail" },
      expect.any(AbortSignal),
    );
    expect(pages).toEqual([
      {
        index: 2,
        url: "https://example.com/fail",
        retryOf: {
          index: 2,
          url: "https://example.com/fail",
          kind: "timeout",
          message: "request timed out",
        },
      },
    ]);
    expect(result).toMatchObject({
      version: 1,
      source: "fetch.json [retry-failed]",
      retry_of: {
        source: "fetch.json",
        original_failures: 3,
        attempted: 1,
        deduplicated: 1,
        skipped: [
          {
            index: 3,
            url: "file:///etc/passwd",
            kind: "invalid_url",
            message: "not HTTP(S)",
          },
        ],
      },
      stats: {
        input: 3,
        unique: 1,
        fetched: 1,
        failed: 0,
      },
      pages: [
        {
          index: 2,
          url: "https://example.com/fail",
          retry_of: {
            index: 2,
            url: "https://example.com/fail",
            kind: "timeout",
            message: "request timed out",
          },
        },
      ],
      failures: [],
    });
  });

  it("records both the current and previous failure when a retry fails again", async () => {
    const result = await executeBatchFetchRetry(
      {
        search: vi.fn(),
        fetch: vi.fn(async () =>
          Promise.reject(new DeepSeekError("rate limited", { kind: "rate_limit" })),
        ),
      },
      {
        version: 1,
        source: "map.json",
        failures: [
          {
            index: 4,
            url: "https://example.com/busy",
            kind: "timeout",
            message: "timed out",
          },
        ],
      },
      "fetch.json",
      options,
      async () => undefined,
    );

    expect(result.pages).toEqual([]);
    expect(result.failures).toEqual([
      {
        url: "https://example.com/busy",
        index: 4,
        kind: "rate_limit",
        message: "rate limited",
        retry_of: {
          index: 4,
          url: "https://example.com/busy",
          kind: "timeout",
          message: "timed out",
        },
      },
    ]);
  });

  it("returns an empty successful retry report when there are no failures", async () => {
    const fetch = vi.fn();
    const result = await executeBatchFetchRetry(
      { search: vi.fn(), fetch },
      { version: 1, source: "map.json", failures: [] },
      "fetch.json",
      options,
      async () => undefined,
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      retry_of: {
        original_failures: 0,
        attempted: 0,
        deduplicated: 0,
        skipped: [],
        truncated: false,
      },
      stats: { input: 0, unique: 0, fetched: 0, failed: 0 },
      pages: [],
      failures: [],
    });
  });

  it("stops launching retry requests when page output fails", async () => {
    const fetch = vi.fn(async ({ url }: { url: string }) => ({
      title: url,
      content: "retried",
    }));

    await expect(
      executeBatchFetchRetry(
        { search: vi.fn(), fetch },
        {
          version: 1,
          source: "map.json",
          failures: [
            {
              index: 1,
              url: "https://example.com/a",
              kind: "timeout",
              message: "first",
            },
            {
              index: 2,
              url: "https://example.com/b",
              kind: "timeout",
              message: "second",
            },
          ],
        },
        "fetch.json",
        { ...options, concurrency: 1 },
        async () => {
          throw new Error("write failed");
        },
      ),
    ).rejects.toThrow("write failed");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
