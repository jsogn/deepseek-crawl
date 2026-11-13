import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readSecret } from "../../src/credentials/input.js";
import { createCredentialStore } from "../../src/credentials/store.js";

describe("file credential store", () => {
  it("stores, reads, secures, and removes the credential", async () => {
    const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-auth-"));
    const store = createCredentialStore({
      platform: "linux",
      home,
      env: { XDG_CONFIG_HOME: join(home, "config") },
    });
    const path = join(home, "config", "deepseek-crawl", "credentials.json");

    expect(store.name).toBe("file");
    expect(store.get()).toBeUndefined();
    store.set("stored-secret");
    expect(store.get()).toBe("stored-secret");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ api_key: "stored-secret" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    store.remove();
    expect(store.get()).toBeUndefined();
  });

  it("rejects malformed credential files", async () => {
    const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-auth-"));
    const directory = join(home, "config", "deepseek-crawl");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "credentials.json"), "not-json", "utf8");
    const store = createCredentialStore({
      platform: "linux",
      home,
      env: { XDG_CONFIG_HOME: join(home, "config") },
    });

    expect(() => store.get()).toThrow(/credential/i);
  });
});

describe("Keychain credential store", () => {
  it("uses security stdin for storage and treats missing items as unconfigured", () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const store = createCredentialStore({
      platform: "darwin",
      runCommand: (args, input) => {
        calls.push(input === undefined ? { args } : { args, input });
        if (args[0] === "find-generic-password") {
          return { status: 0, stdout: "stored-secret\n", stderr: "" };
        }
        if (args[0] === "delete-generic-password") {
          return { status: 44, stdout: "", stderr: "not found" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(store.name).toBe("keychain");
    expect(store.get()).toBe("stored-secret");
    store.set("stored-secret");
    expect(calls.at(-1)?.args.join(" ")).not.toContain("stored-secret");
    expect(calls.at(-1)?.input).toBe("stored-secret\nstored-secret\n");
    expect(() => store.remove()).not.toThrow();
  });
});

describe("readSecret", () => {
  it("reads a piped secret without echoing it", async () => {
    const stdin = new PassThrough();
    stdin.end("piped-secret\n");
    let stderr = "";
    const output = new Writable({
      write(chunk, _encoding, callback) {
        stderr += String(chunk);
        callback();
      },
    });

    await expect(readSecret({ stdin, stderr: output })).resolves.toBe("piped-secret");
    expect(stderr).not.toContain("piped-secret");
  });

  it.each(["", "\n", "line-one\nline-two\n"])("rejects invalid piped input", async (value) => {
    const stdin = new PassThrough();
    stdin.end(value);
    const stderr = new PassThrough();

    await expect(readSecret({ stdin, stderr })).rejects.toThrow(/key/i);
  });
});
