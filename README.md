# DeepSeek Websearch

Local CLI and MCP tools for DeepSeek Search and Fetch.

The project is in the design phase. It will expose one read-only interface over
DeepSeek's official APIs:

- `search`: ranked web results, summaries, and optional page content.
- `fetch`: one page as Markdown.

The same package will support direct CLI use and MCP over stdio. Provider
selection and fallback remain the caller's responsibility; this project only
implements DeepSeek Search and Fetch.

See the validated design in
[`docs/superpowers/specs/2026-11-13-deepseek-websearch-design.md`](docs/superpowers/specs/2026-11-13-deepseek-websearch-design.md).

