import { randomUUID } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function writeFileAtomic(outputPath: string, content: string): Promise<void> {
  const directory = dirname(outputPath);
  const temporaryPath = join(directory, `.${basename(outputPath)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeFileAtomicNoClobber(outputPath: string, content: string): Promise<void> {
  const directory = dirname(outputPath);
  const temporaryPath = join(directory, `.${basename(outputPath)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await link(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
