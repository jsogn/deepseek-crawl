import { describe, expect, it } from "vitest";
import { boundFetchOutput, boundSearchOutput, truncateText } from "../../src/output/bounds.js";

describe("truncateText", () => {
  it("does not split Unicode code points", () => {
    expect(truncateText("A😀B", 2)).toEqual({
      value: "A😀",
      truncated: true,
      originalLength: 3,
    });
  });

  it("treats zero as unlimited", () => {
    expect(truncateText("hello", 0)).toEqual({
      value: "hello",
      truncated: false,
      originalLength: 5,
    });
  });

  it("does not mark an exact-length value as truncated", () => {
    expect(truncateText("hello", 5)).toEqual({
      value: "hello",
      truncated: false,
      originalLength: 5,
    });
  });

  it.each([-1, 1.5, 1000001])("rejects an invalid limit %s", (limit) => {
    expect(() => truncateText("hello", limit)).toThrow(/limit/i);
  });
});

describe("boundFetchOutput", () => {
  it("adds truncation metadata", () => {
    expect(
      boundFetchOutput({ title: "T", url: "https://example.com", content: "123456" }, 4),
    ).toEqual({
      title: "T",
      url: "https://example.com",
      content: "1234",
      truncated: true,
      original_length: 6,
    });
  });

  it("preserves unknown fields", () => {
    expect(
      boundFetchOutput(
        { title: "T", url: "https://example.com", content: "x", extra: "kept" },
        10,
      ),
    ).toMatchObject({ extra: "kept" });
  });
});

describe("boundSearchOutput", () => {
  it("bounds each result and reports the total", () => {
    const output = boundSearchOutput(
      {
        results: [
          {
            rerank_score: 2,
            title: "A",
            url: "https://a.example",
            snippet: "s",
            summary: "m",
            content: "123456",
            site_name: null,
            site_icon: null,
            date: null,
            authority: 3,
            extra: true,
          },
        ],
      },
      4,
    );

    expect(output.results[0]).toMatchObject({
      content: "1234",
      content_truncated: true,
      content_original_length: 6,
      extra: true,
    });
    expect(output.truncation).toEqual({ content_limit: 4, truncated_results: 1 });
  });

  it("does not add metadata when nothing is truncated", () => {
    expect(
      boundSearchOutput(
        {
          results: [
            {
              rerank_score: 2,
              title: "A",
              url: "https://a.example",
              snippet: "s",
              summary: "m",
              content: "",
              site_name: null,
              site_icon: null,
              date: null,
              authority: 3,
            },
          ],
        },
        4,
      ).truncation,
    ).toBeUndefined();
  });
});
