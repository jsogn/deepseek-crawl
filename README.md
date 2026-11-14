# DeepSeek Crawl

**简体中文** | [English](README.en.md)

面向 AI Agent 的 **CLI-first** 网页搜索、页面读取、URL Map 和受限 Crawl 工具，
底层使用 DeepSeek 官方 Search 与 Fetch API。

默认工作流：

```text
Agent → deepseek-crawl CLI → DeepSeek API → 文件/JSON → Agent
```

仓库内置 `deepseek-crawl` Agent Skill，指导 AI 按以下顺序选择最小能力：

1. 不知道 URL：使用 `search`。
2. 已知 URL：使用 `fetch`。
3. 已知站点但不知道具体页面：使用 `map --search`。
4. 确实需要批量读取文档或站点区域：使用受限 `crawl`。

本项目用于替代 Firecrawl 的常见 Search、Scrape、Map 和 Crawl 能力，**不是**
Firecrawl API 或 SDK 兼容层。

MCP 为可选项，主要保留给无法执行 CLI 的客户端。日常 Agent 使用应优先选择
CLI + Skill。

## 当前版本

`0.7.0` 提供：

- CLI-first 的 Search、Fetch、Map 和 Crawl。
- CLI Crawl 默认合并 Sitemap 与种子页 Markdown 发现，不再只依赖页面内链接。
- 自带 Agent Skill，包含命令路由、输出组织和安全边界。
- `setup skills` 一键安装到通用或指定 Agent 目录。
- `map --search` URL 筛选。
- Map JSON 直接驱动的批量 Fetch，以及逐页失败记录。
- Crawl 路径 include/exclude 和 query 参数去重。
- Crawl Plan 预览初始 frontier，避免在确认 URL 列表前读取所有子页面。
- Batch Fetch 和 Crawl 可从既有报告只重试失败项，避免重复读取成功页面。
- Fetch、Batch、Crawl、Plan 和 Retry 可共享显式 TTL 的本地页面缓存。
- Fetch、Batch 和 Crawl 输出稳定 `content_hash`，Crawl 可对比 baseline 只写变更页面。
- Crawl 支持 durable job、逐页 checkpoint、`crawl resume` 和 `crawl status`。
- macOS Keychain 或其他平台私有文件凭据存储。
- `auth set`、`auth status`、`auth remove`。
- 可选的四个 MCP 工具。
- 公网 Sitemap 访问、DNS 固定、NAT64/Teredo 防护和同源重定向验证。
- 确定性 Crawl、失败记录和原子输出。

项目使用 MIT License。

## 环境要求

- Node.js 22.12 或更高版本。
- DeepSeek API Key：<https://platform.deepseek.com/api_keys>。
- 能访问 DeepSeek；CLI Map 和 Crawl 还需要直接访问目标站点的 Sitemap。

## 安装

从 GitHub 安装：

```bash
npm install -g github:jsogn/deepseek-crawl
deepseek-crawl setup skills
deepseek-crawl auth set
deepseek-crawl doctor
```

npm registry 发布后也可以使用：

```bash
npm install -g deepseek-crawl@0.7.0
```

本地开发：

```bash
npm install
npm run build
npm link
deepseek-crawl setup skills
```

## API 凭据

只需要配置一次：

```bash
deepseek-crawl auth set
```

CLI 使用隐藏终端输入，或从 stdin 读取 Key，不接受 Key 作为命令行参数。

存储位置：

- macOS：Keychain，service 为 `deepseek-crawl`。
- Linux 和其他平台：
  `$XDG_CONFIG_HOME/deepseek-crawl/credentials.json` 或
  `~/.config/deepseek-crawl/credentials.json`，权限为 `0600`。

查看或删除：

```bash
deepseek-crawl auth status --json
deepseek-crawl auth remove
```

凭据优先级：

1. `DEEPSEEK_API_KEY` 环境变量。
2. CLI 保存的凭据。
3. 未配置错误。

`auth status` 只报告来源和存储后端，不输出 Key。

## Agent Skill

Skill 位于：

```text
skills/deepseek-crawl/
```

默认安装到通用 Agent Skills 目录：

```bash
deepseek-crawl setup skills
```

创建：

```text
~/.agents/skills/deepseek-crawl
```

安装到当前项目：

```bash
deepseek-crawl setup skills --project
```

只安装到指定 Agent：

```bash
deepseek-crawl setup skills --agent codex
deepseek-crawl setup skills --agent claude-code,cursor
deepseek-crawl setup skills --agent all
```

默认使用绝对软链接。可以改用复制，并且只应在确认替换现有 Skill 时使用
`--force`：

```bash
deepseek-crawl setup skills --copy
deepseek-crawl setup skills --force
```

安装 Skill 不需要 DeepSeek API Key。

也可以使用通用生态安装器：

```bash
npx skills add jsogn/deepseek-crawl --skill deepseek-crawl
```

安装后请开启新的 Agent 会话，使 Skill 被重新发现。

## 前置检查

以下命令不会产生 DeepSeek 计费请求：

```bash
deepseek-crawl doctor --json
```

`doctor --live` 会执行一次计费 Search。

## CLI

```text
deepseek-crawl search <query> [options]
deepseek-crawl fetch <url> [options]
deepseek-crawl map <url> [--search <text>] [options]
deepseek-crawl crawl <url> -o <dir> [options]
deepseek-crawl crawl resume <job-dir> -o <dir> [options]
deepseek-crawl crawl status <job-dir> [--json]
deepseek-crawl doctor [--live] [--json]
deepseek-crawl setup skills [options]
deepseek-crawl auth set
deepseek-crawl auth status [--json]
deepseek-crawl auth remove [--json]
deepseek-crawl cache clear [--json]
deepseek-crawl mcp
```

所有命令支持 `--help`，可执行文件支持 `--version`。

## Search

```text
deepseek-crawl search <query>
  [--count <1..50>]
  [--content]
  [--max-content-chars <0..1000000>]
  [--ori-question <text>]
  [--localization <ip>]
  [--json]
  [--output, -o <path>]
```

人类可读输出默认每条内容的截断上限为 4,000 字符。`--json` 默认保留完整
API 内容；显式提供 `--max-content-chars` 时按其限制。

```bash
deepseek-crawl search "DeepSeek API changes" \
  --count 5 \
  --json \
  -o .deepseek-crawl/search-deepseek-changes.json
```

## Fetch

```text
deepseek-crawl fetch <url>
  [--max-chars <0..1000000>]
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--json]
  [--output, -o <path>]
```

人类可读输出默认截断到 30,000 字符。`-o` 默认写入 Markdown；与 `--json`
一起使用时写入结构化 JSON。

```bash
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  -o .deepseek-crawl/deepseek-api-home.md
```

缓存默认关闭。重复研究同一页面时显式启用 TTL：

```bash
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  --cache-ttl 3600 \
  --json

deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  --cache-ttl 3600 \
  --fresh \
  --json
```

`--cache-ttl` 单位为秒，范围 1–31,536,000；`--fresh` 强制调用 API 并刷新缓存。
只缓存成功 Fetch 响应。`retrieved_from: api|cache` 表示页面来源；Batch、Crawl、
Plan 和 Retry 还会在 `stats` 中提供 `cache_hits`、`cache_misses` 和
`cache_errors`。

缓存命中在进入网络 scheduler 前解析，不应用 API 的 `--delay-ms` 和网络并发等待；
只有 cache miss 会进入 DeepSeek 请求限速。

默认缓存目录：

- macOS：`~/Library/Caches/deepseek-crawl`。
- 其他平台：`$XDG_CACHE_HOME/deepseek-crawl` 或 `~/.cache/deepseek-crawl`。
- 可用 `DEEPSEEK_CACHE_DIR` 覆盖。

缓存目录权限为 `0700`，文件为 `0600`。清理：

```bash
deepseek-crawl cache clear --json
```

批量读取已知 URL：

```text
deepseek-crawl fetch --input <path|->
  --output-dir <dir>
  [--concurrency <1..5>]
  [--delay-ms <0..5000>]
  [--max-chars <0..1000000>]
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--json]
```

`--input` 可以直接读取 Map JSON，也支持 URL 字符串数组、包含 `url` 字段的对象
数组，以及逐行 URL 文本。`-` 表示从 stdin 读取。输出目录不能已存在。

```bash
deepseek-crawl map "https://api-docs.deepseek.com/" \
  --search guides --json -o .deepseek-crawl/map-docs.json

deepseek-crawl fetch \
  --input .deepseek-crawl/map-docs.json \
  --output-dir .deepseek-crawl/pages-docs \
  --concurrency 3 \
  --delay-ms 250
```

输出包含 `fetch.json` 和稳定的 `pages/*.md`。部分失败不会丢弃成功页面；全部
失败时仍会发布诊断报告，但命令退出码为 `1`。

只重试上次失败的 URL：

```bash
deepseek-crawl fetch \
  --retry-failed .deepseek-crawl/pages-docs/fetch.json \
  --output-dir .deepseek-crawl/pages-docs-retry \
  --concurrency 3 \
  --delay-ms 250 \
  --cache-ttl 3600 \
  --json
```

Retry 会读取既有 `fetch.json`，忽略已成功页面，只请求可规范化的失败 URL。输出仍
写入一个全新的目录，并保留 `retry_of`、原始索引和上次失败原因；无效 URL 会进入
`retry_of.skipped`，重复失败计入 `retry_of.deduplicated`。

## Map

```text
deepseek-crawl map <url> [--search <text>]
  [--limit <1..1000>]
  [--json]
  [--output, -o <path>]
```

Map 合并：

1. `/sitemap.xml` 及嵌套 Sitemap 中的同源 URL。
2. DeepSeek Fetch 返回的种子页 Markdown 中的同源链接。

`--search` 对规范化后的 URL 做大小写不敏感的包含匹配，并在应用 `limit`
之前过滤。使用 `--search` 时，所有返回 URL 都必须匹配，种子 URL 不会强制保留；
没有匹配属于成功空结果。

不提供 `--search` 时，种子 URL 始终保留。默认 limit 为 500。

```bash
deepseek-crawl map "https://api-docs.deepseek.com/" \
  --search guides \
  --json \
  -o .deepseek-crawl/map-deepseek-docs.json
```

警告会写入 stderr，并保留在 JSON 中。Sitemap 和种子页任一来源可用时，Map 仍可
返回部分结果。

## Crawl

```text
deepseek-crawl crawl <url> -o <dir>
  [--max-depth <0..5>]
  [--max-pages <1..100>]
  [--concurrency <1..5>]
  [--delay-ms <0..5000>]
  [--include-paths <patterns>]
  [--exclude-paths <patterns>]
  [--ignore-query-parameters]
  [--sitemap <include|only|skip>]
  [--plan-only]
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--baseline <crawl.json|dir>]
  [--changed-only]
  [--job-dir <dir>]
  [--json]
```

默认参数：

- 深度：2
- 最大页数：20
- 并发：2
- 请求启动间隔：250 ms
- Sitemap：`include`

种子页深度为 0。Crawl 按确定性的深度层遍历，移除重复规范化 URL，严格限制在
种子页的 origin 内，并记录部分页面失败。CLI Crawl 会通过 Sitemap 辅助发现
页面，因此即使 DeepSeek 返回的 Markdown 没有链接，也能遍历文档站点。

Sitemap 模式：

- `include`（默认）：合并 Sitemap URL 和种子页 Markdown 链接。
- `only`：只使用 Sitemap URL，忽略种子页 Markdown 链接。
- `skip`：只使用 Markdown 链接，恢复 `0.6.0` 行为。

Sitemap URL 从深度 1 开始，并遵守相同的 origin、路径、query、深度、页数和发现
数量限制。Sitemap 读取失败会产生 `sitemap_unavailable` 或已有 Map 警告，Crawl
继续使用可用来源；种子页读取失败仍是致命错误。

大面积 Crawl 之前可以先生成初始发现计划：

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/" \
  --plan-only \
  --max-depth 1 \
  --max-pages 20 \
  --include-paths "/guides/*" \
  -o .deepseek-crawl/deepseek-guides-plan.json
```

Plan 只读取种子页和 Sitemap，不读取任何已发现子页面。`--output` 此时是单个 JSON
文件路径，目标不能已存在。计划中的 `urls` 是限制后选中的子页面，可直接作为
Batch Fetch 的输入；`deferred` 说明被页数限制延后的 URL，`filtered` 说明因
cross-origin、路径过滤或发现数量限制而省略的 URL。Plan 描述初始深度 1
frontier，不代表递归发现全部深层 URL。

链接非常密集时，Plan 只保留 discovery limit 加 1,000 条诊断候选。超出窗口后不再
保存明细，只设置 `diagnostics_truncated`；此时统计描述保留窗口，不保证全量精确。

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/guides/" \
  --max-depth 1 \
  --max-pages 5 \
  --include-paths "/guides/*" \
  --exclude-paths "/guides/private/*" \
  --ignore-query-parameters \
  --sitemap include \
  -o .deepseek-crawl/crawl-deepseek-guides
```

路径匹配针对 URL pathname：

- 不含通配符时按路径段前缀匹配，例如 `/docs` 匹配 `/docs/start`。
- `*` 匹配任意字符，`?` 匹配单个字符。
- include 为 OR；任一 exclude 命中时优先排除。
- 种子页始终读取，不会因路径过滤被拒绝。
- `--ignore-query-parameters` 在去重和 Fetch 前移除 query。

输出：

```text
.deepseek-crawl/crawl-deepseek-guides/
  crawl.json
  pages/
    0001-page.md
    0002-example-docs.md
```

`-o` 目标不能已存在。Crawl 先写隐藏临时目录，成功后一次性发布完整目录。
SIGINT 会中止请求、清理 staging，并以代码 `130` 退出。

`crawl.json` 包含设置、统计、失败记录、内容截断元数据、`warnings`、Sitemap
候选数量、每页 `sources`、`content_hash` 和稳定页面路径，不重复保存正文。页面来源会区分
`seed_url`、`markdown` 和 `sitemap`。已知 URL 列表优先使用
`map --search` 后接批量 Fetch；需要遍历一个文档区域时再使用 Crawl，可减少不必
要的整站发现开销。

增量对比：

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/guides/" \
  --baseline .deepseek-crawl/crawl-deepseek-guides/crawl.json \
  --changed-only \
  --cache-ttl 3600 \
  -o .deepseek-crawl/crawl-deepseek-guides-changes
```

`--baseline` 可以指向旧 `crawl.json`，也可以指向包含该文件的 Crawl 输出目录。
`content_hash` 是 DeepSeek 原始 Markdown 内容的 SHA-256，在本地字符截断前计算。
结果 `changes` 分为 `added`、`modified`、`unchanged`、`removed`；`removed`
表示 baseline URL 没有出现在当前发现范围中。

`--changed-only` 只写入新增和修改页面。未变化页面仍保留在报告和统计中，但
`pages[].written` 为 `false` 且没有 `path`。第一版增量 Crawl 仍会读取页面内容
或命中缓存后计算 hash；Sitemap `lastmod` 跳过请求属于下一阶段优化。

可恢复 Crawl：

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/guides/" \
  --max-depth 2 \
  --max-pages 50 \
  --job-dir .deepseek-crawl/jobs/deepseek-docs \
  --cache-ttl 3600 \
  -o .deepseek-crawl/crawl-deepseek-guides

deepseek-crawl crawl status .deepseek-crawl/jobs/deepseek-docs --json

deepseek-crawl crawl resume \
  .deepseek-crawl/jobs/deepseek-docs \
  --cache-ttl 3600 \
  -o .deepseek-crawl/crawl-deepseek-guides
```

使用 `--job-dir` 时，页面文件写入 job 目录，`job.json` 在 seed discovery 后及每
个页面完成后原子更新。作业保存 options、seen、frontier、active layer、页面、
失败、warnings 和下一页码。中断不会删除 job；`resume` 跳过已完成的 seed 和
Sitemap reread，只继续活动层中的未完成 URL，成功后原子发布到最终目录。

job 使用版本化 `job.json`、`pages/` 和 `writer.lock`。同一 job 只允许一个 writer；
进程异常退出后，下一个 `resume/status` 可以恢复失效的 PID 锁。损坏或版本不兼容的
job 会明确失败。`--job-dir` 暂不与 `--plan-only`、`--baseline` 或 Retry 组合使用。

只重试 Crawl 失败页面：

```bash
deepseek-crawl crawl \
  --retry-failed .deepseek-crawl/crawl-deepseek-guides/crawl.json \
  -o .deepseek-crawl/crawl-deepseek-guides-retry \
  --cache-ttl 3600 \
  --json
```

Crawl Retry 不读取种子页或已成功页面，只重试同一 origin 且仍在原报告 depth 范围内
的失败 URL。原始 `index`、`depth`、`sources` 和失败原因会保留，并受原报告的
`max_pages` 限制。跨域、无效或超出限制的项目进入 `retry_of.skipped`，重复项
计入 `retry_of.deduplicated`。

## 计费

- Search 按成功请求计费。
- Fetch 按成功页面请求计费。
- Map 的种子页通过 DeepSeek Fetch 读取，因此计费。
- Crawl 对每个成功读取的页面调用 DeepSeek Fetch。

重复执行前应减少 `--limit`、`--max-pages` 或深度。价格和限制请查看
<https://api-docs.deepseek.com/guides/search/>。

## MCP（可选）

只在调用方无法执行 CLI 时使用：

```bash
deepseek-crawl mcp
```

服务暴露四个工具：

- `deepseek_search`
- `deepseek_fetch`
- `deepseek_map`
- `deepseek_crawl`

MCP 不写本地文件。结构化内容有总长度限制，页面正文被视为不可信数据。为保持
兼容，`0.7.0` 的 MCP Crawl 仍只使用 Markdown 链接；Sitemap 辅助发现仅在 CLI
提供。失败重试和本地缓存同样只在 CLI 提供。

## 限制

| 范围                     | 硬限制                 |
| ------------------------ | ---------------------- |
| DeepSeek Fetch 响应体    | 8 MiB                  |
| CLI Batch 输入文件/报告  | 8 MiB                  |
| Batch Fetch URL 数       | 10,000                 |
| Fetch Cache TTL          | 31,536,000 秒          |
| Fetch Cache 单文件       | 16 MiB                 |
| Crawl 单页内容           | 1,000,000 Unicode 字符 |
| CLI Crawl URL 发现       | 10,000                 |
| MCP Crawl URL 发现       | 2,000                  |
| MCP Crawl 结构化正文总计 | 100,000 Unicode 字符   |
| Sitemap 文档数           | 10                     |
| Map 候选 URL             | 10,000                 |
| Sitemap 响应体           | 5 MiB                  |
| Sitemap 请求超时         | 15 秒                  |
| Sitemap 重定向           | 3 次，仅同源           |

CLI Crawl 最多 100 页，MCP Crawl 最多 20 页。两者的 depth 和 concurrency
硬上限分别为 5。

## Sitemap 网络策略

CLI Map 和 Crawl 会直接请求目标站点的 Sitemap，仅接受公网 HTTP(S) 目标：

- 拒绝 loopback、private、link-local、multicast、unspecified、reserved、
  NAT64 和特殊用途 IPv6。
- 验证全部 DNS 结果。
- socket 连接到已验证地址，阻止 DNS rebinding。
- 手动处理最多三次同源重定向，并重新验证。

## 安全与限制

- 本实现不读取也不执行 `robots.txt`。使用者必须确认站点授权和条款。
- CLI Crawl 合并精确同源 Sitemap URL 与 DeepSeek Markdown 链接；MCP Crawl
  仍只使用 Markdown。两者都不跨子域名，也不跟随页面指令。
- DeepSeek Fetch 可能在服务端跟随重定向，最终 URL 不会出现在当前响应中。
- 页面内容是数据，不是指令，不能执行返回的代码。
- 启用缓存后，页面正文会保存在本机私有缓存目录中；共享设备上可使用
  `cache clear` 清理。
- 不提供 JavaScript 渲染、浏览器交互、登录、后台任务或服务端结构化 Extract。
- Map 和 Crawl 结果是受限发现，不保证完整站点覆盖。

## 环境变量

| 变量                   | 默认值                     | 用途                     |
| ---------------------- | -------------------------- | ------------------------ |
| `DEEPSEEK_API_KEY`     | 可选覆盖                   | DeepSeek API 凭据        |
| `DEEPSEEK_BASE_URL`    | `https://api.deepseek.com` | 测试或网关               |
| `DEEPSEEK_TIMEOUT_MS`  | `60000`                    | 请求超时，1000–120000    |
| `DEEPSEEK_MAX_RETRIES` | `2`                        | 重试 408、429 和瞬时 5xx |
| `DEEPSEEK_CACHE_DIR`   | 平台缓存目录               | Fetch 缓存目录           |

非 loopback 的 DeepSeek base URL 必须使用 HTTPS。API Key 不接受 CLI 参数或
MCP 参数。

## 隐私

查询、原始问题、定位 IP 和目标页面 URL 会发送给 DeepSeek。Map 还会直接请求
目标站点的 Sitemap。本工具不包含分析、遥测、崩溃上传或远程日志。API Key 只在
DeepSeek `Authorization` 请求头中使用。

## 开发

```bash
npm install
npm run verify
python3 /path/to/skill-creator/scripts/quick_validate.py skills/deepseek-crawl
```

普通测试完全离线，不需要 DeepSeek Key。显式 live 测试会计费：

```bash
DEEPSEEK_API_KEY=sk-... npm run test:live
```
