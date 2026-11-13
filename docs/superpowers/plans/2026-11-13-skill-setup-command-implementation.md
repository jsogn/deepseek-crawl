# Built-In Skill Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `deepseek-crawl setup skills` with a universal `.agents/skills` default plus optional Codex, Claude Code, and Cursor targets.

**Architecture:** Add one testable setup module that resolves Agent directories and installs the bundled Skill by symlink or copy. The CLI parses setup options and delegates to that module without loading DeepSeek configuration or making network requests.

**Tech Stack:** Node.js 22.12+, strict TypeScript/ESM, Vitest, Biome, filesystem APIs, and the bundled Agent Skill.

**Spec:** `docs/superpowers/specs/2026-11-13-skill-setup-command-design.md`

## Global Constraints

- Target version is exactly `0.4.0`.
- Default global target is `~/.agents/skills/deepseek-crawl`.
- Default project target is `<cwd>/.agents/skills/deepseek-crawl`.
- Optional Agent targets: `agents`, `codex`, `claude-code`, `cursor`, `all`.
- Global Codex honors `CODEX_HOME` and falls back to `~/.codex/skills`.
- Project Codex, Cursor, and universal targets use `.agents/skills`.
- Project Claude Code uses `.claude/skills`.
- Default mode is an absolute symlink; `--copy` uses staged recursive copy.
- Existing destinations fail without `--force`.
- Repeating the same symlink installation reports `unchanged`.
- Setup makes no network request and does not require `DEEPSEEK_API_KEY`.
- Never delete or replace a directory broader than the named `deepseek-crawl`
  target.
- Keep `npx skills add` documented as the cross-ecosystem route.

## File Structure

Create:

- `src/setup/skills.ts`
- `test/unit/skill-setup.test.ts`

Modify:

- `package.json`
- `package-lock.json`
- `src/version.ts`
- `src/cli/parse.ts`
- `src/cli/run.ts`
- `README.md`
- `skills/deepseek-crawl/SKILL.md`
- `test/smoke.test.ts`
- `test/unit/package.test.ts`
- `test/unit/cli-parse.test.ts`
- `test/unit/cli-run.test.ts`

---

### Task 1: Version 0.4.0

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/version.ts`
- Modify: `test/smoke.test.ts`
- Modify: `test/unit/package.test.ts`

**Interfaces:**

- Produces: `packageVersion === "0.4.0"`.

- [ ] **Step 1: Update failing version assertions**

```ts
expect(packageVersion).toBe("0.4.0");
```

Update the built executable assertion to `0.4.0`.

- [ ] **Step 2: Verify failure**

Run: `npm run test -- test/smoke.test.ts test/unit/package.test.ts`

Expected: FAIL with received `0.3.0`.

- [ ] **Step 3: Update package metadata**

Set `package.json` and `src/version.ts` to `0.4.0`, then run:

```bash
npm install --package-lock-only
```

- [ ] **Step 4: Run focused tests**

Run: `npm run test -- test/smoke.test.ts test/unit/package.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/version.ts test/smoke.test.ts test/unit/package.test.ts
git commit -m "chore: prepare v0.4.0 skill setup"
```

---

### Task 2: Agent Path Resolution and Installer

**Files:**

- Create: `src/setup/skills.ts`
- Create: `test/unit/skill-setup.test.ts`

**Interfaces:**

- Produces: `SkillAgent = "agents" | "codex" | "claude-code" | "cursor"`.
- Produces: `parseSkillAgents(value?: string): SkillAgent[]`.
- Produces: `resolveSkillTargets(options): ResolvedSkillTarget[]`.
- Produces: `setupSkills(options): Promise<SkillSetupResult>`.

```ts
export type SkillSetupScope = "global" | "project";

export interface ResolvedSkillTarget {
  agents: SkillAgent[];
  path: string;
}

export interface SkillSetupResult {
  version: 1;
  scope: SkillSetupScope;
  mode: "symlink" | "copy";
  source: string;
  installs: Array<ResolvedSkillTarget & {
    status: "installed" | "unchanged" | "replaced";
    mode: "symlink" | "copy";
  }>;
  restart_required: true;
}
```

- [ ] **Step 1: Write failing resolver tests**

Use temp directories and inject:

```ts
const result = resolveSkillTargets({
  agents: ["agents", "codex", "cursor"],
  scope: "global",
  home: "/Users/test",
  cwd: "/repo",
  env: {},
});
expect(result).toEqual([
  {
    agents: ["agents"],
    path: "/Users/test/.agents/skills/deepseek-crawl",
  },
  {
    agents: ["codex"],
    path: "/Users/test/.codex/skills/deepseek-crawl",
  },
  {
    agents: ["cursor"],
    path: "/Users/test/.cursor/skills/deepseek-crawl",
  },
]);
```

Add:

- `CODEX_HOME=/custom/codex` global Codex path.
- Project `agents`, `codex`, and `cursor` deduplicate to one target with all
  three Agent names.
- Project Claude path `.claude/skills`.
- `all` expansion.
- Unknown and empty Agent rejection.

- [ ] **Step 2: Run resolver tests to verify failure**

Run: `npm run test -- test/unit/skill-setup.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement path resolution**

Use `node:path` and `node:os`. Do not access the real home in tests.

Agent-specific base directories:

```ts
globalBase = {
  agents: join(home, ".agents"),
  codex: join(env.CODEX_HOME?.trim() || join(home, ".codex")),
  "claude-code": join(home, ".claude"),
  cursor: join(home, ".cursor"),
}

projectBase = {
  agents: join(cwd, ".agents"),
  codex: join(cwd, ".agents"),
  "claude-code": join(cwd, ".claude"),
  cursor: join(cwd, ".agents"),
}
```

Group Agents by final path while preserving canonical Agent order.

- [ ] **Step 4: Write failing symlink/copy tests**

Build a temp package:

```text
<temp>/skills/deepseek-crawl/
  SKILL.md
  references/cli-reference.md
```

Tests:

- Install default symlink and assert an absolute symlink.
- Repeat and assert `unchanged`.
- Install copy and assert copied files.
- Existing file/directory fails without `--force`.
- `--force` replaces only `skills/deepseek-crawl`.
- Missing source fails without creating a target.

- [ ] **Step 5: Implement atomic installation**

For symlink mode:

1. Create the destination parent.
2. Inspect an existing destination.
3. If it is a symlink with the same resolved source, return `unchanged`.
4. Otherwise fail unless force.
5. Create a temporary symlink in the destination parent.
6. Rename it into place.

For copy mode:

1. Use a hidden staging directory beside the destination.
2. Copy recursively with `fs.cp`.
3. Rename staging to the destination.
4. Clean only the staging directory on failure.

- [ ] **Step 6: Run setup module tests**

Run: `npm run test -- test/unit/skill-setup.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/setup/skills.ts test/unit/skill-setup.test.ts
git commit -m "feat: add cross-agent skill installer"
```

---

### Task 3: CLI `setup skills`

**Files:**

- Modify: `src/cli/parse.ts`
- Modify: `src/cli/run.ts`
- Modify: `test/unit/cli-parse.test.ts`
- Modify: `test/unit/cli-run.test.ts`

**Interfaces:**

- Produces command kind `setup-skills`.
- Consumes `setupSkills` from the setup module.

Parser result:

```ts
{
  kind: "setup-skills",
  scope: "global" | "project",
  agents: SkillAgent[],
  copy: boolean,
  force: boolean,
  json: boolean,
}
```

- [ ] **Step 1: Write failing parser tests**

```ts
expect(parseCli(["setup", "skills"])).toEqual({
  kind: "setup-skills",
  scope: "global",
  agents: ["agents"],
  copy: false,
  force: false,
  json: false,
});

expect(
  parseCli([
    "setup",
    "skills",
    "--project",
    "--agent",
    "codex,cursor",
    "--copy",
    "--force",
    "--json",
  ]),
).toEqual({
  kind: "setup-skills",
  scope: "project",
  agents: ["codex", "cursor"],
  copy: true,
  force: true,
  json: true,
});
```

Add rejection for both scopes, unknown Agent, missing setup subcommand, and
unknown setup option.

- [ ] **Step 2: Verify parser failure**

Run: `npm run test -- test/unit/cli-parse.test.ts`

Expected: FAIL because `setup` is unknown.

- [ ] **Step 3: Implement nested setup parsing**

`setup` requires `skills` as the first positional. Parse:

```text
--global, -g
--project, -p
--agent, -a <list>
--copy
--force
--json
--help, -h
```

Default scope is global. Parse comma-separated Agent values through
`parseSkillAgents`.

Add help:

```text
deepseek-crawl setup skills [options]
```

- [ ] **Step 4: Write failing CLI run tests**

Inject setup dependencies:

```ts
setupEnvironment?: {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  packageRoot: string;
}
```

Test human output, JSON output, and that missing `DEEPSEEK_API_KEY` does not
block setup.

- [ ] **Step 5: Implement CLI execution**

Resolve package root from the compiled CLI module:

```ts
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
```

Call `setupSkills` with the bundled `skills/deepseek-crawl` source. Do not call
`loadConfig`.

Human output lists grouped Agent names and paths. JSON output prints the setup
result.

- [ ] **Step 6: Run CLI tests**

Run: `npm run test -- test/unit/cli-parse.test.ts test/unit/cli-run.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/parse.ts src/cli/run.ts test/unit/cli-parse.test.ts test/unit/cli-run.test.ts
git commit -m "feat: add skill setup command"
```

---

### Task 4: Documentation, Skill Guidance, and Final Verification

**Files:**

- Modify: `README.md`
- Modify: `skills/deepseek-crawl/SKILL.md`
- Modify: `test/unit/package.test.ts`

**Interfaces:**

- Consumes the CLI from Task 3.
- Produces complete install documentation and package verification.

- [ ] **Step 1: Add failing documentation assertions**

Require README to contain:

```ts
[
  "deepseek-crawl setup skills",
  "~/.agents/skills/deepseek-crawl",
  "--agent codex",
  "npx skills add jsogn/deepseek-crawl",
]
```

- [ ] **Step 2: Verify documentation failure**

Run: `npm run test -- test/unit/package.test.ts`

Expected: FAIL until README is updated.

- [ ] **Step 3: Update README install flow**

Primary:

```bash
npm install -g deepseek-crawl
deepseek-crawl setup skills
deepseek-crawl doctor
```

Document:

- Universal default path.
- `--project`.
- `--agent codex`.
- `--agent claude-code,cursor`.
- `--copy`.
- `--force`.
- `npx skills add jsogn/deepseek-crawl --skill deepseek-crawl`.
- Starting a new Agent session after installation.

- [ ] **Step 4: Update the bundled Skill**

Add installation recovery:

```text
If the CLI is installed but this Skill is unavailable, run
`deepseek-crawl setup skills`.
```

Do not duplicate the full installer documentation in the Skill entrypoint.

- [ ] **Step 5: Run full verification**

Run: `npm run verify`

Expected:

- 25 or more test files pass.
- Package reports `deepseek-crawl@0.4.0`.
- Package includes `skills/deepseek-crawl`.

Run:

```bash
/tmp/deepseek-crawl-skill-validator/bin/python \
  /Users/alone/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  skills/deepseek-crawl
```

Expected: `Skill is valid!`.

- [ ] **Step 6: Smoke-test against a temporary home**

```bash
tmp=$(mktemp -d /tmp/deepseek-setup.XXXXXX)
HOME="$tmp" node dist/bin.js setup skills --json
test -L "$tmp/.agents/skills/deepseek-crawl"
HOME="$tmp" node dist/bin.js setup skills --agent codex --json
test -L "$tmp/.codex/skills/deepseek-crawl"
```

Expected: both commands exit `0` and create the expected links.

- [ ] **Step 7: Commit**

```bash
git add README.md skills/deepseek-crawl/SKILL.md test/unit/package.test.ts
git commit -m "docs: document one-command skill setup"
```

---

### Task 5: Merge and Push

- [ ] **Step 1: Run branch verification**

Run: `npm run verify`

- [ ] **Step 2: Merge**

```bash
git switch main
git merge --ff-only codex/skill-setup
npm run verify
```

- [ ] **Step 3: Push**

```bash
git push origin main
```

- [ ] **Step 4: Wait for GitHub Actions**

Confirm the CI run for the new `main` SHA succeeds.

## Spec Coverage Review

- Version and standard paths: Tasks 1-3.
- Agent selection and deduplication: Tasks 2-3.
- Symlink/copy/force/idempotency: Task 2.
- CLI human/JSON/no-key behavior: Task 3.
- Documentation, Skill recovery, pack, and CI: Tasks 4-5.

## Acceptance Checklist

- [ ] `deepseek-crawl setup skills` defaults to `~/.agents/skills`.
- [ ] `--agent codex` installs only to `$CODEX_HOME/skills` or `~/.codex/skills`.
- [ ] `--project` installs inside `.agents/skills`.
- [ ] `--agent claude-code,cursor` works.
- [ ] `--copy` and `--force` work.
- [ ] Re-running default setup is idempotent.
- [ ] No API key or network is needed.
- [ ] Version is `0.4.0`.
- [ ] `npm run verify`, skill validation, CI, and push succeed.
