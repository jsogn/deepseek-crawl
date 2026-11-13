import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { safePageSlug } from "../crawl/links.js";
import type {
  CrawlOutputResult,
  CrawlPage,
  CrawlPageSummary,
  CrawlRunResult,
} from "../crawl/types.js";

export interface CrawlOutputWriter {
  writePage(page: CrawlPage): Promise<string>;
  finish(result: CrawlRunResult): Promise<CrawlOutputResult>;
  abort(): Promise<void>;
}

function existingPathError(path: string): NodeJS.ErrnoException {
  const error = new Error(`Output path already exists: ${path}`) as NodeJS.ErrnoException;
  error.code = "EEXIST";
  return error;
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
    throw existingPathError(path);
  }
  if (processIsAlive(existing.pid as number)) {
    throw existingPathError(path);
  }

  await rm(path, { force: true });
  await writeFile(path, payload, { encoding: "utf8", flag: "wx" });
}

async function requireMissingPath(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw existingPathError(path);
}

function pagePath(page: Pick<CrawlPageSummary, "index" | "url">): string {
  return `pages/${String(page.index).padStart(4, "0")}-${safePageSlug(new URL(page.url))}.md`;
}

function pageMarkdown(page: CrawlPage): string {
  const title = page.title.trim() || "Untitled";
  const content = page.content.endsWith("\n") ? page.content : `${page.content}\n`;
  return `# ${title}\n\nSource: ${page.url}\n\n${content}`;
}

export async function createCrawlOutputWriter(finalDirectory: string): Promise<CrawlOutputWriter> {
  const finalPath = resolve(finalDirectory);
  await requireMissingPath(finalPath);

  const parent = dirname(finalPath);
  await mkdir(parent, { recursive: true });
  const stagingPath = await mkdtemp(join(parent, `.${basename(finalPath)}-`));
  await mkdir(join(stagingPath, "pages"));

  const pagePaths = new Map<number, string>();
  let finished = false;
  let aborted = false;

  const ensureWritable = (): void => {
    if (finished || aborted) {
      throw new Error("Crawl output writer is no longer writable.");
    }
  };

  return {
    async writePage(page) {
      ensureWritable();
      const relativePath = pagePath(page);
      const absolutePath = join(stagingPath, relativePath);
      await writeFile(absolutePath, pageMarkdown(page), {
        encoding: "utf8",
        flag: "wx",
      });
      pagePaths.set(page.index, relativePath);
      return relativePath;
    },

    async finish(result) {
      ensureWritable();
      const publicationLock = lockPath(finalPath);
      let ownsLock = false;
      try {
        const pages = result.pages.map((summary) => {
          const path = pagePaths.get(summary.index);
          if (!path) {
            throw new Error(`Crawl page ${summary.index} was not written.`);
          }
          return { ...summary, path };
        });
        const output: CrawlOutputResult = { ...result, pages };

        await writeFile(
          join(stagingPath, "crawl.json"),
          `${JSON.stringify(output, null, 2)}\n`,
          "utf8",
        );
        await acquirePublicationLock(publicationLock);
        ownsLock = true;
        await requireMissingPath(finalPath);
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

export function formatCrawlHuman(result: CrawlRunResult, outputDirectory: string): string {
  const lines = [
    `Seed: ${result.seed_url}`,
    `Depth: ${result.settings.max_depth}`,
    `Page limit: ${result.settings.max_pages}`,
    `Concurrency: ${result.settings.concurrency}`,
    `Delay: ${result.settings.delay_ms} ms`,
    `Fetched: ${result.stats.fetched}`,
    `Failed: ${result.stats.failed}`,
    `Content truncated: ${result.stats.content_truncated}`,
    `Page limit reached: ${result.stats.limit_reached ? "yes" : "no"}`,
    `Discovery limit reached: ${result.stats.discovery_limit_reached ? "yes" : "no"}`,
  ];
  if (result.settings.sitemap_mode !== undefined) {
    lines.push(`Sitemap: ${result.settings.sitemap_mode}`);
  }
  if (result.stats.sitemap_candidates !== undefined) {
    lines.push(`Sitemap candidates: ${result.stats.sitemap_candidates}`);
  }
  if (result.warnings.length > 0) {
    lines.push(`Warnings: ${result.warnings.length}`);
    for (const warning of result.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
  }
  lines.push(`Output: ${outputDirectory}`);
  return lines.join("\n");
}
