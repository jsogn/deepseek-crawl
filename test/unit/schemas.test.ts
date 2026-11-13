import { describe, expect, it } from "vitest";
import { fetchInputSchema, searchInputSchema } from "../../src/deepseek/schemas.js";

describe("searchInputSchema", () => {
  it("applies defaults", () => {
    expect(searchInputSchema.parse({ query: "hello" })).toEqual({
      query: "hello",
      count: 10,
      need_content: false,
    });
  });

  it.each([
    {},
    { query: " " },
    { query: "x".repeat(129) },
    { query: "x", count: 0 },
    { query: "x", count: 51 },
    { query: "x", count: 1.5 },
    { query: "x", localization: "not-an-ip" },
  ])("rejects invalid input %#", (input) => {
    expect(() => searchInputSchema.parse(input)).toThrow();
  });

  it("accepts IPv4 and IPv6 localization", () => {
    expect(searchInputSchema.parse({ query: "x", localization: "203.0.113.7" }).localization).toBe(
      "203.0.113.7",
    );
    expect(searchInputSchema.parse({ query: "x", localization: "2001:db8::1" }).localization).toBe(
      "2001:db8::1",
    );
  });
});

describe("fetchInputSchema", () => {
  it.each(["file:///etc/passwd", "https://user:pass@example.com", "not a url"])(
    "rejects %s",
    (url) => {
      expect(() => fetchInputSchema.parse({ url })).toThrow();
    },
  );

  it("accepts an HTTP URL", () => {
    expect(fetchInputSchema.parse({ url: "https://example.com/a?b=1" }).url).toBe(
      "https://example.com/a?b=1",
    );
  });
});
