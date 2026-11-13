import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { CredentialStore } from "../../src/credentials/store.js";

function store(value?: string): CredentialStore {
  return {
    name: "keychain",
    get: () => value,
    set: () => undefined,
    remove: () => undefined,
  };
}

describe("loadConfig", () => {
  it("uses defaults", () => {
    const config = loadConfig({ DEEPSEEK_API_KEY: "test-key" }, store());
    expect(config.baseUrl.href).toBe("https://api.deepseek.com/");
    expect(config.timeoutMs).toBe(60000);
    expect(config.maxRetries).toBe(2);
    expect(config.credentialSource).toBe("environment");
  });

  it("uses a stored credential when the environment is missing", () => {
    expect(loadConfig({}, store("stored-key"))).toMatchObject({
      apiKey: "stored-key",
      credentialSource: "keychain",
    });
  });

  it("prefers the environment over a stored credential", () => {
    expect(loadConfig({ DEEPSEEK_API_KEY: "environment-key" }, store("stored-key"))).toMatchObject({
      apiKey: "environment-key",
      credentialSource: "environment",
    });
  });

  it("allows HTTP only for loopback", () => {
    expect(() =>
      loadConfig(
        {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: "http://127.0.0.1:8080",
        },
        store(),
      ),
    ).not.toThrow();

    expect(() =>
      loadConfig(
        {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: "http://example.com",
        },
        store(),
      ),
    ).toThrow(/HTTPS/);
  });

  it("accepts localhost and IPv6 loopback over HTTP", () => {
    expect(
      loadConfig(
        {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: "http://localhost:8080",
        },
        store(),
      ).baseUrl.href,
    ).toBe("http://localhost:8080/");

    expect(
      loadConfig(
        {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: "http://[::1]:8080",
        },
        store(),
      ).baseUrl.href,
    ).toBe("http://[::1]:8080/");
  });

  it.each([
    [{}, /DEEPSEEK_API_KEY/],
    [{ DEEPSEEK_API_KEY: "a\nb" }, /newline/],
    [{ DEEPSEEK_API_KEY: "key", DEEPSEEK_TIMEOUT_MS: "999" }, /timeout/i],
    [{ DEEPSEEK_API_KEY: "key", DEEPSEEK_TIMEOUT_MS: "120001" }, /timeout/i],
    [{ DEEPSEEK_API_KEY: "key", DEEPSEEK_MAX_RETRIES: "6" }, /retries/i],
    [{ DEEPSEEK_API_KEY: "key", DEEPSEEK_BASE_URL: "ftp://example.com" }, /HTTP/],
  ])("rejects invalid environment %#", (env, message) => {
    expect(() => loadConfig(env, store())).toThrow(message);
  });

  it("rejects a multiline stored key", () => {
    expect(() => loadConfig({}, store("stored\nkey"))).toThrow(/newline/i);
  });
});
