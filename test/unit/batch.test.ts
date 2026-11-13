import { describe, expect, it, vi } from "vitest";
import {
  executeBatchFetch,
  executeBatchFetchRetry,
  parseBatchFetchInput,
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
});

describe("executeBatchFetch", () => {
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
      expect.objectContaining({ url: "file:///etc/passwd", kind: "invalid_url" }),
      expect.objectContaining({ url: "https://example.com/fail", kind: "not_found" }),
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
        skipped: [],
        truncated: false,
      },
      stats: { input: 0, unique: 0, fetched: 0, failed: 0 },
      pages: [],
      failures: [],
    });
  });
});
