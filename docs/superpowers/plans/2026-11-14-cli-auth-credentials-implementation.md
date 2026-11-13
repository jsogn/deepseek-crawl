# CLI-Managed API Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `deepseek-crawl auth set/status/remove` with Keychain-first storage and automatic credential loading.

**Architecture:** Add a synchronous credential-store abstraction used by configuration loading, plus an async hidden secret reader used only by `auth set`. The CLI reports source/backend without exposing the secret. Tests inject stores and secret readers so offline verification never touches the real Keychain.

**Tech Stack:** Node.js 22.12+, strict TypeScript/ESM, Vitest, Biome, macOS `security`, and private XDG config files.

**Spec:** `docs/superpowers/specs/2026-11-14-cli-auth-credentials-design.md`

## Global Constraints

- Target version is exactly `0.5.0`.
- Credential priority: environment, then CLI store, then missing error.
- macOS backend is Keychain service/account `deepseek-crawl` / `api-key`.
- Other platforms use `$XDG_CONFIG_HOME/deepseek-crawl/credentials.json` or
  `~/.config/deepseek-crawl/credentials.json`.
- File storage is mode `0600`; parent directory is user-private.
- Never place the API key in CLI arguments, normal output, errors, logs, or Git.
- `auth set` must not echo a terminal secret.
- Setup, auth status, and auth remove make no DeepSeek network requests.
- Existing Search, Fetch, Map, Crawl, MCP, setup, and safety behavior remains.
- All tests remain offline.

## File Structure

Create:

- `src/credentials/store.ts`
- `src/credentials/input.ts`
- `test/unit/credentials.test.ts`
- `test/unit/auth-cli.test.ts`

Modify:

- `package.json`
- `package-lock.json`
- `src/version.ts`
- `src/config.ts`
- `src/cli/doctor.ts`
- `src/cli/parse.ts`
- `src/cli/run.ts`
- `src/index.ts`
- `README.md`
- `skills/deepseek-crawl/SKILL.md`
- `test/smoke.test.ts`
- `test/unit/package.test.ts`
- `test/unit/config.test.ts`
- `test/unit/cli-parse.test.ts`
- `test/unit/cli-run.test.ts`

---

### Task 1: Version 0.5.0

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/version.ts`
- Modify: `test/smoke.test.ts`
- Modify: `test/unit/package.test.ts`

**Interfaces:**

- Produces: `packageVersion === "0.5.0"`.

- [ ] **Step 1: Change failing assertions to `0.5.0`**

```ts
expect(packageVersion).toBe("0.5.0");
```

- [ ] **Step 2: Run focused tests**

Run: `npm run test -- test/smoke.test.ts test/unit/package.test.ts`

Expected: FAIL with `0.4.0`.

- [ ] **Step 3: Update version metadata**

Set `package.json` and `src/version.ts` to `0.5.0`, then:

```bash
npm install --package-lock-only
```

- [ ] **Step 4: Verify**

Run: `npm run test -- test/smoke.test.ts test/unit/package.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/version.ts test/smoke.test.ts test/unit/package.test.ts
git commit -m "chore: prepare v0.5.0 credential storage"
```

---

### Task 2: Credential Stores and Secret Input

**Files:**

- Create: `src/credentials/store.ts`
- Create: `src/credentials/input.ts`
- Create: `test/unit/credentials.test.ts`

**Interfaces:**

```ts
export type CredentialBackend = "keychain" | "file";

export interface CredentialStore {
  readonly name: CredentialBackend;
  get(): string | undefined;
  set(apiKey: string): void;
  remove(): void;
}

export interface CredentialStoreOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  securityPath?: string;
  runCommand?: SecurityCommandRunner;
  filePath?: string;
}

export function createCredentialStore(
  options?: CredentialStoreOptions,
): CredentialStore;
```

```ts
export interface SecretReaderOptions {
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
}

export function readSecret(options?: SecretReaderOptions): Promise<string>;
```

- [ ] **Step 1: Write failing file-store tests**

Use a temporary XDG directory:

```ts
const env = { XDG_CONFIG_HOME: join(root, "config") };
const store = createCredentialStore({
  platform: "linux",
  home: root,
  env,
});
expect(store.name).toBe("file");
expect(store.get()).toBeUndefined();
store.set("secret-value");
expect(store.get()).toBe("secret-value");
expect((await stat(storePath)).mode & 0o777).toBe(0o600);
store.remove();
expect(store.get()).toBeUndefined();
```

Add malformed-file coverage that rejects with a configuration error.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -- test/unit/credentials.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the file store**

Resolve:

```ts
const configRoot = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
const credentialsPath = join(configRoot, "deepseek-crawl", "credentials.json");
```

Use synchronous operations because configuration loading is synchronous:

- `readFileSync` and JSON parse for `get`.
- `mkdirSync` with mode `0700`.
- Atomic temporary file plus `renameSync`.
- `chmodSync(file, 0o600)`.
- `rmSync(..., { force: true })` for remove.

- [ ] **Step 4: Write failing Keychain adapter tests**

Inject a fake command runner:

```ts
const calls: Array<{ args: string[]; input?: string }> = [];
const store = createCredentialStore({
  platform: "darwin",
  runCommand: (args, input) => {
    calls.push({ args, input });
    return { status: 0, stdout: "stored-key\n", stderr: "" };
  },
});
expect(store.get()).toBe("stored-key");
store.set("stored-key");
expect(calls.at(-1)?.args).not.toContain("stored-key");
expect(calls.at(-1)?.input).toBe("stored-key\nstored-key\n");
```

Test exit status `44` as unconfigured for get/remove.

- [ ] **Step 5: Implement the Keychain store**

Use:

```text
/usr/bin/security find-generic-password
  -a api-key -s deepseek-crawl -w

/usr/bin/security add-generic-password
  -U -a api-key -s deepseek-crawl -w

/usr/bin/security delete-generic-password
  -a api-key -s deepseek-crawl
```

`add-generic-password -w` reads the secret and confirmation from stdin.

- [ ] **Step 6: Implement secret input**

For non-TTY stdin, read all chunks and trim one trailing newline.

For TTY:

- Write `DeepSeek API key: ` to stderr.
- Enable raw mode and suppress echo.
- Accept characters, backspace, Enter, and Ctrl+C.
- Restore raw mode and listeners in `finally`.
- Write a newline after entry.

Reject empty values and embedded newline/CR.

- [ ] **Step 7: Test piped secret input**

Create a `PassThrough` stream with `secret\n`, pass it as stdin, and assert:

```ts
expect(await readSecret({ stdin, stderr })).toBe("secret");
expect(stdoutAndStderr).not.toContain("secret");
```

- [ ] **Step 8: Run credential tests**

Run: `npm run test -- test/unit/credentials.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/credentials test/unit/credentials.test.ts
git commit -m "feat: add credential stores and secret input"
```

---

### Task 3: Configuration and Doctor Integration

**Files:**

- Modify: `src/config.ts`
- Modify: `src/cli/doctor.ts`
- Modify: `test/unit/config.test.ts`
- Modify: `test/unit/cli-run.test.ts`

**Interfaces:**

- `loadConfig(env, store?)`.
- `RuntimeConfig.credentialSource`.
- Production uses `createCredentialStore({ env })`.

- [ ] **Step 1: Write failing precedence tests**

Use a memory store:

```ts
const store = {
  name: "file" as const,
  get: () => "stored-key",
  set: () => undefined,
  remove: () => undefined,
};

expect(loadConfig({ DEEPSEEK_API_KEY: "env-key" }, store)).toMatchObject({
  apiKey: "env-key",
  credentialSource: "environment",
});
expect(loadConfig({}, store)).toMatchObject({
  apiKey: "stored-key",
  credentialSource: "file",
});
```

Add missing-store error coverage.

- [ ] **Step 2: Verify failure**

Run: `npm run test -- test/unit/config.test.ts`

Expected: FAIL because the store is not consumed.

- [ ] **Step 3: Implement resolution**

```ts
export interface ResolvedCredential {
  apiKey: string;
  source: "environment" | "keychain" | "file";
}

export function resolveCredential(
  env: NodeJS.ProcessEnv,
  store: CredentialStore = createCredentialStore({ env }),
): ResolvedCredential
```

Environment value is trimmed and validated first. Store values receive the same
newline validation. Missing values throw `DEEPSEEK_API_KEY is required.`

- [ ] **Step 4: Update Doctor**

Add `credential_source` to JSON and human output:

```json
{
  "api_key": "configured",
  "credential_source": "keychain"
}
```

Doctor accepts an injected credential store.

- [ ] **Step 5: Isolate existing tests**

The CLI test dependency helper provides an empty memory store by default.
Missing-key tests continue to fail before network access.

- [ ] **Step 6: Run configuration and CLI regression tests**

Run: `npm run test -- test/unit/config.test.ts test/unit/cli-run.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/cli/doctor.ts test/unit/config.test.ts test/unit/cli-run.test.ts
git commit -m "feat: load saved credentials automatically"
```

---

### Task 4: Auth CLI Commands

**Files:**

- Modify: `src/cli/parse.ts`
- Modify: `src/cli/run.ts`
- Modify: `src/index.ts`
- Create: `test/unit/auth-cli.test.ts`
- Modify: `test/unit/cli-parse.test.ts`

**Interfaces:**

- Parsed commands:
  - `auth-set`
  - `auth-status`
  - `auth-remove`
- CLI dependencies:

```ts
credentialStore?: CredentialStore;
secretReader?: () => Promise<string>;
```

- [ ] **Step 1: Write failing parser tests**

```ts
expect(parseCli(["auth", "set"])).toEqual({ kind: "auth-set" });
expect(parseCli(["auth", "status", "--json"])).toEqual({
  kind: "auth-status",
  json: true,
});
expect(parseCli(["auth", "remove", "--json"])).toEqual({
  kind: "auth-remove",
  json: true,
});
```

Reject missing/unknown subcommands and unsupported flags.

- [ ] **Step 2: Verify failure**

Run: `npm run test -- test/unit/cli-parse.test.ts`

Expected: FAIL because `auth` is unknown.

- [ ] **Step 3: Implement parser and help**

Add auth commands and main/help text.

- [ ] **Step 4: Write failing auth behavior tests**

Use an in-memory store and injected reader:

```ts
const result = await runCli(["auth", "set"], {
  ...deps,
  credentialStore: store,
  secretReader: async () => "new-secret",
});
expect(result).toBe(0);
expect(store.value).toBe("new-secret");
expect(stdout.value()).toContain("saved");
expect(stdout.value()).not.toContain("new-secret");
```

Test status precedence, JSON output, remove, and missing secret.

- [ ] **Step 5: Implement auth execution**

- `auth set`: call `deps.secretReader ?? readSecret`, validate, store.
- `auth status`: environment first, then store; report source and backend only.
- `auth remove`: call store.remove; report whether removed.
- All auth commands avoid `loadConfig` network operations.

Export credential types/functions from `src/index.ts`.

- [ ] **Step 6: Run auth and CLI tests**

Run: `npm run test -- test/unit/auth-cli.test.ts test/unit/cli-parse.test.ts test/unit/cli-run.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/parse.ts src/cli/run.ts src/index.ts test/unit/auth-cli.test.ts test/unit/cli-parse.test.ts
git commit -m "feat: add auth credential commands"
```

---

### Task 5: Documentation, Real Authentication, and Verification

**Files:**

- Modify: `README.md`
- Modify: `skills/deepseek-crawl/SKILL.md`
- Modify: `test/unit/package.test.ts`

- [ ] **Step 1: Add failing documentation checks**

Require:

```ts
[
  "deepseek-crawl auth set",
  "deepseek-crawl auth status",
  "deepseek-crawl auth remove",
  "DEEPSEEK_API_KEY",
  "macOS Keychain",
]
```

- [ ] **Step 2: Update README and Skill**

Primary install:

```bash
npm install -g deepseek-crawl
deepseek-crawl setup skills
deepseek-crawl auth set
deepseek-crawl doctor
```

Explain:

- Environment variable override.
- Keychain/file storage.
- No key in shell history.
- `auth status`.
- `auth remove`.

Skill recovery says to ask the user to run `deepseek-crawl auth set`.

- [ ] **Step 3: Run full offline verification**

Run: `npm run verify`

Expected:

- Package `0.5.0`.
- All tests pass.
- Skill bundled.

Run skill validator.

- [ ] **Step 4: Store the provided development key through the new CLI**

Use piped stdin once, without placing the key in argv:

```bash
printf '%s\n' "$DEEPSEEK_API_KEY" | deepseek-crawl auth set
```

Then verify:

```bash
unset DEEPSEEK_API_KEY
deepseek-crawl auth status --json
deepseek-crawl doctor --live --json
```

Expected: source `keychain`; live request passes.

- [ ] **Step 5: Test real commands without inline environment**

Run one small `search` and one `fetch` with saved credentials. Confirm outputs
are produced without `DEEPSEEK_API_KEY` in the command environment.

- [ ] **Step 6: Commit docs**

```bash
git add README.md skills/deepseek-crawl/SKILL.md test/unit/package.test.ts
git commit -m "docs: document CLI credential setup"
```

---

### Task 6: Merge and Push

- [ ] **Step 1: Merge**

```bash
git switch main
git merge --ff-only codex/cli-auth
```

- [ ] **Step 2: Verify merged result**

Run: `npm run verify`

- [ ] **Step 3: Push**

```bash
git push origin main
```

- [ ] **Step 4: Confirm CI**

Wait for the GitHub Actions run for the merged SHA to pass.

## Spec Coverage Review

- Credential precedence and CLI store: Tasks 2-4.
- Keychain and private file fallback: Task 2.
- Secret input and no leakage: Tasks 2 and 4.
- Auth commands/status/removal: Task 4.
- Doctor/configuration integration: Task 3.
- Docs, Skill, real live verification, merge and CI: Tasks 5-6.

## Acceptance Checklist

- [ ] Environment overrides stored credentials.
- [ ] Stored credentials work without repeated environment setup.
- [ ] macOS uses Keychain; no credentials file is created there.
- [ ] Secret never appears in argv or output.
- [ ] `auth set/status/remove` works.
- [ ] Version is `0.5.0`.
- [ ] Offline verification, Skill validation, and real API checks pass.
- [ ] Main is pushed and GitHub Actions succeeds.
