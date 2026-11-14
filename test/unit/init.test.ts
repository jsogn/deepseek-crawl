import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/run.js";
import { cliDependencies as dependencies } from "../helpers/cli.js";

describe("deepseek-crawl init", () => {
  it("initializes credentials, Agent Skill, and doctor in one JSON result", async () => {
    const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "deepseek-crawl-project-"));
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("ok", { status: 404 }),
    );
    const secretReader = vi.fn(async () => "unused");
    const { deps, stdout, stderr } = dependencies(fetchImpl as unknown as typeof fetch);

    expect(
      await runCli(["init", "--json"], {
        ...deps,
        setupEnvironment: { home, cwd, env: {}, packageRoot },
        secretReader,
      }),
    ).toBe(0);

    expect(secretReader).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe("GET");
    expect(JSON.parse(stdout.value())).toMatchObject({
      version: 1,
      ok: true,
      auth: {
        configured: true,
        source: "environment",
        changed: false,
        skipped: false,
      },
      skills: {
        scope: "global",
        mode: "symlink",
        installs: [
          {
            agents: ["agents"],
            path: join(home, ".agents", "skills", "deepseek-crawl"),
            status: "installed",
          },
        ],
      },
      doctor: {
        ok: true,
        api_key: "configured",
        credential_source: "environment",
        connectivity: "reachable",
        live: "not_requested",
      },
    });
    expect(stderr.value()).toBe("");
  });

  it("prompts for and stores a missing API key during init", async () => {
    const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "deepseek-crawl-project-"));
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    let storedKey: string | undefined;
    const credentialStore = {
      name: "keychain" as const,
      get: vi.fn(() => storedKey),
      set: vi.fn((value: string) => {
        storedKey = value;
      }),
      remove: vi.fn(),
    };
    const secretReader = vi.fn(async () => "new-key");
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("ok", { status: 404 }),
    );
    const { deps, stdout, stderr } = dependencies(fetchImpl as unknown as typeof fetch, {});

    expect(
      await runCli(["init", "--json"], {
        ...deps,
        credentialStore,
        setupEnvironment: { home, cwd, env: {}, packageRoot },
        secretReader,
      }),
    ).toBe(0);

    expect(secretReader).toHaveBeenCalledOnce();
    expect(credentialStore.set).toHaveBeenCalledWith("new-key");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.value())).toMatchObject({
      ok: true,
      auth: {
        configured: true,
        source: "keychain",
        changed: true,
        skipped: false,
      },
    });
    expect(stdout.value()).not.toContain("new-key");
    expect(stderr.value()).toBe("");
  });

  it("skips authentication and reports a non-billable doctor failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "deepseek-crawl-project-"));
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const credentialStore = {
      name: "keychain" as const,
      get: vi.fn(() => undefined),
      set: vi.fn(),
      remove: vi.fn(),
    };
    const secretReader = vi.fn(async () => "unused");
    const fetchImpl = vi.fn();
    const { deps, stdout, stderr } = dependencies(fetchImpl as unknown as typeof fetch, {});

    expect(
      await runCli(["init", "--skip-auth", "--json"], {
        ...deps,
        credentialStore,
        setupEnvironment: { home, cwd, env: {}, packageRoot },
        secretReader,
      }),
    ).toBe(1);

    expect(secretReader).not.toHaveBeenCalled();
    expect(credentialStore.set).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.value())).toMatchObject({
      ok: false,
      auth: {
        configured: false,
        source: "missing",
        changed: false,
        skipped: true,
      },
      doctor: {
        ok: false,
        api_key: "missing",
        live: "not_requested",
      },
    });
    expect(stderr.value()).toBe("");
  });

  it("skips Agent Skill installation when requested", async () => {
    const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "deepseek-crawl-project-"));
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("ok", { status: 404 }),
    );
    const { deps, stdout } = dependencies(fetchImpl as unknown as typeof fetch);

    expect(
      await runCli(["init", "--skip-skills", "--json"], {
        ...deps,
        setupEnvironment: { home, cwd, env: {}, packageRoot },
      }),
    ).toBe(0);

    const target = join(home, ".agents", "skills", "deepseek-crawl");
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(stdout.value())).toMatchObject({
      ok: true,
      skills: { skipped: true },
    });
  });

  it("installs a selected project Skill with copy and force options", async () => {
    const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "deepseek-crawl-project-"));
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const target = join(cwd, ".agents", "skills", "deepseek-crawl");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "old", "utf8");
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("ok", { status: 404 }),
    );
    const { deps, stdout } = dependencies(fetchImpl as unknown as typeof fetch);

    expect(
      await runCli(["init", "--project", "--agent", "codex", "--copy", "--force", "--json"], {
        ...deps,
        setupEnvironment: { home, cwd, env: {}, packageRoot },
      }),
    ).toBe(0);

    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("name: deepseek-crawl");
    await expect(lstat(join(target, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(stdout.value())).toMatchObject({
      ok: true,
      skills: {
        scope: "project",
        mode: "copy",
        installs: [
          {
            agents: ["codex"],
            path: target,
            status: "replaced",
          },
        ],
      },
    });
  });

  it("documents init as non-billable onboarding", async () => {
    const command = dependencies(vi.fn() as unknown as typeof fetch);
    expect(await runCli(["help", "init"], command.deps)).toBe(0);
    expect(command.stdout.value()).toContain("deepseek-crawl init [options]");
    expect(command.stdout.value()).toContain("--skip-auth");
    expect(command.stdout.value()).toContain("--project");
    expect(command.stdout.value()).toContain("--agent");
    expect(command.stdout.value()).toContain("never makes a billable");

    const main = dependencies(vi.fn() as unknown as typeof fetch);
    expect(await runCli(["help"], main.deps)).toBe(0);
    expect(main.stdout.value()).toContain("init [options]");
  });
});
