import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { isPublicIpAddress, resolvePublicAddress } from "../../src/sitemap/network-policy.js";
import { createPublicSitemapFetcher, requestSitemapDocument } from "../../src/sitemap/reader.js";

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
    "64:ff9b::a00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::c0a8:1",
    "100::1",
    "2001::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:2::1",
    "2001:db8::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "2606:4700:4700::1111",
    "2606:4700:4700:0:0:0:0:1111",
    "64:ff9b::808:808",
  ])("accepts public address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

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

  it("handles a direct public IPv6 URL without DNS lookup", async () => {
    const lookup = vi.fn(async () => {
      throw new Error("lookup should not run");
    });

    await expect(resolvePublicAddress("[2606:4700:4700::1111]", lookup)).resolves.toEqual({
      address: "2606:4700:4700::1111",
      family: 6,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects a direct non-public IPv6 URL without DNS lookup", async () => {
    const lookup = vi.fn(async () => {
      throw new Error("lookup should not run");
    });

    await expect(resolvePublicAddress("[::1]", lookup)).rejects.toThrow(/non-public/i);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("stops waiting for DNS when cancelled", async () => {
    const controller = new AbortController();
    const pending = resolvePublicAddress(
      "example.com",
      async () => new Promise(() => undefined),
      controller.signal,
    );
    controller.abort(new Error("cancelled"));

    await expect(pending).rejects.toThrow(/cancelled/i);
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

  it("normalizes a direct IPv6 hostname before resolution", async () => {
    const resolve = vi.fn(async () => ({
      address: "2606:4700:4700::1111",
      family: 6 as const,
    }));
    const request = vi.fn(async () => ({
      status: 200,
      body: "<urlset />",
    }));
    const fetcher = createPublicSitemapFetcher({ resolve, request });

    await expect(
      fetcher.fetch(new URL("https://[2606:4700:4700::1111]/sitemap.xml")),
    ).resolves.toMatchObject({
      finalUrl: new URL("https://[2606:4700:4700::1111]/sitemap.xml"),
    });
    expect(resolve).toHaveBeenCalledWith("2606:4700:4700::1111", expect.any(AbortSignal));
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

  it("includes a stalled DNS lookup in the operation timeout", async () => {
    const request = vi.fn();
    const fetcher = createPublicSitemapFetcher({
      resolve: async () => new Promise(() => undefined),
      request,
      timeoutMs: 10,
    });

    await expect(fetcher.fetch(new URL("https://example.com/sitemap.xml"))).rejects.toThrow(
      /timed out/i,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels while DNS resolution is pending", async () => {
    const controller = new AbortController();
    const request = vi.fn();
    const fetcher = createPublicSitemapFetcher({
      resolve: async () => new Promise(() => undefined),
      request,
    });
    const pending = fetcher.fetch(new URL("https://example.com/sitemap.xml"), controller.signal);
    controller.abort(new Error("cancelled"));

    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the default request transport with all-address socket lookups", async () => {
    const server = createServer((_request, response) => {
      response.end("<urlset />");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind");
    }

    try {
      await expect(
        requestSitemapDocument(
          new URL(`http://sitemap.test:${address.port}/sitemap.xml`),
          { address: "127.0.0.1", family: 4 },
          undefined,
          1024,
        ),
      ).resolves.toEqual({
        status: 200,
        body: "<urlset />",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
