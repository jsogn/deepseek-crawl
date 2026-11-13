import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { assertPathMissing, createExistingPathError } from "./files.js";
import { type PageFileIdentity, pageRelativePath } from "./page.js";

export interface StagedDirectoryOutput {
  writePage(page: PageFileIdentity, markdown: string): Promise<string>;
  finish<T>(
    writeManifest: (stagingPath: string, pagePaths: ReadonlyMap<number, string>) => Promise<T>,
  ): Promise<T>;
  abort(): Promise<void>;
}

function lockPath(finalPath: string): string {
  return join(dirname(finalPath), `.${basename(finalPath)}.lock`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquirePublicationLock(path: string): Promise<void> {
  const payload = JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() });
  try {
    await writeFile(path, payload, { encoding: "utf8", flag: "wx" });
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
  await writeFile(path, payload, { encoding: "utf8", flag: "wx" });
}

export async function createStagedDirectoryOutput(
  finalDirectory: string,
  notWritableMessage: string,
): Promise<StagedDirectoryOutput> {
  const finalPath = resolve(finalDirectory);
  await assertPathMissing(finalPath);

  const parent = dirname(finalPath);
  await mkdir(parent, { recursive: true });
  const stagingPath = await mkdtemp(join(parent, `.${basename(finalPath)}-`));
  await mkdir(join(stagingPath, "pages"));

  const pagePaths = new Map<number, string>();
  let finished = false;
  let aborted = false;

  const ensureWritable = (): void => {
    if (finished || aborted) {
      throw new Error(notWritableMessage);
    }
  };

  return {
    async writePage(page, markdown) {
      ensureWritable();
      const relativePath = pageRelativePath(page);
      await writeFile(join(stagingPath, relativePath), markdown, {
        encoding: "utf8",
        flag: "wx",
      });
      pagePaths.set(page.index, relativePath);
      return relativePath;
    },

    async finish(writeManifest) {
      ensureWritable();
      const publicationLock = lockPath(finalPath);
      let ownsLock = false;
      try {
        const output = await writeManifest(stagingPath, pagePaths);
        await acquirePublicationLock(publicationLock);
        ownsLock = true;
        await assertPathMissing(finalPath);
        await rename(stagingPath, finalPath);
        finished = true;
        return output;
      } catch (error) {
        if (!finished) {
          await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
          aborted = true;
        }
        throw error;
      } finally {
        if (ownsLock) {
          await rm(publicationLock, { force: true }).catch(() => undefined);
        }
      }
    },

    async abort() {
      if (finished || aborted) {
        return;
      }
      await rm(stagingPath, { recursive: true, force: true });
      aborted = true;
    },
  };
}
