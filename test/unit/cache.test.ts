import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileFetchCache } from "../../src/cache/file-cache.js";
import { resolveCacheDirectory } from "../../src/cache/paths.js";

describe("FileFetchCache", () => {
  it("persists successful Fetch responses across cache instances", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "deepseek-cache-")), "cache");
    const fetchedAt = "2026-11-14T01:00:00.000Z";
    const response = { title: "Example", content: "# Example\n" };

    const cache = new FileFetchCache(root);
    await cache.write("https://example.com/page", response, fetchedAt);

    await expect(new FileFetchCache(root).read("https://example.com/page")).resolves.toEqual({
      version: 1,
      url: "https://example.com/page",
      fetched_at: fetchedAt,
      response,
    });
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  it("uses cache keys that remain readable without exposing URL text in filenames", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "deepseek-cache-")), "cache");
    const cache = new FileFetchCache(root);
    await cache.write(
      "https://example.com/private/path",
      { title: "Private", content: "body" },
      "2026-11-14T01:00:00.000Z",
    );

    const entry = await cache.read("https://example.com/private/path");
    expect(entry?.response.content).toBe("body");
    const files = await import("node:fs/promises").then(({ readdir }) => readdir(root));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(files[0]).not.toContain("private");
    expect((await stat(join(root, files[0] ?? ""))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(root, files[0] ?? ""), "utf8")).toContain(
      "https://example.com/private/path",
    );
  });

  it("clears the dedicated cache directory", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "deepseek-cache-")), "cache");
    const cache = new FileFetchCache(root);
    await cache.write(
      "https://example.com/",
      { title: "Example", content: "body" },
      "2026-11-14T01:00:00.000Z",
    );

    await cache.clear();

    await expect(cache.read("https://example.com/")).resolves.toBeNull();
    await cache.write(
      "https://example.com/",
      { title: "New", content: "new" },
      "2026-11-14T01:01:00.000Z",
    );
    await expect(cache.read("https://example.com/")).resolves.toMatchObject({
      response: { title: "New", content: "new" },
    });
  });

  it("refuses to clear the filesystem root", async () => {
    await expect(new FileFetchCache("/").clear()).rejects.toThrow(/unsafe/i);
  });
});

describe("resolveCacheDirectory", () => {
  it("uses an explicit directory, XDG cache, or platform default in that order", () => {
    expect(
      resolveCacheDirectory({ DEEPSEEK_CACHE_DIR: "/tmp/deep-cache" }, "/home/u", "linux"),
    ).toBe("/tmp/deep-cache");
    expect(resolveCacheDirectory({ XDG_CACHE_HOME: "/tmp/xdg" }, "/home/u", "linux")).toBe(
      "/tmp/xdg/deepseek-crawl",
    );
    expect(resolveCacheDirectory({}, "/home/u", "darwin")).toBe(
      "/home/u/Library/Caches/deepseek-crawl",
    );
    expect(resolveCacheDirectory({}, "/home/u", "linux")).toBe("/home/u/.cache/deepseek-crawl");
  });
});
