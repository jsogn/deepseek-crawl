# CLI-Managed API Credentials Design

Date: 2026-11-14

Status: Approved

Target version: `0.5.0`

## Summary

Add CLI-managed DeepSeek API credential storage so users can configure once with
`deepseek-crawl auth set` and then run all commands without setting
`DEEPSEEK_API_KEY` in every shell or Agent session.

Credential resolution order:

1. `DEEPSEEK_API_KEY` environment variable.
2. CLI credential store.
3. Configuration error.

The macOS credential store is Keychain. Other platforms use a private user
configuration file with mode `0600`.

## Goals

- Persist the DeepSeek API key in a CLI-owned credential store.
- Never require the key as a CLI argument.
- Avoid echo and shell history exposure during interactive setup.
- Support setting, checking, and removing credentials.
- Keep environment variables as an explicit override.
- Keep offline tests isolated from the real Keychain and user config.
- Report only the credential source, never the key.

## Non-goals

- OAuth or browser login.
- Multiple DeepSeek accounts or profiles.
- Credential synchronization across machines.
- Key rotation against the DeepSeek service.
- Encrypting non-macOS storage with a separate master password.
- Reading project `.env` files.

## Commands

### Set

```text
deepseek-crawl auth set
```

Behavior:

- Read a non-empty secret from an interactive hidden prompt.
- When stdin is not a TTY, read one secret from stdin.
- Validate that the value contains no newline after trimming.
- Store it in the selected credential backend.
- Print a confirmation without the key.
- A second `auth set` replaces the stored value.

### Status

```text
deepseek-crawl auth status [--json]
```

Reports:

```json
{
  "configured": true,
  "source": "keychain",
  "backend": "keychain"
}
```

Sources:

- `environment`
- `keychain`
- `file`
- `missing`

It does not call DeepSeek and never prints the key.

### Remove

```text
deepseek-crawl auth remove [--json]
```

Removes the CLI-stored value. It does not remove an environment variable and
reports success when no stored value exists.

## Credential Store

```ts
export interface CredentialStore {
  readonly name: "keychain" | "file";
  get(): string | undefined;
  set(apiKey: string): void;
  remove(): void;
}

export function createCredentialStore(options?): CredentialStore;
```

### macOS Keychain

- Service: `deepseek-crawl`
- Account: `api-key`
- Uses `/usr/bin/security`.
- `get` uses `find-generic-password`.
- `set` passes key data through stdin to `add-generic-password -U`; the key is
  never placed in argv.
- `remove` uses `delete-generic-password`.
- Missing item is treated as unconfigured.

### File Fallback

Path:

```text
$XDG_CONFIG_HOME/deepseek-crawl/credentials.json
```

or:

```text
~/.config/deepseek-crawl/credentials.json
```

Content:

```json
{
  "api_key": "..."
}
```

The directory is created with user-only permissions. The file is written
atomically with mode `0600`. Existing unreadable or malformed files produce a
configuration error rather than exposing contents.

## Configuration Integration

`loadConfig` accepts an optional injected credential store. When
`DEEPSEEK_API_KEY` is non-empty, use it and do not read the store. Otherwise,
read the CLI store.

```ts
export interface ResolvedCredential {
  apiKey: string;
  source: "environment" | "keychain" | "file";
}
```

`RuntimeConfig` includes the source for status and doctor reporting. The API key
remains private.

CLI and Doctor tests inject an empty memory store by default so a developer's
real Keychain cannot alter offline behavior.

## Secret Input

`auth set` uses a secret reader that:

- Disables terminal echo for TTY input.
- Handles backspace and Ctrl+C.
- Restores terminal state in all paths.
- Reads and trims newline when stdin is piped.
- Never writes the key to stdout/stderr.

Tests inject a secret reader and never read the real terminal.

## CLI Surface

Main help adds:

```text
deepseek-crawl auth set
deepseek-crawl auth status [--json]
deepseek-crawl auth remove [--json]
```

Unknown auth subcommands and invalid options exit with usage code `2`.
Operational store failures exit `1`.

## Doctor

`doctor` continues to show `api_key: "configured"` and adds:

```json
{
  "credential_source": "keychain"
}
```

It never includes the key.

## Skill and Documentation

Skill prerequisite guidance becomes:

```text
If authentication is missing, ask the user to run:
deepseek-crawl auth set
```

README primary setup:

```bash
npm install -g deepseek-crawl
deepseek-crawl setup skills
deepseek-crawl auth set
deepseek-crawl doctor
```

Document environment override precedence and `auth remove`.

## Testing

Offline tests cover:

- Environment precedence over stored credentials.
- Memory/file/keychain store adapters with injected commands/filesystem.
- `auth set`, status, replacement, and removal.
- Hidden/piped secret input through injected readers.
- No key in output or errors.
- Missing credential error.
- Doctor source reporting.
- Existing tests inject empty stores.
- Version `0.5.0`.

## Acceptance Criteria

- `deepseek-crawl auth set` stores the key without echoing it.
- All commands automatically use the stored key.
- `DEEPSEEK_API_KEY` overrides the stored key.
- `auth status` reports only source/backend.
- `auth remove` deletes the CLI credential.
- Keychain and file fallback tests are isolated and offline.
- `npm run verify`, Skill validation, CI, and a real API call pass.
