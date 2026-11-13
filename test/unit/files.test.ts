import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "../../src/output/files.js";

describe("writeFileAtomic", () => {
  it("creates parents and leaves no temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-"));
    const path = join(root, "nested", "result.md");
    await writeFileAtomic(path, "# Result\n");
    expect(await readFile(path, "utf8")).toBe("# Result\n");
    expect(await readdir(join(root, "nested"))).toEqual(["result.md"]);
  });
});
