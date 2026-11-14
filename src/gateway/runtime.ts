import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveCacheDirectory } from "../cache/paths.js";

const RUNTIME_VERSION = 1;

export interface GatewayRuntimeState {
  version: 1;
  pid: number;
  url: string;
  mode: "local" | "remote";
  startedAt: string;
}

interface ListedRuntimeState {
  path: string;
  state: GatewayRuntimeState;
}

export interface GatewayRuntimePruneResult {
  running: GatewayRuntimeState[];
  stale: number;
}

export function resolveGatewayRuntimeDirectory(
  env: NodeJS.ProcessEnv,
  home: string,
  platform = process.platform,
): string {
  const explicit = env.DEEPSEEK_GATEWAY_RUNTIME_DIR?.trim();
  if (explicit) {
    return resolve(explicit);
  }
  const runtimeRoot = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeRoot) {
    return join(runtimeRoot, "deepseek-crawl", "gateway");
  }
  return join(resolveCacheDirectory(env, home, platform), "gateway", "runtime");
}

function validateState(value: unknown): GatewayRuntimeState {
  if (!value || typeof value !== "object") {
    throw new Error("Gateway runtime state must be an object.");
  }
  const candidate = value as Partial<GatewayRuntimeState>;
  if (
    candidate.version !== RUNTIME_VERSION ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid ?? 0) < 1 ||
    typeof candidate.url !== "string" ||
    !["local", "remote"].includes(candidate.mode ?? "") ||
    typeof candidate.startedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.startedAt))
  ) {
    throw new Error("Gateway runtime state is invalid.");
  }
  new URL(candidate.url);
  return {
    version: 1,
    pid: candidate.pid as number,
    url: candidate.url,
    mode: candidate.mode as "local" | "remote",
    startedAt: candidate.startedAt,
  };
}

function runtimeFileName(state: GatewayRuntimeState): string {
  const port = new URL(state.url).port || "default";
  return `${state.pid}-${port}.json`;
}

async function listedStates(directory: string): Promise<ListedRuntimeState[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const states: ListedRuntimeState[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const path = join(directory, entry.name);
    try {
      states.push({
        path,
        state: validateState(JSON.parse(await readFile(path, "utf8"))),
      });
    } catch {
      await rm(path, { force: true });
    }
  }
  return states;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function healthy(state: GatewayRuntimeState, fetchImpl: typeof fetch): Promise<boolean> {
  if (!processExists(state.pid)) {
    return false;
  }
  const base = state.url.endsWith("/") ? state.url : `${state.url}/`;
  try {
    const response = await fetchImpl(new URL("healthz", base), {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { status?: unknown; pid?: unknown };
    return body.status === "ok" && body.pid === state.pid;
  } catch {
    return false;
  }
}

export async function writeGatewayRuntimeState(
  directory: string,
  state: GatewayRuntimeState,
): Promise<string> {
  const validated = validateState(state);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, runtimeFileName(validated));
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
    return path;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function removeGatewayRuntimeState(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function listGatewayRuntimeStates(directory: string): Promise<GatewayRuntimeState[]> {
  return (await listedStates(directory))
    .map((entry) => entry.state)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.pid - right.pid);
}

export async function pruneGatewayRuntimeStates(
  directory: string,
  fetchImpl: typeof fetch,
): Promise<GatewayRuntimePruneResult> {
  const entries = await listedStates(directory);
  const running: GatewayRuntimeState[] = [];
  let stale = 0;
  for (const entry of entries) {
    if (await healthy(entry.state, fetchImpl)) {
      running.push(entry.state);
    } else {
      stale += 1;
      await rm(entry.path, { force: true });
    }
  }
  running.sort(
    (left, right) => left.startedAt.localeCompare(right.startedAt) || left.pid - right.pid,
  );
  return { running, stale };
}
