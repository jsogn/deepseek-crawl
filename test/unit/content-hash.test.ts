import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/content/hash.js";

describe("contentHash", () => {
  it("produces a stable SHA-256 fingerprint for UTF-8 content", () => {
    expect(contentHash("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(contentHash("你好\n")).toBe(
      "4e0826721642ed8e3a27e7147538ac7b7013a08fe5ae343a8ef09749b7e5790f",
    );
  });

  it("changes when page content changes", () => {
    expect(contentHash("before")).not.toBe(contentHash("after"));
  });
});
