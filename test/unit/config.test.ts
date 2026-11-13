import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("uses defaults", () => {
    const config = loadConfig({ DEEPSEEK_API_KEY: "test-key" });
    expect(config.baseUrl.href).toBe("https://api.deepseek.com/");
    expect(config.timeoutMs).toBe(60000);
    expect(config.maxRetries).toBe(2);
  });

  it("allows HTTP only for loopback", () => {
    expect(() =>
      loadConfig({
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "http://127.0.0.1:8080",
      }),
    ).not.toThrow();

    expect(() =>
      loadConfig({
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "http://example.com",
      }),
    ).toThrow(/HTTPS/);
  });

  it("accepts localhost and IPv6 loopback over HTTP", () => {
    expect(
      loadConfig({
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "http://localhost:8080",
      }).baseUrl.href,
    ).toBe("http://localhost:8080/");

    expect(
      loadConfig({
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "http://[::1]:8080",
      }).baseUrl.href,
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
    expect(() => loadConfig(env)).toThrow(message);
  });
});
