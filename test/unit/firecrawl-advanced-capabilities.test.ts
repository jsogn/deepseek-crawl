import { describe, expect, it } from "vitest";
import {
  preparePageSiftInteract,
  preparePageSiftScrape,
} from "../../src/firecrawl/advanced-capabilities.js";

describe("PageSift advanced capabilities", () => {
  it("accepts browser Scrape fields and injects keepSession", () => {
    const prepared = preparePageSiftScrape({
      url: "https://example.com/",
      formats: ["markdown", "screenshot"],
      actions: [
        { type: "click", selector: "#more" },
        { type: "wait", milliseconds: 100 },
      ],
      waitFor: 500,
      onlyMainContent: true,
      headers: { "Accept-Language": "en" },
      timeout: 30_000,
      mobile: true,
      blockAds: true,
      origin: "firecrawl-sdk",
    });

    expect(prepared.body).toMatchObject({
      keepSession: true,
      formats: ["markdown", "screenshot"],
      actions: [
        { type: "click", selector: "#more" },
        { type: "wait", milliseconds: 100 },
      ],
    });
    expect(JSON.parse(Buffer.from(prepared.serialized).toString("utf8"))).toEqual(prepared.body);
  });

  it.each([
    [{ url: "https://example.com/", formats: [{ type: "screenshot" }] }, /formats\[0\]/],
    [{ url: "https://example.com/", keepSession: false }, /keepSession/],
    [
      { url: "https://example.com/", actions: [{ type: "executeJavascript" }] },
      /actions\[0\]\.type/,
    ],
    [{ url: "https://example.com/", json: {} }, /json/],
    [{ url: "https://example.com/", profile: "user" }, /profile/],
    [{ url: "https://example.com/", proxy: "auto" }, /proxy/],
  ])("rejects unsupported Scrape input %#", (input, expected) => {
    expect(() => preparePageSiftScrape(input)).toThrow(expected);
  });

  it("accepts prompt and action Interact bodies", () => {
    expect(
      JSON.parse(
        Buffer.from(
          preparePageSiftInteract({
            prompt: "Click More and summarize the page",
            timeout: 10,
            origin: "firecrawl-sdk",
          }),
        ).toString("utf8"),
      ),
    ).toEqual({
      prompt: "Click More and summarize the page",
      timeout: 10,
      origin: "firecrawl-sdk",
    });
    expect(() =>
      preparePageSiftInteract({ actions: [{ type: "scroll", direction: "down" }] }),
    ).not.toThrow();
  });

  it.each([
    [{ code: "await page.title()" }, /code/],
    [{ language: "node" }, /language/],
    [{ url: "https://example.com/" }, /url/],
    [{ actions: [{ type: "executeJavascript" }] }, /actions\[0\]\.type/],
  ])("rejects unsupported Interact input %#", (input, expected) => {
    expect(() => preparePageSiftInteract(input)).toThrow(expected);
  });
});
