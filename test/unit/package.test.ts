import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package executable", () => {
  it("prints the package version", () => {
    const result = spawnSync(process.execPath, ["dist/bin.js", "--version"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.11.0");
    expect(result.stderr).toBe("");
  });

  it("publishes the bundled Agent Skill", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { files?: string[]; description?: string; private?: boolean; license?: string };
    expect(packageJson.files).toContain("skills");
    expect(packageJson.files).toContain("README.en.md");
    expect(packageJson.files).toContain("LICENSE");
    expect(packageJson.description).toMatch(/CLI-first/i);
    expect(packageJson.description).toMatch(/optional MCP/i);
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.license).toBe("MIT");
  });
});

describe("package documentation", () => {
  it("documents every public CLI and MCP capability", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const readmeEnglish = await readFile(new URL("../../README.en.md", import.meta.url), "utf8");
    const allDocumentation = `${readme}\n${readmeEnglish}`;

    expect(readme).toContain("[English](README.en.md)");
    expect(readmeEnglish).toContain("[简体中文](README.md)");

    for (const text of [
      "deepseek-crawl map",
      "deepseek-crawl crawl",
      "deepseek_map",
      "deepseek_crawl",
      "robots.txt",
      "Firecrawl",
      "CLI-first",
      "skills/deepseek-crawl",
      "map <url> [--search <text>]",
      "deepseek-crawl crawl <url> -o <dir>",
      "MCP is optional",
      "deepseek-crawl init",
      "deepseek-crawl setup skills",
      "~/.agents/skills/deepseek-crawl",
      "--agent codex",
      "npx skills add jsogn/deepseek-crawl",
      "deepseek-crawl auth set",
      "deepseek-crawl auth status",
      "deepseek-crawl auth remove",
      "macOS Keychain",
      "DEEPSEEK_API_KEY",
      "fetch --input",
      "--output-dir",
      "--include-paths",
      "--exclude-paths",
      "--ignore-query-parameters",
    ]) {
      expect(allDocumentation).toContain(text);
    }
  });
});
