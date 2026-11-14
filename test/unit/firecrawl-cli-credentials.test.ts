import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  firecrawlCliCredentialsPath,
  maskCredential,
  readFirecrawlCliCredential,
} from "../../src/credentials/firecrawl-cli.js";

describe("Firecrawl CLI credentials", () => {
  it("resolves the same platform-specific locations as the Firecrawl CLI", () => {
    expect(firecrawlCliCredentialsPath({ platform: "darwin", home: "/home/test" })).toBe(
      "/home/test/Library/Application Support/firecrawl-cli/credentials.json",
    );
    expect(firecrawlCliCredentialsPath({ platform: "linux", home: "/home/test" })).toBe(
      "/home/test/.config/firecrawl-cli/credentials.json",
    );
    expect(firecrawlCliCredentialsPath({ platform: "win32", home: "/home/test" })).toBe(
      "/home/test/AppData/Roaming/firecrawl-cli/credentials.json",
    );
  });

  it("reads a private Firecrawl CLI credential", async () => {
    const home = await mkdtemp(join(tmpdir(), "firecrawl-cli-credentials-"));
    const directory = join(home, ".config", "firecrawl-cli");
    const path = join(directory, "credentials.json");
    await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify({ apiKey: "fc-private-test-key" }), {
      mode: 0o600,
    });
    await chmod(path, 0o600);

    expect(readFirecrawlCliCredential({ platform: "linux", home })).toEqual({
      apiKey: "fc-private-test-key",
      path,
    });
  });

  it("rejects credential files accessible by other users", async () => {
    const home = await mkdtemp(join(tmpdir(), "firecrawl-cli-insecure-"));
    const directory = join(home, ".config", "firecrawl-cli");
    const path = join(directory, "credentials.json");
    await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify({ apiKey: "fc-insecure-test-key" }), {
      mode: 0o600,
    });
    await chmod(path, 0o644);

    expect(() => readFirecrawlCliCredential({ platform: "linux", home })).toThrow(
      /accessible by other users/i,
    );
  });

  it("rejects missing, malformed, and empty credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "firecrawl-cli-invalid-"));
    expect(() => readFirecrawlCliCredential({ platform: "linux", home })).toThrow(/not found/i);

    const directory = join(home, ".config", "firecrawl-cli");
    const path = join(directory, "credentials.json");
    await mkdir(directory, { recursive: true });
    await writeFile(path, "not-json", { mode: 0o600 });
    await chmod(path, 0o600);
    expect(() => readFirecrawlCliCredential({ platform: "linux", home })).toThrow(
      /could not read/i,
    );

    await writeFile(path, JSON.stringify({ apiKey: "   " }), { mode: 0o600 });
    await chmod(path, 0o600);
    expect(() => readFirecrawlCliCredential({ platform: "linux", home })).toThrow(/valid apiKey/i);
  });

  it("masks credential hints without exposing short secrets", () => {
    expect(maskCredential("fc-1234567890abcdef1234567890abcdef")).toBe("fc-123...cdef");
    expect(maskCredential("short")).toBe("********");
  });
});
