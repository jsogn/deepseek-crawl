# Built-In Skill Setup Command Design

Date: 2026-11-13

Status: Approved

Target version: `0.4.0`

## Summary

Add `deepseek-crawl setup skills` so users can install the bundled
`deepseek-crawl` Agent Skill immediately after installing the CLI. Installation
uses the cross-Agent `.agents/skills` convention. The default is global
`~/.agents/skills`; project installation uses `.agents/skills` in the current
workspace.

The repository continues to support the universal ecosystem command:

```bash
npx skills add jsogn/deepseek-crawl --skill deepseek-crawl
```

The built-in setup command avoids requiring a separate installer for ordinary
CLI users.

## Goals

- Make the normal Agent path two commands:
  `npm install -g deepseek-crawl`, then `deepseek-crawl setup skills`.
- Reuse the Skill files already bundled in the installed npm package.
- Support global and project scope without shell copy instructions.
- Install once into the common `.agents/skills` directory used across Agents.
- Make updates predictable through symlink mode by default.
- Never overwrite an unrelated existing skill without `--force`.
- Keep behavior testable without writing to the real home directory.
- Preserve `npx skills add` as a cross-ecosystem option.

## Non-goals

- Installing the CLI itself.
- Installing into Agent-specific private directories such as `.codex/skills`,
  `.claude/skills`, or `.cursor/skills`.
- Editing Agent configuration files or enabling/disabling Skills.
- Installing MCP configuration.
- Publishing to the OpenAI plugin directory.
- Background update checks.

## Public Interface

```text
deepseek-crawl setup skills
  [--global | --project]
  [--copy]
  [--force]
  [--json]
```

Defaults:

- Scope: global.
- Mode: symlink the bundled Skill directory.
- Existing destination: fail without `--force`.

## Install Paths

Global:

```text
~/.agents/skills/deepseek-crawl
```

Project:

```text
<cwd>/.agents/skills/deepseek-crawl
```

Agent-specific directories are not managed by this command.

## Source Resolution

The Skill source is the package's bundled directory:

```text
<package-root>/skills/deepseek-crawl
```

The setup code resolves the package root relative to its compiled module, not
the caller's current directory. Tests inject a package root.

The setup command does not download the Skill from GitHub. The installed CLI and
Skill stay version-aligned.

## Install Behavior

### Symlink Mode

Default:

1. Create parent directories.
2. Create a temporary symlink beside the destination.
3. Rename the temporary symlink to the final destination.
4. Do not replace an existing destination unless `--force`.

The symlink target is absolute so Agent working directories do not affect
resolution.

### Copy Mode

`--copy` copies the complete Skill directory, including `agents/` and
`references/`, into a hidden staging directory and renames it into place.

Existing destinations fail unless `--force`.

### Existing Destination

- If the destination is the same symlink target and mode, report `unchanged`.
- Otherwise fail with exit `1` and explain how to use `--force`.
- With `--force`, replace only the named `deepseek-crawl` skill directory.
- The command never deletes a broader Agent skills directory.

### Idempotency

Repeated default setup returns success and reports `unchanged`. It does not
create duplicate links.

## Output

Human:

```text
Installed DeepSeek Crawl Skill:
- /Users/me/.agents/skills/deepseek-crawl (symlink)

Start a new Agent session to use the Skill.
```

JSON:

```json
{
  "version": 1,
  "scope": "global",
  "mode": "symlink",
  "source": "/path/to/package/skills/deepseek-crawl",
  "installs": [
    {
      "path": "/Users/me/.agents/skills/deepseek-crawl",
      "status": "installed",
      "mode": "symlink"
    }
  ],
  "restart_required": true
}
```

Status values are `installed`, `unchanged`, and, with `--force`, `replaced`.

## Parsing and Errors

- `--global` and `--project` together are a usage error.
- Empty `setup skills` is valid with defaults.
- Missing bundled Skill source is a runtime error and exit `1`.
- Filesystem permission and symlink failures exit `1`.
- Setup does not require `DEEPSEEK_API_KEY` and does not make network requests.
- `--json` writes one machine-readable object to stdout; errors remain on stderr.

## Architecture

```text
CLI parser ─> setup command
                    │
                    ├─> standard `.agents/skills` path resolver
                    ├─> bundled source resolver
                    └─> copy/symlink installer
```

New files:

```text
src/setup/skills.ts
test/unit/skill-setup.test.ts
```

Modified files:

```text
src/cli/parse.ts
src/cli/run.ts
src/version.ts
package.json
package-lock.json
README.md
skills/deepseek-crawl/SKILL.md
test/unit/cli-parse.test.ts
test/unit/cli-run.test.ts
test/unit/package.test.ts
test/smoke.test.ts
```

The installer receives explicit `home`, `cwd`, `env`, and package-root
dependencies so tests never touch the user's real skills directories.

## Documentation

README primary install flow becomes:

```bash
npm install -g deepseek-crawl
deepseek-crawl setup skills
deepseek-crawl doctor
```

Also document:

- `--project`.
- `--copy`.
- `--force`.
- `npx skills add jsogn/deepseek-crawl --skill deepseek-crawl`.
- Starting a new Agent session after installation.

The bundled Skill tells users to run `deepseek-crawl setup skills` if the Skill
files are available but not installed.

## Testing

Offline tests cover:

- Global and project `.agents/skills` path resolution.
- Default symlink installation.
- Copy installation.
- Idempotent unchanged result.
- Existing conflict without `--force`.
- Forced replacement.
- Usage errors and no network/API key requirement.
- CLI human/JSON output.
- Package version `0.4.0` and bundled Skill inclusion.

## Acceptance Criteria

- `deepseek-crawl setup skills` installs globally into `~/.agents/skills`.
- Re-running the command is safe and idempotent.
- `--project`, `--copy`, `--force`, and `--json` work as specified.
- No command can remove or replace a directory outside the named Skill path.
- `npm run verify` passes.
- Skill validator passes.
- CI passes after merge and push.
