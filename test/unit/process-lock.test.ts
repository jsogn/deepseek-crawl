import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireProcessLock } from "../../src/fs/process-lock.js";

describe("acquireProcessLock", () => {
  it("reports an unreadable existing lock as an existing path", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-lock-"));
    const path = join(root, "writer.lock");
    await writeFile(path, "", "utf8");

    await expect(acquireProcessLock(path)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("grants a stale lock to only one concurrent recovery attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-lock-"));
    const path = join(root, "writer.lock");
    await writeFile(path, JSON.stringify({ pid: 99_999_999 }), "utf8");

    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => acquireProcessLock(path)),
    );

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("recovers an abandoned recovery gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-lock-"));
    const path = join(root, "writer.lock");
    const recoveryPath = `${path}.recovery`;
    await writeFile(path, JSON.stringify({ pid: 99_999_999 }), "utf8");
    await mkdir(recoveryPath);
    const staleAt = new Date(Date.now() - 60_000);
    await utimes(recoveryPath, staleAt, staleAt);

    await expect(acquireProcessLock(path)).resolves.toBeUndefined();
  });
});
