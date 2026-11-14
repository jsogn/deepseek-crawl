import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createExistingPathError } from "../output/files.js";

export function writerLockPath(directory: string): string {
  return join(directory, "writer.lock");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function acquireWriterLock(directory: string): Promise<void> {
  const path = writerLockPath(directory);
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

export async function releaseWriterLock(directory: string): Promise<void> {
  await rm(writerLockPath(directory), { force: true });
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
