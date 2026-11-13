import { describe, expect, it } from "vitest";
import { formatFetchHuman, formatSearchHuman } from "../../src/output/format.js";

describe("formatSearchHuman", () => {
  it("renders rank, title, URL, summary, and truncation metadata", () => {
    const output = formatSearchHuman({
      results: [
        {
          rerank_score: 2.4,
          title: "Result",
          url: "https://example.com/result",
          snippet: "Short",
          summary: "Summary",
          content: "Preview",
          site_name: "Example",
          site_icon: null,
          date: null,
          authority: 3,
          content_truncated: true,
          content_original_length: 100,
        },
      ],
    });

    expect(output).toContain("1. Result");
    expect(output).toContain("https://example.com/result");
    expect(output).toContain("Summary");
    expect(output).toContain("Preview");
    expect(output).toContain("truncated from 100 to 7 characters");
    expect(output).not.toContain("null");
  });

  it("handles no results", () => {
    expect(formatSearchHuman({ results: [] })).toBe("No results.");
  });
});

describe("formatFetchHuman", () => {
  it("renders title, source URL, and body", () => {
    expect(
      formatFetchHuman({
        title: "Page",
        url: "https://example.com/page",
        content: "# Body",
      }),
    ).toBe("# Page\n\nSource: https://example.com/page\n\n# Body");
  });

  it("renders truncation metadata", () => {
    const output = formatFetchHuman({
      title: "Page",
      url: "https://example.com/page",
      content: "Short",
      truncated: true,
      original_length: 100,
    });
    expect(output).toContain("truncated from 100 to 5 characters");
  });

  it("reports cache retrieval provenance", () => {
    const output = formatFetchHuman({
      title: "Page",
      url: "https://example.com/page",
      content: "body",
      retrieved_from: "cache",
    });
    expect(output).toContain("Retrieved from: cache");
  });
});
