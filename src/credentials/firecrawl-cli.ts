import { readFileSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;

export interface FirecrawlCliCredential {
  apiKey: string;
  path: string;
}

export interface FirecrawlCliCredentialOptions {
  platform?: NodeJS.Platform;
  home?: string;
}

export function firecrawlCliCredentialsPath(options: FirecrawlCliCredentialOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  let configDirectory: string;
  switch (platform) {
    case "darwin":
      configDirectory = join(home, "Library", "Application Support", "firecrawl-cli");
      break;
    case "win32":
      configDirectory = join(home, "AppData", "Roaming", "firecrawl-cli");
      break;
    default:
      configDirectory = join(home, ".config", "firecrawl-cli");
      break;
  }
  return join(configDirectory, "credentials.json");
}

export function maskCredential(value: string): string {
  const credential = value.trim();
  if (credential.length <= 8) {
    return "********";
  }
  return `${credential.slice(0, 6)}...${credential.slice(-4)}`;
}

export function readFirecrawlCliCredential(
  options: FirecrawlCliCredentialOptions = {},
): FirecrawlCliCredential {
  const path = firecrawlCliCredentialsPath(options);
  let fileStat: Stats;
  try {
    fileStat = statSync(path);
  } catch (error) {
    throw new Error(
      `Firecrawl CLI credentials were not found at ${path}. Run firecrawl config first.`,
      { cause: error },
    );
  }
  if (!fileStat.isFile()) {
    throw new Error(`Firecrawl CLI credentials path is not a file: ${path}`);
  }
  if (fileStat.size > MAX_CREDENTIAL_FILE_BYTES) {
    throw new Error(`Firecrawl CLI credentials file is unexpectedly large: ${path}`);
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
    throw new Error(`Firecrawl CLI credentials must not be accessible by other users: ${path}`);
  }

  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Could not read Firecrawl CLI credentials at ${path}.`, { cause: error });
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`Firecrawl CLI credentials must contain an object: ${path}`);
  }
  const apiKey = (document as Record<string, unknown>).apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error(`Firecrawl CLI credentials do not contain a valid apiKey: ${path}`);
  }
  const normalized = apiKey.trim();
  if (/[\r\n]/.test(normalized)) {
    throw new Error("Firecrawl CLI apiKey must not contain a newline.");
  }
  return { apiKey: normalized, path };
}
