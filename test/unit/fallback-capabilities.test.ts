import { describe, expect, it } from "vitest";
import {
  collectUnsupportedFormats,
  collectUnsupportedKeys,
  collectUnsupportedSources,
  throwForUnsupportedOptions,
} from "../../src/firecrawl/fallback-capabilities.js";

describe("Firecrawl fallback capability guards", () => {
  it("collects unsupported keys in deterministic order", () => {
    expect(
      collectUnsupportedKeys({ zeta: true, actions: [], url: "https://example.com/" }, ["url"]),
    ).toEqual(["actions", "zeta"]);
    expect(
      collectUnsupportedKeys(
        { onlyMainContent: true, formats: ["markdown"] },
        ["formats"],
        "scrapeOptions",
      ),
    ).toEqual(["scrapeOptions.onlyMainContent"]);
  });

  it("rejects non-Markdown formats and extra format keys", () => {
    expect(
      collectUnsupportedFormats(
        ["screenshot", { type: "json", schema: {} }, { type: "markdown", extra: true }],
        "formats",
      ),
    ).toEqual(["formats[0]", "formats[1].schema", "formats[1].type", "formats[2].extra"]);
  });

  it("rejects non-web sources and extra source keys", () => {
    expect(
      collectUnsupportedSources(
        ["news", { type: "web" }, { type: "web", categories: ["docs"] }],
        "sources",
      ),
    ).toEqual(["sources[0]", "sources[2].categories"]);
  });

  it("throws one deterministic unsupported-option error", () => {
    expect(() =>
      throwForUnsupportedOptions(["scrapeOptions.actions", "actions", "actions"]),
    ).toThrow("DeepSeek fallback does not support Firecrawl option `actions`.");
    expect(() => throwForUnsupportedOptions([])).not.toThrow();
  });
});
