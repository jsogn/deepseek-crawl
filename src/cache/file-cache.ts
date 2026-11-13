import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, parse, resolve } from "node:path";
import { contentHash } from "../content/hash.js";
import type { FetchCache, FetchCacheEntry } from "./types.js";

const MAX_CACHE_ENTRY_BYTES = 16 * 1024 * 1024;

function entryPath(root: string, url: string): string {
  const key = createHash("sha256").update(url).digest("hex");
  return join(root, `${key}.json`);
}

function validEntry(value: unknown, url: string): value is FetchCacheEntry {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const entry = value as Partial<FetchCacheEntry>;
  return (
    entry.version === 1 &&
    entry.url === url &&
    typeof entry.fetched_at === "string" &&
    typeof entry.content_hash === "string" &&
    entry.response !== null &&
    typeof entry.response === "object" &&
    typeof entry.response.title === "string" &&
    typeof entry.response.content === "string"
  );
}

export class FileFetchCache implements FetchCache {
  readonly location: string;
  #ready = false;

  constructor(directory: string) {
    this.location = resolve(directory);
  }

  async #ensureLocation(): Promise<void> {
    if (this.#ready) {
      return;
    }
    await mkdir(this.location, { recursive: true, mode: 0o700 });
    await chmod(this.location, 0o700);
    this.#ready = true;
  }

  async read(url: string): Promise<FetchCacheEntry | null> {
    const path = entryPath(this.location, url);
    let content: string;
    try {
      if ((await stat(path)).size > MAX_CACHE_ENTRY_BYTES) {
        return null;
      }
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    try {
      const value = JSON.parse(content) as unknown;
      return validEntry(value, url) && value.content_hash === contentHash(value.response.content)
        ? value
        : null;
    } catch {
      return null;
    }
  }

  async write(
    url: string,
    response: FetchCacheEntry["response"],
    fetchedAt: string,
  ): Promise<void> {
    await this.#ensureLocation();
    const target = entryPath(this.location, url);
    const temporary = join(this.location, `.${basename(target)}.${randomUUID()}.tmp`);
    const content = `${JSON.stringify(
      {
        version: 1,
        url,
        fetched_at: fetchedAt,
        content_hash: contentHash(response.content),
        response,
      },
      null,
      2,
    )}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_CACHE_ENTRY_BYTES) {
      throw new Error("Fetch cache entry exceeds the 16 MiB limit.");
    }
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async clear(): Promise<void> {
    const target = this.location;
    if (target === parse(target).root || target === resolve(homedir())) {
      throw new Error("Refusing to clear an unsafe cache directory.");
    }
    await rm(target, { recursive: true, force: true });
    this.#ready = false;
  }
}
