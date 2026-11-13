import { describe, expect, it } from "vitest";
import {
  extractMarkdownLinks,
  normalizeHttpUrl,
  safePageSlug,
  sameOrigin,
  visitMarkdownLinks,
} from "../../src/crawl/links.js";

const base = new URL("https://example.com/docs/start");

describe("extractMarkdownLinks", () => {
  it("extracts inline, reference, and automatic links", () => {
    const markdown = [
      "[Inline](/a)",
      "[Reference][docs]",
      "https://example.com/bare",
      "",
      "[docs]: /reference",
    ].join("\n");
    expect(extractMarkdownLinks(markdown, base).map(String)).toEqual([
      "https://example.com/a",
      "https://example.com/reference",
      "https://example.com/bare",
    ]);
  });

  it("ignores images, raw HTML, malformed, credentials, and non-HTTP URLs", () => {
    const markdown = [
      "![image](/image.png)",
      '<a href="/html">HTML</a>',
      "[mail](mailto:test@example.com)",
      "[file](file:///etc/passwd)",
      "[credential](https://user:pass@example.com/)",
    ].join("\n");
    expect(extractMarkdownLinks(markdown, base)).toEqual([]);
  });

  it("removes fragments", () => {
    expect(normalizeHttpUrl("/page#part", base)?.href).toBe("https://example.com/page");
  });

  it("streams each normalized link to a caller-provided sink", () => {
    const links: string[] = [];
    visitMarkdownLinks("[A](/a) [A again](/a) [B](/b)", base, (url) => {
      links.push(url.href);
    });
    expect(links).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("can defer deduplication to a bounded consumer", () => {
    const links: string[] = [];
    visitMarkdownLinks(
      "[A](/a) [A again](/a) [B](/b)",
      base,
      (url) => {
        links.push(url.href);
      },
      { dedupe: false },
    );
    expect(links).toEqual([
      "https://example.com/a",
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });
});

describe("sameOrigin and safePageSlug", () => {
  it("uses exact scheme, host, and port", () => {
    expect(sameOrigin(new URL("https://example.com/a"), new URL("https://example.com/b"))).toBe(
      true,
    );
    expect(sameOrigin(new URL("https://example.com"), new URL("http://example.com"))).toBe(false);
  });

  it("creates stable ASCII file slugs", () => {
    expect(safePageSlug(new URL("https://example.com/docs/Hello%20World.html"))).toBe(
      "hello-world",
    );
    expect(safePageSlug(new URL("https://example.com/"))).toBe("page");
  });
});
