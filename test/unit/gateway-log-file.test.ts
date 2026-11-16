import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RotatingLogFileWriter } from "../../src/gateway/log-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("rotating Gateway log file", () => {
  it("rotates by size and keeps only the configured number of files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepseek-gateway-log-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "gateway.jsonl");
    const writer = new RotatingLogFileWriter(path, {
      maxBytes: 6,
      maxFiles: 2,
    });

    writer.write("aaaa\n");
    writer.write("bbbb\n");
    writer.write("cccc\n");
    await writer.close();

    expect(await readFile(path, "utf8")).toBe("cccc\n");
    expect(await readFile(`${path}.1`, "utf8")).toBe("bbbb\n");
    await expect(lstat(`${path}.2`)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });
});
