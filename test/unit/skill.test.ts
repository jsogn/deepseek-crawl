import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../skills/deepseek-crawl/", import.meta.url);

describe("deepseek-crawl skill", () => {
  it("has valid identity, CLI routing, and an existing reference", async () => {
    const skill = await readFile(new URL("SKILL.md", root), "utf8");
    expect(skill).toMatch(/^---\s*\nname: deepseek-crawl/m);
    expect(skill).toMatch(/description:/);
    expect(skill).toContain("deepseek-crawl doctor --json");
    expect(skill).toContain("references/cli-reference.md");
    expect(skill).toMatch(/MCP is optional/i);
    await expect(
      readFile(new URL("references/cli-reference.md", root), "utf8"),
    ).resolves.toBeTruthy();
  });

  it("defines UI metadata with automatic invocation", async () => {
    const metadata = await readFile(new URL("agents/openai.yaml", root), "utf8");
    expect(metadata).toContain('display_name: "DeepSeek Crawl"');
    expect(metadata).toContain("allow_implicit_invocation: true");
  });
});
