import { lstat, mkdir, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseSkillAgents,
  resolveSkillTargets,
  setupSkills,
} from "../../src/setup/skills.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-setup-"));
  const source = join(root, "package", "skills", "deepseek-crawl");
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(join(source, "references"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "# DeepSeek Crawl\n", "utf8");
  await writeFile(join(source, "references", "cli-reference.md"), "# CLI\n", "utf8");
  return { root, source, home, cwd };
}

describe("parseSkillAgents", () => {
  it("defaults to the universal agents directory", () => {
    expect(parseSkillAgents()).toEqual(["agents"]);
  });

  it("parses selected agents and all in canonical order", () => {
    expect(parseSkillAgents("cursor,codex,agents")).toEqual(["agents", "codex", "cursor"]);
    expect(parseSkillAgents("all")).toEqual(["agents", "codex", "claude-code", "cursor"]);
  });

  it.each(["", "  ", "codex,unknown"])("rejects invalid agent input %s", (value) => {
    expect(() => parseSkillAgents(value)).toThrow(/agent/i);
  });
});

describe("resolveSkillTargets", () => {
  it("resolves global Agent paths and honors CODEX_HOME", () => {
    expect(
      resolveSkillTargets({
        agents: ["agents", "codex", "claude-code", "cursor"],
        scope: "global",
        home: "/Users/test",
        cwd: "/repo",
        env: { CODEX_HOME: "/custom/codex" },
      }),
    ).toEqual([
      {
        agents: ["agents"],
        path: "/Users/test/.agents/skills/deepseek-crawl",
      },
      {
        agents: ["codex"],
        path: "/custom/codex/skills/deepseek-crawl",
      },
      {
        agents: ["claude-code"],
        path: "/Users/test/.claude/skills/deepseek-crawl",
      },
      {
        agents: ["cursor"],
        path: "/Users/test/.cursor/skills/deepseek-crawl",
      },
    ]);
  });

  it("falls back to ~/.codex and groups shared project paths", () => {
    expect(
      resolveSkillTargets({
        agents: ["agents", "codex", "claude-code", "cursor"],
        scope: "project",
        home: "/Users/test",
        cwd: "/repo",
        env: {},
      }),
    ).toEqual([
      {
        agents: ["agents", "codex", "cursor"],
        path: "/repo/.agents/skills/deepseek-crawl",
      },
      {
        agents: ["claude-code"],
        path: "/repo/.claude/skills/deepseek-crawl",
      },
    ]);
  });
});

describe("setupSkills", () => {
  it("installs an idempotent absolute symlink by default", async () => {
    const { source, home, cwd } = await fixture();
    const options = {
      agents: ["agents" as const],
      scope: "global" as const,
      home,
      cwd,
      env: {},
      source,
    };

    const first = await setupSkills(options);
    const target = join(home, ".agents", "skills", "deepseek-crawl");
    expect(first.installs).toEqual([
      {
        agents: ["agents"],
        path: target,
        status: "installed",
        mode: "symlink",
      },
    ]);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readlink(target)).toBe(source);

    const second = await setupSkills(options);
    expect(second.installs[0]?.status).toBe("unchanged");
  });

  it("copies the complete Skill when requested", async () => {
    const { source, home, cwd } = await fixture();
    const result = await setupSkills({
      agents: ["codex"],
      scope: "global",
      home,
      cwd,
      env: {},
      source,
      copy: true,
    });
    const target = join(home, ".codex", "skills", "deepseek-crawl");

    expect(result.mode).toBe("copy");
    expect(result.installs[0]?.mode).toBe("copy");
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("# DeepSeek Crawl\n");
    expect(await readFile(join(target, "references", "cli-reference.md"), "utf8")).toBe("# CLI\n");
  });

  it("requires force before replacing an existing destination", async () => {
    const { source, home, cwd } = await fixture();
    const target = join(home, ".agents", "skills", "deepseek-crawl");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "keep", "utf8");

    await expect(
      setupSkills({
        agents: ["agents"],
        scope: "global",
        home,
        cwd,
        env: {},
        source,
      }),
    ).rejects.toThrow(/force/i);
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("keep");

    const replaced = await setupSkills({
      agents: ["agents"],
      scope: "global",
      home,
      cwd,
      env: {},
      source,
      force: true,
    });
    expect(replaced.installs[0]?.status).toBe("replaced");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });

  it("installs the project universal path and fails before creating targets when source is missing", async () => {
    const { source, home, cwd } = await fixture();
    const project = await setupSkills({
      agents: ["agents"],
      scope: "project",
      home,
      cwd,
      env: {},
      source,
    });
    expect(project.installs[0]?.path).toBe(join(cwd, ".agents", "skills", "deepseek-crawl"));

    const missingHome = join(cwd, "missing-home");
    await expect(
      setupSkills({
        agents: ["agents"],
        scope: "global",
        home: missingHome,
        cwd,
        env: {},
        source: join(cwd, "missing-source"),
      }),
    ).rejects.toThrow(/source/i);
    await expect(lstat(join(missingHome, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
