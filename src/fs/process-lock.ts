import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createExistingPathError } from "./path-error.js";

const MAX_LOCK_READ_ATTEMPTS = 20;
const LOCK_RETRY_DELAY_MS = 1;
const RECOVERY_GATE_STALE_MS = 10_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function waitForLockRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
}

type LockRecord =
  | { state: "ready"; pid: number }
  | { state: "missing" }
  | { state: "incomplete" }
  | { state: "invalid" };

async function readLockRecord(path: string): Promise<LockRecord> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing" };
    }
    throw error;
  }

  let existing: { pid?: unknown };
  try {
    existing = JSON.parse(serialized) as { pid?: unknown };
  } catch {
    return { state: "incomplete" };
  }
  if (!Number.isSafeInteger(existing.pid) || (existing.pid as number) < 1) {
    return { state: "invalid" };
  }
  return { state: "ready", pid: existing.pid as number };
}

export async function acquireProcessLock(path: string): Promise<void> {
  const payload = JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() });
  const recoveryPath = `${path}.recovery`;
  for (let attempt = 0; attempt < MAX_LOCK_READ_ATTEMPTS; attempt += 1) {
    try {
      await writeFile(path, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    const existing = await readLockRecord(path);
    if (existing.state === "missing" || existing.state === "incomplete") {
      await waitForLockRetry();
      continue;
    }
    if (existing.state === "invalid") {
      throw createExistingPathError(path);
    }
    if (processIsAlive(existing.pid)) {
      throw createExistingPathError(path);
    }

    try {
      await mkdir(recoveryPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const recovery = await lstat(recoveryPath);
          if (Date.now() - recovery.mtimeMs >= RECOVERY_GATE_STALE_MS) {
            await rm(recoveryPath, { recursive: true, force: true });
            continue;
          }
        } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          throw recoveryError;
        }
        await waitForLockRetry();
        continue;
      }
      throw error;
    }

    try {
      const confirmed = await readLockRecord(path);
      if (confirmed.state === "missing" || confirmed.state === "incomplete") {
        await waitForLockRetry();
        continue;
      }
      if (confirmed.state === "invalid" || processIsAlive(confirmed.pid)) {
        throw createExistingPathError(path);
      }
      await rm(path, { force: true });
    } finally {
      await rm(recoveryPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  throw createExistingPathError(path);
}

export async function releaseProcessLock(path: string): Promise<void> {
  await rm(path, { force: true });
}
