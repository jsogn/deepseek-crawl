import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package executable", () => {
  it("prints the package version", () => {
    const result = spawnSync(process.execPath, ["dist/bin.js", "--version"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.3.0");
    expect(result.stderr).toBe("");
  });

  it("publishes the bundled Agent Skill", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { files?: string[]; description?: string };
    expect(packageJson.files).toContain("skills");
    expect(packageJson.description).toMatch(/CLI-first/i);
    expect(packageJson.description).toMatch(/optional MCP/i);
  });
});

describe("package documentation", () => {
  it("documents every public CLI and MCP capability", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");

    for (const text of [
      "deepseek-crawl map",
      "deepseek-crawl crawl",
      "deepseek_map",
      "deepseek_crawl",
      "robots.txt",
      "Firecrawl",
    ]) {
      expect(readme).toContain(text);
    }
  });
});
