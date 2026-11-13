import { describe, expect, it, vi } from "vitest";
import { isPublicIpAddress, resolvePublicAddress } from "../../src/sitemap/network-policy.js";
import { createPublicSitemapFetcher } from "../../src/sitemap/reader.js";

describe("isPublicIpAddress", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "100::1",
    "2001:2::1",
    "2001:db8::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2606:4700:4700:0:0:0:0:1111"])(
    "accepts public address %s",
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );

  it("rejects malformed addresses", () => {
    expect(isPublicIpAddress("example.com")).toBe(false);
    expect(isPublicIpAddress("999.1.1.1")).toBe(false);
  });
});

describe("resolvePublicAddress", () => {
  it("returns a deterministic public address", async () => {
    const lookup = vi.fn(async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    await expect(resolvePublicAddress("example.com", lookup)).resolves.toEqual({
      address: "1.1.1.1",
      family: 4,
    });
  });

  it("rejects when any resolved address is non-public", async () => {
    const lookup = vi.fn(async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(resolvePublicAddress("example.com", lookup)).rejects.toThrow(/non-public/i);
  });

  it("rejects an empty resolution", async () => {
    await expect(
      resolvePublicAddress(
        "example.com",
        vi.fn(async () => []),
      ),
    ).rejects.toThrow(/did not resolve/i);
  });
});

describe("createPublicSitemapFetcher", () => {
  it("follows same-origin redirects and returns the final URL", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        location: "/sitemap-pages.xml",
        body: "",
      })
      .mockResolvedValueOnce({
        status: 200,
        body: "<urlset />",
      });
    const fetcher = createPublicSitemapFetcher({
      resolve: async () => ({ address: "1.1.1.1", family: 4 }),
      request,
    });

    await expect(fetcher.fetch(new URL("https://example.com/sitemap.xml"))).resolves.toEqual({
      body: "<urlset />",
      finalUrl: new URL("https://example.com/sitemap-pages.xml"),
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects a cross-origin sitemap redirect", async () => {
    const fetcher = createPublicSitemapFetcher({
      resolve: async () => ({ address: "1.1.1.1", family: 4 }),
      request: async () => ({
        status: 302,
        location: "https://other.example/sitemap.xml",
        body: "",
      }),
    });

    await expect(fetcher.fetch(new URL("https://example.com/sitemap.xml"))).rejects.toThrow(
      /same origin/i,
    );
  });

  it("enforces the redirect limit", async () => {
    const fetcher = createPublicSitemapFetcher({
      resolve: async () => ({ address: "1.1.1.1", family: 4 }),
      request: async (url) => ({
        status: 302,
        location: `${url.pathname}-next`,
        body: "",
      }),
      maxRedirects: 2,
    });

    await expect(fetcher.fetch(new URL("https://example.com/sitemap.xml"))).rejects.toThrow(
      /redirect limit/i,
    );
  });

  it("enforces the configured body limit for injected requests", async () => {
    const fetcher = createPublicSitemapFetcher({
      resolve: async () => ({ address: "1.1.1.1", family: 4 }),
      request: async () => ({ status: 200, body: "x".repeat(33) }),
      bodyLimitBytes: 32,
    });

    await expect(fetcher.fetch(new URL("https://example.com/sitemap.xml"))).rejects.toThrow(
      /5 MiB|body limit/i,
    );
  });

  it("propagates private-address rejection without making the request", async () => {
    const request = vi.fn();
    const fetcher = createPublicSitemapFetcher({
      resolve: async () => {
        throw new Error("Refusing non-public address.");
      },
      request,
    });

    await expect(fetcher.fetch(new URL("https://example.com/sitemap.xml"))).rejects.toThrow(
      /non-public/i,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a private address returned by an injected resolver", async () => {
    const request = vi.fn();
    const fetcher = createPublicSitemapFetcher({
      resolve: async () => ({ address: "127.0.0.1", family: 4 }),
      request,
    });

    await expect(fetcher.fetch(new URL("https://example.com/sitemap.xml"))).rejects.toThrow(
      /non-public/i,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("times out a request that does not settle", async () => {
    const fetcher = createPublicSitemapFetcher({
      resolve: async () => ({ address: "1.1.1.1", family: 4 }),
      request: async () => new Promise(() => undefined),
      timeoutMs: 10,
    });

    await expect(fetcher.fetch(new URL("https://example.com/sitemap.xml"))).rejects.toThrow(
      /timed out/i,
    );
  });
});
