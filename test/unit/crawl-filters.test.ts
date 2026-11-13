import { describe, expect, it } from "vitest";
import {
  canonicalizeCrawlUrl,
  createCrawlPathFilter,
} from "../../src/crawl/filters.js";

describe("createCrawlPathFilter", () => {
  it("uses prefix matching with path segment boundaries", () => {
    const filter = createCrawlPathFilter(["/docs"], []);
    expect(filter(new URL("https://example.com/docs"))).toBe(true);
    expect(filter(new URL("https://example.com/docs/start"))).toBe(true);
    expect(filter(new URL("https://example.com/docs-extra"))).toBe(false);
  });

  it("supports wildcard include patterns and exclude precedence", () => {
    const filter = createCrawlPathFilter(["/docs/*", "/api/?"], ["/docs/private/*"]);
    expect(filter(new URL("https://example.com/docs/start"))).toBe(true);
    expect(filter(new URL("https://example.com/api/v"))).toBe(true);
    expect(filter(new URL("https://example.com/api/v2"))).toBe(false);
    expect(filter(new URL("https://example.com/docs/private/key"))).toBe(false);
    expect(filter(new URL("https://example.com/blog"))).toBe(false);
  });

  it("requires at least one include and rejects empty patterns", () => {
    expect(createCrawlPathFilter([], [])(new URL("https://example.com/anything"))).toBe(true);
    expect(() => createCrawlPathFilter([""], [])).toThrow(/include/i);
    expect(() => createCrawlPathFilter([], [" "])).toThrow(/exclude/i);
  });
});

describe("canonicalizeCrawlUrl", () => {
  it("normalizes fragments and optionally removes query parameters", () => {
    expect(
      canonicalizeCrawlUrl("https://example.com/page?q=1#section")?.href,
    ).toBe("https://example.com/page?q=1");
    expect(
      canonicalizeCrawlUrl("https://example.com/page?q=1#section", undefined, true)?.href,
    ).toBe("https://example.com/page");
  });

  it("rejects non-HTTP and credential URLs", () => {
    expect(canonicalizeCrawlUrl("file:///etc/passwd")).toBeUndefined();
    expect(canonicalizeCrawlUrl("https://user:pass@example.com/")).toBeUndefined();
  });
});
