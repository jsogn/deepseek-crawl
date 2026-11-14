import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { acquireProcessLock, releaseProcessLock } from "../fs/process-lock.js";

function writerLockPath(directory: string): string {
  return join(directory, "writer.lock");
}

export async function acquireWriterLock(directory: string): Promise<void> {
  await acquireProcessLock(writerLockPath(directory));
}

export async function releaseWriterLock(directory: string): Promise<void> {
  await releaseProcessLock(writerLockPath(directory));
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
