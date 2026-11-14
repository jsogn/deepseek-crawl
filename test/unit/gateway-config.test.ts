import { describe, expect, it } from "vitest";
import type { CredentialStore } from "../../src/credentials/store.js";
import { loadGatewayConfig } from "../../src/gateway/config.js";

function store(value?: string): CredentialStore {
  return {
    name: "keychain",
    get: () => value,
    set: () => undefined,
    remove: () => undefined,
  };
}

describe("loadGatewayConfig", () => {
  it("defaults to an auto-port loopback listener and the Firecrawl cloud upstream", () => {
    expect(loadGatewayConfig({ env: {}, credentialStores: {} })).toMatchObject({
      host: "127.0.0.1",
      port: 8787,
      allowRemote: false,
      autoPort: true,
      providerMode: "firecrawl-first",
      creditsCooldownMs: 60_000,
      maxConcurrentRequests: 100,
      maxConcurrentProviderRequests: 100,
      maxActiveCrawlJobs: 10,
      maxRetainedCrawlJobs: 100,
      upstreamUrl: new URL("https://api.firecrawl.dev/"),
      requestBodyLimit: 8 * 1024 * 1024,
      timeoutMs: 120_000,
    });
  });

  it("rejects a non-loopback host outside remote mode", () => {
    expect(() =>
      loadGatewayConfig({
        host: "0.0.0.0",
        remote: false,
        env: {},
        credentialStores: {},
      }),
    ).toThrow(/remote/i);
  });

  it("requires a gateway API key in remote mode", () => {
    expect(() =>
      loadGatewayConfig({
        remote: true,
        env: {},
        credentialStores: {},
      }),
    ).toThrow(/GATEWAY_API_KEY/i);
  });

  it("defaults remote mode to a fixed public listener with stored credentials", () => {
    expect(
      loadGatewayConfig({
        remote: true,
        env: {},
        credentialStores: {
          gateway: store("gateway-token"),
          firecrawl: store("fc-stored"),
        },
      }),
    ).toMatchObject({
      host: "0.0.0.0",
      allowRemote: true,
      autoPort: false,
      gatewayApiKey: "gateway-token",
      firecrawlApiKey: "fc-stored",
    });
  });

  it("makes an explicit local port strict", () => {
    expect(
      loadGatewayConfig({
        port: 9000,
        env: {},
        credentialStores: {},
      }),
    ).toMatchObject({ port: 9000, autoPort: false });
  });

  it("prefers provider environment variables over stored credentials", () => {
    expect(
      loadGatewayConfig({
        env: {
          FIRECRAWL_API_KEY: "fc-environment",
          GATEWAY_API_KEY: "gateway-environment",
        },
        credentialStores: {
          firecrawl: store("fc-stored"),
          gateway: store("gateway-stored"),
        },
      }),
    ).toMatchObject({
      firecrawlApiKey: "fc-environment",
      gatewayApiKey: "gateway-environment",
    });
  });

  it("configures provider selection from an option or environment", () => {
    expect(
      loadGatewayConfig({
        providerMode: "deepseek-first",
        env: { DEEPSEEK_GATEWAY_PROVIDER_MODE: "no-fallback" },
        credentialStores: {},
      }).providerMode,
    ).toBe("deepseek-first");
    expect(
      loadGatewayConfig({
        env: { DEEPSEEK_GATEWAY_PROVIDER_MODE: "no-fallback" },
        credentialStores: {},
      }).providerMode,
    ).toBe("no-fallback");
  });

  it("rejects an unknown provider mode", () => {
    expect(() =>
      loadGatewayConfig({
        env: { DEEPSEEK_GATEWAY_PROVIDER_MODE: "sometimes" },
        credentialStores: {},
      }),
    ).toThrow(/provider mode/i);
  });

  it("configures the exhausted-credit cooldown from an option or environment", () => {
    expect(
      loadGatewayConfig({
        creditsCooldownMs: 5_000,
        env: { DEEPSEEK_GATEWAY_CREDITS_COOLDOWN_SECONDS: "120" },
        credentialStores: {},
      }).creditsCooldownMs,
    ).toBe(5_000);
    expect(
      loadGatewayConfig({
        env: { DEEPSEEK_GATEWAY_CREDITS_COOLDOWN_SECONDS: " 120 " },
        credentialStores: {},
      }).creditsCooldownMs,
    ).toBe(120_000);
    expect(
      loadGatewayConfig({
        env: { DEEPSEEK_GATEWAY_CREDITS_COOLDOWN_SECONDS: "0" },
        credentialStores: {},
      }).creditsCooldownMs,
    ).toBe(0);
  });

  it.each(["3601", "-1", "1.5"])("rejects invalid cooldown %s", (value) => {
    expect(() =>
      loadGatewayConfig({
        env: { DEEPSEEK_GATEWAY_CREDITS_COOLDOWN_SECONDS: value },
        credentialStores: {},
      }),
    ).toThrow(/cooldown/i);
  });

  it("configures gateway concurrency capacity", () => {
    expect(
      loadGatewayConfig({
        env: {
          DEEPSEEK_GATEWAY_MAX_CONCURRENT_REQUESTS: "200",
          DEEPSEEK_GATEWAY_MAX_PROVIDER_REQUESTS: "50",
          DEEPSEEK_GATEWAY_MAX_CRAWL_JOBS: "5",
          DEEPSEEK_GATEWAY_MAX_RETAINED_CRAWL_JOBS: "20",
        },
        credentialStores: {},
      }),
    ).toMatchObject({
      maxConcurrentRequests: 200,
      maxConcurrentProviderRequests: 50,
      maxActiveCrawlJobs: 5,
      maxRetainedCrawlJobs: 20,
    });
  });

  it.each([
    "DEEPSEEK_GATEWAY_MAX_CONCURRENT_REQUESTS",
    "DEEPSEEK_GATEWAY_MAX_PROVIDER_REQUESTS",
    "DEEPSEEK_GATEWAY_MAX_CRAWL_JOBS",
    "DEEPSEEK_GATEWAY_MAX_RETAINED_CRAWL_JOBS",
  ])("rejects invalid capacity %s", (name) => {
    expect(() =>
      loadGatewayConfig({
        env: { [name]: "0" },
        credentialStores: {},
      }),
    ).toThrow(/capacity|concurrent|job/i);
  });

  it("does not use FIRECRAWL_API_URL as the gateway upstream", () => {
    expect(
      loadGatewayConfig({
        env: {
          FIRECRAWL_API_URL: "http://127.0.0.1:8787",
          FIRECRAWL_UPSTREAM_URL: "https://firecrawl.example",
        },
        credentialStores: {},
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
        credentialStores: {},
      }),
    ).toThrow(message);
  });

  it.each([0, 65_536, 1.5])("rejects invalid port %s", (port) => {
    expect(() => loadGatewayConfig({ port, env: {}, credentialStores: {} })).toThrow(/port/i);
  });

  it("rejects a multiline gateway API key", () => {
    expect(() =>
      loadGatewayConfig({
        env: { GATEWAY_API_KEY: "gateway\nsecret" },
        credentialStores: {},
      }),
    ).toThrow(/newline/i);
  });
});
