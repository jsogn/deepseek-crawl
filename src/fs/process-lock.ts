import { readFile, rm, writeFile } from "node:fs/promises";
import { createExistingPathError } from "./path-error.js";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function acquireProcessLock(path: string): Promise<void> {
  const payload = JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() });
  try {
    await writeFile(path, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  const existing = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
  if (!Number.isSafeInteger(existing.pid) || (existing.pid as number) < 1) {
    throw createExistingPathError(path);
  }
  if (processIsAlive(existing.pid as number)) {
    throw createExistingPathError(path);
  }

  await rm(path, { force: true });
  await writeFile(path, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

export async function releaseProcessLock(path: string): Promise<void> {
  await rm(path, { force: true });
}
