import type { CliDependencies } from "../../src/cli/run.js";

export interface TextWriter {
  write(chunk: string): boolean;
  value(): string;
}

export function writer(): TextWriter {
  let value = "";
  return {
    write(chunk) {
      value += chunk;
      return true;
    },
    value: () => value,
  };
}

export function cliDependencies(
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "key" },
): {
  deps: Pick<CliDependencies, "env" | "fetchImpl" | "stdout" | "stderr" | "credentialStore">;
  stdout: TextWriter;
  stderr: TextWriter;
} {
  const stdout = writer();
  const stderr = writer();
  const credentialStore = {
    name: "keychain" as const,
    get: () => undefined,
    set: () => undefined,
    remove: () => undefined,
  };
  return {
    deps: { env, fetchImpl, stdout, stderr, credentialStore },
    stdout,
    stderr,
  };
}
