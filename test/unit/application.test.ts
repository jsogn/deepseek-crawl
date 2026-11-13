import { describe, expect, it, vi } from "vitest";
import { executeFetch, executeSearch } from "../../src/application/index.js";

const result = {
  rerank_score: 2.4,
  title: "Result",
  url: "https://example.com/result",
  snippet: "Short",
  summary: "Longer",
  content: "123456",
  site_name: "Example",
  site_icon: null,
  date: null,
  authority: 3,
  extra: "preserved",
};

function gateway() {
  return {
    search: vi.fn(async () => ({ results: [result], top_extra: true })),
    fetch: vi.fn(async () => ({ title: "Page", content: "abcdef", page_extra: true })),
  };
}

describe("executeSearch", () => {
  it("validates input before calling the client", async () => {
    const client = gateway();
    await expect(executeSearch(client, { query: "" }, { maxContentChars: 4 })).rejects.toThrow();
    expect(client.search).not.toHaveBeenCalled();
  });

  it("preserves unknown fields and bounds content", async () => {
    const client = gateway();
    const output = await executeSearch(client, { query: "test" }, { maxContentChars: 4 });
    expect(output).toMatchObject({ top_extra: true });
    expect(output.results[0]).toMatchObject({
      content: "1234",
      content_truncated: true,
      content_original_length: 6,
      extra: "preserved",
    });
    expect(client.search).toHaveBeenCalledWith(
      { query: "test", count: 10, need_content: false },
      undefined,
    );
  });

  it("returns empty results without error", async () => {
    const client = { ...gateway(), search: vi.fn(async () => ({ results: [] })) };
    await expect(executeSearch(client, { query: "test" }, { maxContentChars: 4 })).resolves.toEqual(
      { results: [] },
    );
  });
});

describe("executeFetch", () => {
  it("validates input before calling the client", async () => {
    const client = gateway();
    await expect(
      executeFetch(client, { url: "file:///etc/passwd" }, { maxChars: 4 }),
    ).rejects.toThrow();
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("adds the source URL and bounds content", async () => {
    const client = gateway();
    const output = await executeFetch(client, { url: "https://example.com/page" }, { maxChars: 4 });
    expect(output).toEqual({
      title: "Page",
      url: "https://example.com/page",
      content: "abcd",
      page_extra: true,
      truncated: true,
      original_length: 6,
    });
  });
});
