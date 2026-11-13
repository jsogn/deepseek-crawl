import { describe, expect, it } from "vitest";
import { formatMapUrls, formatMapWarnings } from "../../src/output/map.js";

const result = {
  version: 1 as const,
  seed_url: "https://example.com/",
  generated_at: "2026-11-13T00:00:00.000Z",
  limit: 10,
  total: 2,
  truncated: false,
  urls: [
    { url: "https://example.com/", sources: ["seed_url" as const] },
    { url: "https://example.com/docs", sources: ["seed_page" as const] },
  ],
  warnings: [
    {
      code: "sitemap_unavailable" as const,
      message: "Sitemap missing",
    },
  ],
};

describe("Map output", () => {
  it("formats one URL per line", () => {
    expect(formatMapUrls(result)).toBe("https://example.com/\nhttps://example.com/docs");
  });

  it("formats warnings with stable codes", () => {
    expect(formatMapWarnings(result)).toBe("sitemap_unavailable: Sitemap missing");
  });
});
