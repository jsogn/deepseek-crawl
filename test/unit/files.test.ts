import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic, writeFileAtomicNoClobber } from "../../src/output/files.js";

describe("writeFileAtomic", () => {
  it("creates parents and leaves no temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-"));
    const path = join(root, "nested", "result.md");
    await writeFileAtomic(path, "# Result\n");
    expect(await readFile(path, "utf8")).toBe("# Result\n");
    expect(await readdir(join(root, "nested"))).toEqual(["result.md"]);
  });
});

describe("writeFileAtomicNoClobber", () => {
  it("creates a new file without leaving a temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-"));
    const path = join(root, "nested", "result.json");

    await writeFileAtomicNoClobber(path, "new");

    expect(await readFile(path, "utf8")).toBe("new");
    expect(await readdir(join(root, "nested"))).toEqual(["result.json"]);
  });

  it("does not overwrite an existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-"));
    const path = join(root, "result.json");
    await writeFile(path, "original", "utf8");

    await expect(writeFileAtomicNoClobber(path, "replacement")).rejects.toMatchObject({
      code: "EEXIST",
    });

    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(root)).toEqual(["result.json"]);
  });
});
