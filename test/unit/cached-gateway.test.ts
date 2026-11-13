import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CachedFetchGateway } from "../../src/cache/cached-gateway.js";
import { FileFetchCache } from "../../src/cache/file-cache.js";

describe("CachedFetchGateway", () => {
  it("serves a successful response within TTL without another API request", async () => {
    const cache = new FileFetchCache(
      join(await mkdtemp(join(tmpdir(), "deepseek-cache-")), "cache"),
    );
    const fetch = vi.fn(async () => ({ title: "Example", content: "body" }));
    const now = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-11-14T01:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-11-14T01:00:30.000Z"))
      .mockReturnValueOnce(new Date("2026-11-14T01:00:30.000Z"));
    const gateway = new CachedFetchGateway({ search: vi.fn(), fetch }, cache, {
      ttlMs: 60_000,
      fresh: false,
      now,
    });

    await gateway.fetch({ url: "https://example.com/page" });
    const cached = await gateway.fetch({ url: "https://example.com/page" });

    expect(cached).toEqual({ title: "Example", content: "body" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(gateway.sourceFor("https://example.com/page")).toBe("cache");
    expect(gateway.stats()).toEqual({ hits: 1, misses: 1, errors: 0 });
  });

  it("expires old entries and refreshes the cache", async () => {
    const cache = new FileFetchCache(
      join(await mkdtemp(join(tmpdir(), "deepseek-cache-")), "cache"),
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ title: "Old", content: "old" })
      .mockResolvedValueOnce({ title: "New", content: "new" });
    const now = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-11-14T01:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-11-14T01:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-11-14T01:02:01.000Z"))
      .mockReturnValueOnce(new Date("2026-11-14T01:02:01.000Z"));
    const gateway = new CachedFetchGateway({ search: vi.fn(), fetch }, cache, {
      ttlMs: 60_000,
      fresh: false,
      now,
    });

    await gateway.fetch({ url: "https://example.com/page" });
    await expect(gateway.fetch({ url: "https://example.com/page" })).resolves.toEqual({
      title: "New",
      content: "new",
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(gateway.sourceFor("https://example.com/page")).toBe("api");
    expect(gateway.stats()).toEqual({ hits: 0, misses: 2, errors: 0 });
  });

  it("bypasses a fresh cached entry when fresh mode is enabled", async () => {
    const cache = new FileFetchCache(
      join(await mkdtemp(join(tmpdir(), "deepseek-cache-")), "cache"),
    );
    await cache.write(
      "https://example.com/page",
      { title: "Cached", content: "cached" },
      "2026-11-14T01:00:00.000Z",
    );
    const fetch = vi.fn(async () => ({ title: "Live", content: "live" }));
    const gateway = new CachedFetchGateway({ search: vi.fn(), fetch }, cache, {
      ttlMs: 60_000,
      fresh: true,
      now: () => new Date("2026-11-14T01:00:30.000Z"),
    });

    await expect(gateway.fetch({ url: "https://example.com/page" })).resolves.toEqual({
      title: "Live",
      content: "live",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(gateway.sourceFor("https://example.com/page")).toBe("api");
  });

  it("does not cache failed requests", async () => {
    const cache = new FileFetchCache(
      join(await mkdtemp(join(tmpdir(), "deepseek-cache-")), "cache"),
    );
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ title: "Recovered", content: "body" });
    const gateway = new CachedFetchGateway({ search: vi.fn(), fetch }, cache, {
      ttlMs: 60_000,
      fresh: false,
      now: () => new Date("2026-11-14T01:00:00.000Z"),
    });

    await expect(gateway.fetch({ url: "https://example.com/page" })).rejects.toThrow("down");
    await expect(gateway.fetch({ url: "https://example.com/page" })).resolves.toEqual({
      title: "Recovered",
      content: "body",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to API when cache reads or writes fail", async () => {
    const cache = {
      location: "/tmp/cache",
      read: vi.fn(async () => Promise.reject(new Error("read failed"))),
      write: vi.fn(async () => Promise.reject(new Error("write failed"))),
      clear: vi.fn(),
    };
    const fetch = vi.fn(async () => ({ title: "Live", content: "body" }));
    const gateway = new CachedFetchGateway({ search: vi.fn(), fetch }, cache, {
      ttlMs: 60_000,
      fresh: false,
      now: () => new Date("2026-11-14T01:00:00.000Z"),
    });

    await expect(gateway.fetch({ url: "https://example.com/page" })).resolves.toEqual({
      title: "Live",
      content: "body",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(gateway.stats()).toEqual({ hits: 0, misses: 1, errors: 2 });
  });

  it("prepares a cache hit without rereading the entry during fetch", async () => {
    const cache = new FileFetchCache(
      join(await mkdtemp(join(tmpdir(), "deepseek-cache-")), "cache"),
    );
    await cache.write(
      "https://example.com/page",
      { title: "Cached", content: "cached" },
      "2026-11-14T01:00:00.000Z",
    );
    const read = vi.spyOn(cache, "read");
    const fetch = vi.fn();
    const gateway = new CachedFetchGateway({ search: vi.fn(), fetch }, cache, {
      ttlMs: 60_000,
      fresh: false,
      now: () => new Date("2026-11-14T01:00:30.000Z"),
    });

    await expect(gateway.prepare({ url: "https://example.com/page" })).resolves.toBe(true);
    await expect(gateway.fetch({ url: "https://example.com/page" })).resolves.toEqual({
      title: "Cached",
      content: "cached",
    });

    expect(read).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(gateway.stats()).toEqual({ hits: 1, misses: 0, errors: 0 });
  });
});
