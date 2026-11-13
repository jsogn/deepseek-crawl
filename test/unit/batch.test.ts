import { describe, expect, it, vi } from "vitest";
import {
  executeBatchFetch,
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
    expect(
      parseBatchFetchInput(" https://example.com/a\n\nhttps://example.com/b \n"),
    ).toEqual(["https://example.com/a", "https://example.com/b"]);
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
