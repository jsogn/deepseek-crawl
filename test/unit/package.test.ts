import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("package executable", () => {
  it("prints the package version", () => {
    const result = spawnSync(process.execPath, ["dist/bin.js", "--version"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
    expect(result.stderr).toBe("");
  });
});
