import { describe, expect, it } from "vitest";
import { loadGatewayConfig } from "../../src/gateway/config.js";

describe("loadGatewayConfig", () => {
  it("defaults to a loopback listener and the Firecrawl cloud upstream", () => {
    expect(loadGatewayConfig({ env: {} })).toMatchObject({
      host: "127.0.0.1",
      port: 8787,
      allowRemote: false,
      upstreamUrl: new URL("https://api.firecrawl.dev/"),
      requestBodyLimit: 8 * 1024 * 1024,
      timeoutMs: 120_000,
    });
  });

  it("rejects a non-loopback listener without --allow-remote", () => {
    expect(() =>
      loadGatewayConfig({
        host: "0.0.0.0",
        port: 8787,
        allowRemote: false,
        env: {},
      }),
    ).toThrow(/allow-remote/i);
  });

  it("accepts a non-loopback listener with --allow-remote", () => {
    expect(
      loadGatewayConfig({
        host: "0.0.0.0",
        port: 8787,
        allowRemote: true,
        env: {},
      }),
    ).toMatchObject({ host: "0.0.0.0", allowRemote: true });
  });

  it("does not use FIRECRAWL_API_URL as the gateway upstream", () => {
    expect(
      loadGatewayConfig({
        env: {
          FIRECRAWL_API_URL: "http://127.0.0.1:8787",
          FIRECRAWL_UPSTREAM_URL: "https://firecrawl.example",
        },
      }).upstreamUrl.href,
    ).toBe("https://firecrawl.example/");
  });

  it.each([
    ["ftp://api.firecrawl.dev", /HTTP/],
    ["http://api.firecrawl.dev", /HTTPS/],
    ["https://user:secret@api.firecrawl.dev", /credentials/i],
    ["https://api.firecrawl.dev/?mode=test", /query/i],
  ])("rejects invalid upstream URL %#", (upstream, message) => {
    expect(() =>
      loadGatewayConfig({
        env: { FIRECRAWL_UPSTREAM_URL: upstream },
      }),
    ).toThrow(message);
  });

  it.each([0, 65_536, 1.5])("rejects invalid port %s", (port) => {
    expect(() => loadGatewayConfig({ port, env: {} })).toThrow(/port/i);
  });
});
