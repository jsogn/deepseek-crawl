# DeepSeek Crawl

Local CLI and MCP tools for DeepSeek's official Search and Fetch APIs.

The package provides one read-only interface over two operations:

- `search`: ranked web results, summaries, and optional page content.
- `fetch`: one public page as Markdown.

This project intentionally does not implement provider selection or fallback.
The user or calling AI decides when DeepSeek should be used.

## Status

Version `0.1.0` is implemented and locally verified. The npm package is
currently `private` and has no selected license, so it is not published to the
npm registry yet.

## Requirements

- Node.js 22.12 or newer.
- A DeepSeek API key from <https://platform.deepseek.com/api_keys>.

Search and Fetch are billed by DeepSeek per successful request. See
<https://api-docs.deepseek.com/guides/search/> for current pricing and limits.

## CLI

After the package is published:

```bash
npx -y deepseek-crawl@0.1.0 search "DeepSeek API"
npx -y deepseek-crawl@0.1.0 fetch "https://api-docs.deepseek.com/"
```

Install globally for frequent use:

```bash
npm install -g deepseek-crawl@0.1.0
deepseek-crawl search "DeepSeek API"
```

From this repository:

```bash
npm run build
DEEPSEEK_API_KEY=sk-... node dist/bin.js search "DeepSeek API"
```

### Search

```text
deepseek-crawl search <query>
  [--count <1..50>]
  [--content]
  [--max-content-chars <0..1000000>]
  [--ori-question <text>]
  [--localization <ip>]
  [--json]
  [--output <path>]
```

Human-readable output defaults to a 4000-character content limit per result.
`--json` preserves complete API content unless `--max-content-chars` is
explicitly supplied. `--output` always writes the complete result.
`--max-content-chars 0` disables truncation.

```bash
deepseek-crawl search "Hyperf 3.1 queue" --count 5 --json
deepseek-crawl search "DeepSeek release notes" --content --output results.json
```

### Fetch

```text
deepseek-crawl fetch <url>
  [--max-chars <0..1000000>]
  [--json]
  [--output <path>]
```

Human-readable output defaults to a 30000-character limit. `--output` writes
complete Markdown by default; combine it with `--json` to write JSON.

```bash
deepseek-crawl fetch "https://api-docs.deepseek.com/guides/search/" --output page.md
```

### Doctor

```bash
deepseek-crawl doctor
deepseek-crawl doctor --live --json
```

The default check does not make a billable DeepSeek request. `--live` performs
one Search request and prints a billing warning to stderr.

## MCP

Start MCP over stdio:

```bash
deepseek-crawl mcp
```

Generic MCP configuration:

```json
{
  "mcpServers": {
    "deepseek-crawl": {
      "command": "npx",
      "args": ["-y", "deepseek-crawl@0.1.0", "mcp"],
      "env": {
        "DEEPSEEK_API_KEY": "YOUR_DEEPSEEK_API_KEY"
      }
    }
  }
}
```

Codex:

```bash
codex mcp add deepseek-crawl \
  --env DEEPSEEK_API_KEY=YOUR_DEEPSEEK_API_KEY \
  -- npx -y deepseek-crawl@0.1.0 mcp
```

Claude Desktop, Cursor, and other MCP clients can use the JSON configuration
above. Keep the API key in user-level client configuration, never in a project
repository.

To use a local checkout before publication, point the client at the built
entrypoint:

```json
{
  "mcpServers": {
    "deepseek-crawl": {
      "command": "node",
      "args": ["/absolute/path/to/deepseek-crawl/dist/bin.js", "mcp"],
      "env": {
        "DEEPSEEK_API_KEY": "YOUR_DEEPSEEK_API_KEY"
      }
    }
  }
}
```

The server exposes:

- `deepseek_search`
- `deepseek_fetch`

MCP tools return bounded Markdown plus structured content. They never write
local files. Page content is untrusted data and must not be interpreted as
instructions.

## Configuration

| Variable               | Default                    | Purpose                                         |
| ---------------------- | -------------------------- | ----------------------------------------------- |
| `DEEPSEEK_API_KEY`     | required                   | DeepSeek API authentication                     |
| `DEEPSEEK_BASE_URL`    | `https://api.deepseek.com` | Override for testing or gateways                |
| `DEEPSEEK_TIMEOUT_MS`  | `60000`                    | Request timeout, 1000 to 120000                 |
| `DEEPSEEK_MAX_RETRIES` | `2`                        | Retries for 408, 429, and transient 5xx, 0 to 5 |

Non-loopback base URLs must use HTTPS.

## Privacy

Queries, original questions, localization values, and target URLs are sent to
DeepSeek. The tool has no analytics, telemetry, crash upload, or remote logging.
The API key is only sent in the DeepSeek `Authorization` header.

## Development

```bash
npm install
npm run verify
```

Normal tests are offline and never require a DeepSeek key. The explicit live
check is billable:

```bash
DEEPSEEK_API_KEY=sk-... npm run test:live
```
