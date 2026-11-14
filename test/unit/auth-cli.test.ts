import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/run.js";
import type { CredentialName, CredentialStore } from "../../src/credentials/store.js";
import { writer } from "../helpers/cli.js";

function memoryStore(initial?: string) {
  let value = initial;
  const store: CredentialStore & { value: () => string | undefined } = {
    name: "keychain",
    get: () => value,
    set: (next) => {
      value = next;
    },
    remove: () => {
      value = undefined;
    },
    value: () => value,
  };
  return store;
}

function dependencies(store: CredentialStore, env: NodeJS.ProcessEnv = {}) {
  const stdout = writer();
  const stderr = writer();
  return {
    deps: {
      env,
      fetchImpl: (async () => {
        throw new Error("auth commands must not use fetch");
      }) as unknown as typeof fetch,
      stdout,
      stderr,
      credentialStore: store,
    },
    stdout,
    stderr,
  };
}

function providerDependencies(
  stores: Partial<Record<CredentialName, CredentialStore>>,
  env: NodeJS.ProcessEnv = {},
) {
  const stdout = writer();
  const stderr = writer();
  return {
    deps: {
      env,
      fetchImpl: (async () => {
        throw new Error("auth commands must not use fetch");
      }) as unknown as typeof fetch,
      stdout,
      stderr,
      credentialStores: stores,
    },
    stdout,
    stderr,
  };
}

describe("auth commands", () => {
  it("stores a secret without printing it", async () => {
    const store = memoryStore();
    const { deps, stdout, stderr } = dependencies(store);

    expect(
      await runCli(["auth", "set"], {
        ...deps,
        secretReader: async () => "new-secret",
      }),
    ).toBe(0);
    expect(store.value()).toBe("new-secret");
    expect(stdout.value()).toContain("saved");
    expect(stdout.value()).not.toContain("new-secret");
    expect(stderr.value()).not.toContain("new-secret");
  });

  it("reports environment precedence and Keychain source", async () => {
    const store = memoryStore("stored-secret");
    const environment = dependencies(store, { DEEPSEEK_API_KEY: "environment-secret" });

    expect(await runCli(["auth", "status", "--json"], environment.deps)).toBe(0);
    expect(JSON.parse(environment.stdout.value())).toEqual({
      configured: true,
      source: "environment",
      backend: "environment",
    });
    expect(environment.stdout.value()).not.toContain("environment-secret");

    const stored = dependencies(store);
    expect(await runCli(["auth", "status", "--json"], stored.deps)).toBe(0);
    expect(JSON.parse(stored.stdout.value())).toEqual({
      configured: true,
      source: "keychain",
      backend: "keychain",
    });
    expect(stored.stdout.value()).not.toContain("stored-secret");
  });

  it("removes the stored secret and reports missing status", async () => {
    const store = memoryStore("stored-secret");
    const { deps, stdout } = dependencies(store);

    expect(await runCli(["auth", "remove", "--json"], deps)).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual({ removed: true });
    expect(store.value()).toBeUndefined();

    const status = dependencies(store);
    expect(await runCli(["auth", "status"], status.deps)).toBe(0);
    expect(status.stdout.value()).toContain("not configured");
  });

  it("rejects an empty entered secret", async () => {
    const { deps, stderr } = dependencies(memoryStore());
    expect(
      await runCli(["auth", "set"], {
        ...deps,
        secretReader: async () => {
          throw new Error("DeepSeek API key is required.");
        },
      }),
    ).toBe(1);
    expect(stderr.value()).toContain("API key");
  });

  it("stores Firecrawl and gateway credentials in their provider stores", async () => {
    const deepseek = memoryStore();
    const firecrawl = memoryStore();
    const gateway = memoryStore();
    const environment = providerDependencies({ deepseek, firecrawl, gateway });
    let secret = "firecrawl-secret";
    const secretReader = async () => secret;

    expect(
      await runCli(["auth", "set", "firecrawl"], {
        ...environment.deps,
        secretReader,
      }),
    ).toBe(0);
    secret = "gateway-secret";
    expect(
      await runCli(["auth", "set", "gateway"], {
        ...environment.deps,
        secretReader,
      }),
    ).toBe(0);

    expect(deepseek.value()).toBeUndefined();
    expect(firecrawl.value()).toBe("firecrawl-secret");
    expect(gateway.value()).toBe("gateway-secret");
    expect(environment.stdout.value()).toContain("Firecrawl API key saved");
    expect(environment.stdout.value()).toContain("gateway API key saved");
    expect(environment.stdout.value()).not.toContain("firecrawl-secret");
    expect(environment.stdout.value()).not.toContain("gateway-secret");
  });

  it("reports provider-specific environment and stored status", async () => {
    const gateway = memoryStore("stored-gateway");
    const stored = providerDependencies({ gateway });

    expect(await runCli(["auth", "status", "gateway", "--json"], stored.deps)).toBe(0);
    expect(JSON.parse(stored.stdout.value())).toEqual({
      configured: true,
      source: "keychain",
      backend: "keychain",
    });

    const environment = providerDependencies(
      { gateway },
      { GATEWAY_API_KEY: "environment-gateway" },
    );
    expect(await runCli(["auth", "status", "gateway", "--json"], environment.deps)).toBe(0);
    expect(JSON.parse(environment.stdout.value())).toMatchObject({
      configured: true,
      source: "environment",
    });
    expect(environment.stdout.value()).not.toContain("environment-gateway");
  });
});
