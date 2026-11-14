import { describe, expect, it } from "vitest";
import { packageName } from "../src/index.js";
import { packageVersion } from "../src/version.js";

describe("package", () => {
  it("uses the public package identity", () => {
    expect(packageName).toBe("deepseek-crawl");
    expect(packageVersion).toBe("0.12.0");
  });
});
