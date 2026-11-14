import { describe, expect, it } from "vitest";
import type { DeepSeekGateway } from "../../src/deepseek/gateway.js";
import {
  firecrawlMapFallback,
  firecrawlScrapeFallback,
  firecrawlSearchFallback,
} from "../../src/firecrawl/compat.js";

function gateway(): DeepSeekGateway {
  return {
    async search() {
      return {
        results: [
          {
            rerank_score: 1,
            title: "Result",
            url: "https://example.com/result",
            snippet: "Snippet",
            summary: "Summary",
            content: "# Result",
            site_name: "Example",
            site_icon: null,
            date: null,
            authority: 1,
          },
        ],
      };
    },
    async fetch() {
      return {
        title: "Example",
        content: "# Example",
      };
    },
  };
}

describe("Firecrawl DeepSeek compatibility", () => {
  it("maps DeepSeek Search results into Firecrawl web results", async () => {
    await expect(
      firecrawlSearchFallback(
        {
          query: "DeepSeek",
          limit: 1,
          scrapeOptions: { formats: ["markdown"] },
        },
        gateway(),
      ),
    ).resolves.toEqual({
      success: true,
      data: {
        web: [
          {
            title: "Result",
            description: "Snippet",
            url: "https://example.com/result",
            markdown: "# Result",
            metadata: {
              title: "Result",
              description: "Snippet",
              sourceURL: "https://example.com/result",
              url: "https://example.com/result",
            },
          },
        ],
      },
      creditsUsed: 0,
    });
  });

  it("maps DeepSeek Fetch into a Firecrawl document", async () => {
    await expect(
      firecrawlScrapeFallback(
        {
          url: "https://example.com/",
          formats: ["markdown"],
        },
        gateway(),
      ),
    ).resolves.toEqual({
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
  });

  it("rejects Firecrawl output formats that DeepSeek cannot provide", async () => {
    await expect(
      firecrawlScrapeFallback(
        {
          url: "https://example.com/",
          formats: ["screenshot"],
        },
        gateway(),
      ),
    ).rejects.toMatchObject({
      code: "unsupported_fallback_feature",
    });
  });

  it("maps DeepSeek Map links into the Firecrawl Map response", async () => {
    const reader = {
      async read() {
        return {
          entries: [
            { url: new URL("https://example.com/docs") },
            { url: new URL("https://example.com/guide") },
          ],
          warnings: [],
          truncated: false,
        };
      },
    };

    await expect(
      firecrawlMapFallback(
        {
          url: "https://example.com/",
          search: "docs",
          limit: 2,
        },
        gateway(),
        reader,
      ),
    ).resolves.toEqual({
      success: true,
      links: [{ url: "https://example.com/docs" }],
    });
  });
});
