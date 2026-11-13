import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readlink, rename, rm, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type SkillAgent = "agents" | "codex" | "claude-code" | "cursor";
export type SkillSetupScope = "global" | "project";
export type SkillSetupMode = "symlink" | "copy";

const SKILL_NAME = "deepseek-crawl";
const AGENT_ORDER: SkillAgent[] = ["agents", "codex", "claude-code", "cursor"];

export interface ResolveSkillTargetsOptions {
  agents: SkillAgent[];
  scope: SkillSetupScope;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ResolvedSkillTarget {
  agents: SkillAgent[];
  path: string;
}

export interface SetupSkillsOptions extends ResolveSkillTargetsOptions {
  source: string;
  copy?: boolean;
  force?: boolean;
}

export interface SkillSetupInstall extends ResolvedSkillTarget {
  status: "installed" | "unchanged" | "replaced";
  mode: SkillSetupMode;
}

export interface SkillSetupResult extends Record<string, unknown> {
  version: 1;
  scope: SkillSetupScope;
  mode: SkillSetupMode;
  source: string;
  installs: SkillSetupInstall[];
  restart_required: true;
}

export function parseSkillAgents(value = "agents"): SkillAgent[] {
  const requested = new Set(
    value
      .split(",")
      .map((agent) => agent.trim())
      .filter(Boolean),
  );
  if (requested.size === 0) {
    throw new Error("At least one Agent must be selected.");
  }

  if (requested.has("all")) {
    return [...AGENT_ORDER];
  }

  for (const agent of requested) {
    if (!AGENT_ORDER.includes(agent as SkillAgent)) {
      throw new Error(`Unknown Agent: ${agent}.`);
    }
  }
  return AGENT_ORDER.filter((agent) => requested.has(agent));
}

function resolveAgentBase(
  agent: SkillAgent,
  scope: SkillSetupScope,
  home: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  if (scope === "project") {
    if (agent === "claude-code") {
      return join(cwd, ".claude");
    }
    return join(cwd, ".agents");
  }

  if (agent === "agents") return join(home, ".agents");
  if (agent === "claude-code") return join(home, ".claude");
  if (agent === "cursor") return join(home, ".cursor");

  const configuredCodexHome = env.CODEX_HOME?.trim();
  if (!configuredCodexHome) {
    return join(home, ".codex");
  }
  return isAbsolute(configuredCodexHome) ? configuredCodexHome : resolve(home, configuredCodexHome);
}

export function resolveSkillTargets(options: ResolveSkillTargetsOptions): ResolvedSkillTarget[] {
  const targets = new Map<string, SkillAgent[]>();
  for (const agent of options.agents) {
    const path = join(
      resolveAgentBase(agent, options.scope, options.home, options.cwd, options.env),
      "skills",
      SKILL_NAME,
    );
    const grouped = targets.get(path);
    if (grouped) {
      grouped.push(agent);
    } else {
      targets.set(path, [agent]);
    }
  }
  return [...targets.entries()].map(([path, agents]) => ({ agents, path }));
}

async function existingPath(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function installTarget(
  source: string,
  target: string,
  mode: SkillSetupMode,
  force: boolean,
): Promise<"installed" | "unchanged" | "replaced"> {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const existing = await existingPath(target);
  let replaced = false;

  if (existing) {
    if (mode === "symlink" && existing.isSymbolicLink()) {
      const linked = resolve(parent, await readlink(target));
      if (linked === source) {
        return "unchanged";
      }
    }
    if (!force) {
      throw new Error(`Skill destination already exists: ${target}. Use --force to replace it.`);
    }
    await rm(target, { recursive: true, force: true });
    replaced = true;
  }

  const temporary = join(parent, `.${SKILL_NAME}.${randomUUID()}.tmp`);
  try {
    if (mode === "symlink") {
      await symlink(source, temporary, "dir");
    } else {
      await cp(source, temporary, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return replaced ? "replaced" : "installed";
}

export async function setupSkills(options: SetupSkillsOptions): Promise<SkillSetupResult> {
  const source = resolve(options.source);
  const sourceStat = await stat(source).catch((error) => {
    throw new Error(`Bundled Skill source is unavailable: ${source}`, { cause: error });
  });
  if (!sourceStat.isDirectory()) {
    throw new Error(`Bundled Skill source is not a directory: ${source}`);
  }

  const mode: SkillSetupMode = options.copy ? "copy" : "symlink";
  const targets = resolveSkillTargets(options);
  const installs: SkillSetupInstall[] = [];
  for (const target of targets) {
    installs.push({
      ...target,
      status: await installTarget(source, target.path, mode, options.force ?? false),
      mode,
    });
  }

  return {
    version: 1,
    scope: options.scope,
    mode,
    source,
    installs,
    restart_required: true,
  };
}
