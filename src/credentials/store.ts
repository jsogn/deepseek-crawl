import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type CredentialBackend = "keychain" | "file";
export type CredentialName = "deepseek" | "firecrawl" | "gateway";

export interface CredentialStore {
  readonly name: CredentialBackend;
  get(): string | undefined;
  set(apiKey: string): void;
  remove(): void;
}

interface SecurityCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type SecurityCommandRunner = (args: string[], input?: string) => SecurityCommandResult;

export interface CredentialStoreOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  securityPath?: string;
  runCommand?: SecurityCommandRunner;
  filePath?: string;
  credential?: CredentialName;
}

const DEFAULT_CREDENTIAL: CredentialName = "deepseek";
const KEYCHAIN_SERVICE = "deepseek-crawl";
const FILE_FIELDS: Record<CredentialName, string> = {
  deepseek: "api_key",
  firecrawl: "firecrawl_api_key",
  gateway: "gateway_api_key",
};

function credentialLabel(credential: CredentialName): string {
  switch (credential) {
    case "deepseek":
      return "DeepSeek API key";
    case "firecrawl":
      return "Firecrawl API key";
    case "gateway":
      return "gateway API key";
  }
}

function keychainAccount(credential: CredentialName): string {
  return credential === "deepseek" ? "api-key" : `${credential}-api-key`;
}

function validateStoredKey(value: string, credential: CredentialName): string {
  const apiKey = value.trim();
  if (!apiKey) {
    throw new Error(`Stored ${credentialLabel(credential)} is empty.`);
  }
  if (/[\r\n]/.test(apiKey)) {
    throw new Error(`Stored ${credentialLabel(credential)} must not contain a newline.`);
  }
  return apiKey;
}

function fileCredentialsPath(home: string, env: NodeJS.ProcessEnv): string {
  const configuredRoot = env.XDG_CONFIG_HOME?.trim();
  const configRoot = configuredRoot
    ? isAbsolute(configuredRoot)
      ? configuredRoot
      : resolve(home, configuredRoot)
    : join(home, ".config");
  return join(configRoot, "deepseek-crawl", "credentials.json");
}

function readFileDocument(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Credential file must contain an object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Could not read DeepSeek CLI credentials at ${path}.`, { cause: error });
  }
}

function writeFileDocument(path: string, document: Record<string, unknown>): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = join(directory, `.credentials.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function createFileStore(path: string, credential: CredentialName): CredentialStore {
  const field = FILE_FIELDS[credential];
  return {
    name: "file",
    get() {
      const document = readFileDocument(path);
      const value = document[field];
      if (value === undefined) {
        return undefined;
      }
      if (typeof value !== "string") {
        throw new Error(`${field} must be a string.`);
      }
      return validateStoredKey(value, credential);
    },
    set(apiKey: string) {
      const document = readFileDocument(path);
      document[field] = validateStoredKey(apiKey, credential);
      writeFileDocument(path, document);
    },
    remove() {
      const document = readFileDocument(path);
      delete document[field];
      if (Object.keys(document).length === 0) {
        rmSync(path, { force: true });
      } else {
        writeFileDocument(path, document);
      }
    },
  };
}

function defaultSecurityRunner(securityPath: string): SecurityCommandRunner {
  return (args, input) => {
    const result = spawnSync(securityPath, args, {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

function createKeychainStore(
  runCommand: SecurityCommandRunner,
  credential: CredentialName,
): CredentialStore {
  const account = keychainAccount(credential);
  return {
    name: "keychain",
    get() {
      const result = runCommand([
        "find-generic-password",
        "-a",
        account,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      if (result.status === 44) {
        return undefined;
      }
      if (result.status !== 0) {
        throw new Error(
          `Could not read ${credentialLabel(credential)} from Keychain: ${result.stderr.trim()}`,
        );
      }
      return validateStoredKey(result.stdout, credential);
    },
    set(apiKey: string) {
      const key = validateStoredKey(apiKey, credential);
      const result = runCommand(
        ["add-generic-password", "-U", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"],
        `${key}\n${key}\n`,
      );
      if (result.status !== 0) {
        throw new Error(
          `Could not store ${credentialLabel(credential)} in Keychain: ${result.stderr.trim()}`,
        );
      }
    },
    remove() {
      const result = runCommand(["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE]);
      if (result.status !== 0 && result.status !== 44) {
        throw new Error(
          `Could not remove ${credentialLabel(credential)} from Keychain: ${result.stderr.trim()}`,
        );
      }
    },
  };
}

export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const securityPath = options.securityPath ?? "/usr/bin/security";
  const credential = options.credential ?? DEFAULT_CREDENTIAL;
  if (platform === "darwin" && (options.runCommand !== undefined || existsSync(securityPath))) {
    return createKeychainStore(
      options.runCommand ?? defaultSecurityRunner(securityPath),
      credential,
    );
  }
  return createFileStore(options.filePath ?? fileCredentialsPath(home, env), credential);
}
