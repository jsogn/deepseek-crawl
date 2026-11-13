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

export interface CredentialStore {
  readonly name: CredentialBackend;
  get(): string | undefined;
  set(apiKey: string): void;
  remove(): void;
}

export interface SecurityCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type SecurityCommandRunner = (args: string[], input?: string) => SecurityCommandResult;

export interface CredentialStoreOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  securityPath?: string;
  runCommand?: SecurityCommandRunner;
  filePath?: string;
}

const KEYCHAIN_ACCOUNT = "api-key";
const KEYCHAIN_SERVICE = "deepseek-crawl";

function validateStoredKey(value: string): string {
  const apiKey = value.trim();
  if (!apiKey) {
    throw new Error("Stored DeepSeek API key is empty.");
  }
  if (/[\r\n]/.test(apiKey)) {
    throw new Error("Stored DeepSeek API key must not contain a newline.");
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

function createFileStore(path: string): CredentialStore {
  return {
    name: "file",
    get() {
      if (!existsSync(path)) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { api_key?: unknown };
        if (typeof parsed.api_key !== "string") {
          throw new Error("api_key must be a string.");
        }
        return validateStoredKey(parsed.api_key);
      } catch (error) {
        throw new Error(`Could not read DeepSeek CLI credentials at ${path}.`, { cause: error });
      }
    },
    set(apiKey: string) {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const temporary = join(directory, `.credentials.${randomUUID()}.tmp`);
      try {
        writeFileSync(
          temporary,
          `${JSON.stringify({ api_key: validateStoredKey(apiKey) }, null, 2)}\n`,
          {
            encoding: "utf8",
            mode: 0o600,
          },
        );
        chmodSync(temporary, 0o600);
        renameSync(temporary, path);
        chmodSync(path, 0o600);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    },
    remove() {
      rmSync(path, { force: true });
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

function createKeychainStore(runCommand: SecurityCommandRunner): CredentialStore {
  return {
    name: "keychain",
    get() {
      const result = runCommand([
        "find-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      if (result.status === 44) {
        return undefined;
      }
      if (result.status !== 0) {
        throw new Error(`Could not read DeepSeek API key from Keychain: ${result.stderr.trim()}`);
      }
      return validateStoredKey(result.stdout);
    },
    set(apiKey: string) {
      const key = validateStoredKey(apiKey);
      const result = runCommand(
        ["add-generic-password", "-U", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"],
        `${key}\n${key}\n`,
      );
      if (result.status !== 0) {
        throw new Error(`Could not store DeepSeek API key in Keychain: ${result.stderr.trim()}`);
      }
    },
    remove() {
      const result = runCommand([
        "delete-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        KEYCHAIN_SERVICE,
      ]);
      if (result.status !== 0 && result.status !== 44) {
        throw new Error(`Could not remove DeepSeek API key from Keychain: ${result.stderr.trim()}`);
      }
    },
  };
}

export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const securityPath = options.securityPath ?? "/usr/bin/security";
  if (platform === "darwin" && (options.runCommand !== undefined || existsSync(securityPath))) {
    return createKeychainStore(options.runCommand ?? defaultSecurityRunner(securityPath));
  }
  return createFileStore(options.filePath ?? fileCredentialsPath(home, env));
}
