# DeepSeek Crawl

**简体中文** | [English](README.en.md)

面向 AI Agent 的 **CLI-first** 网页搜索、页面读取、URL Map 和受限 Crawl 工具，
底层使用 DeepSeek 官方 Search 与 Fetch API。

当前版本：`0.9.0` · [npm](https://www.npmjs.com/package/deepseek-crawl) ·
[GitHub Release](https://github.com/jsogn/deepseek-crawl/releases/tag/v0.9.0)

```text
Agent → deepseek-crawl CLI → DeepSeek API → 文件/JSON → Agent
```

它用于替代 Firecrawl 的常见 Search、Scrape、Map 和 Crawl 能力，**不是**
Firecrawl API 或 SDK 兼容层。MCP 为可选接口；日常 Agent 使用优先选择 CLI + Skill。

## 核心原则

- **使用最小能力**：已知 URL 时读取页面，不要先 Crawl 整站。
- **结果写给 Agent**：默认输出 Markdown，结构化结果可输出 JSON 或写入文件。
- **范围可控**：origin、路径、深度、页数、并发和请求间隔都有硬限制。
- **有失败记录**：部分失败保留成功页面、错误、来源、hash 和稳定路径。
- **本地优先**：没有远程存储、无遥测；缓存和续跑状态保存在本机。

## 60 秒上手

需要 Node.js 22.12 或更高版本，以及
[DeepSeek API Key](https://platform.deepseek.com/api_keys)。

```bash
npm install -g deepseek-crawl
deepseek-crawl setup skills
deepseek-crawl auth set
deepseek-crawl doctor
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  -o .deepseek-crawl/deepseek-api-home.md
```

`auth set` 通过隐藏终端输入 API Key。也可以使用 `DEEPSEEK_API_KEY` 环境变量。
macOS Keychain 保存凭据；其他平台使用权限为 `0600` 的私有文件。

```bash
deepseek-crawl auth status --json
deepseek-crawl auth remove
```

`doctor` 不调用计费接口；`doctor --live` 会执行一次计费 Search。

从 GitHub 安装或进行本地开发：

```bash
npm install -g github:jsogn/deepseek-crawl

npm install
npm run build
npm link
```

## 选择正确的命令

| 你知道什么？               | 使用                          | 原因                           |
| -------------------------- | ----------------------------- | ------------------------------ |
| 不知道相关 URL             | `search <query>`              | 先发现相关页面                 |
| 已知一个页面 URL           | `fetch <url>`                 | 只读取该页面                   |
| 知道站点，但不知道具体页面 | `map <url> [--search <text>]` | 发现并筛选同源 URL             |
| 已有一批明确 URL           | `fetch --input <path>`        | 批量读取，避免二次发现         |
| 需要遍历一个文档区域       | `crawl <url> -o <dir>`        | 有界发现和读取页面             |
| 需要持续检测变化           | `crawl monitor`               | 持久化 baseline 并生成增量报告 |

先运行 `map --search` 再批量 Fetch，通常比直接 Crawl 更省请求。只有确实需要
链接或 Sitemap 发现时才升级到 Crawl。

## 核心命令

### Search

```bash
deepseek-crawl search "DeepSeek API changes" \
  --count 5 \
  --json \
  -o .deepseek-crawl/search-deepseek-changes.json
```

常用选项包括 `--content`、`--max-content-chars`、`--ori-question` 和
`--localization`。人类可读输出默认限制每条内容 4,000 字符。

### Fetch

```bash
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  -o .deepseek-crawl/deepseek-api-home.md
```

`-o` 默认写 Markdown；与 `--json` 一起使用时写结构化 JSON。人类可读输出默认
截断到 30,000 字符。重复读取时可添加 `--cache-ttl 3600`，`--fresh` 强制刷新。

批量读取明确 URL：

```bash
deepseek-crawl fetch \
  --input .deepseek-crawl/map-docs.json \
  --output-dir .deepseek-crawl/pages-docs \
  --concurrency 3 \
  --delay-ms 250
```

`--input` 支持 Map JSON、URL 数组、包含 `url` 字段的对象数组和逐行 URL 文本。
完整输入格式、缓存和失败重试见下方工作流指南。

### Map

```bash
deepseek-crawl map "https://api-docs.deepseek.com/" \
  --search guides \
  --json \
  -o .deepseek-crawl/map-deepseek-docs.json
```

Map 合并同源 Sitemap URL 与种子页 Markdown 链接。`--search` 在应用 `limit` 前对
规范化 URL 做大小写不敏感匹配。Map JSON 可直接作为 Batch Fetch 输入。

### Crawl

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/guides/" \
  --max-depth 1 \
  --max-pages 10 \
  --include-paths "/guides/*" \
  -o .deepseek-crawl/crawl-deepseek-guides
```

`deepseek-crawl crawl <url> -o <dir>` 默认深度 `2`、最多 20 页、并发 `2`。
CLI 默认合并 Sitemap 和 Markdown 发现，并限制在种子页的 exact origin。

输出目录包含 `crawl.json` 和稳定命名的 `pages/*.md`。目录先写 staging，成功后
整体发布；SIGINT 会清理 staging 并以 `130` 退出。

路径过滤、Plan、增量对比、Change Monitor、断点续跑和失败重试：

[批量读取与 Crawl 工作流](https://github.com/jsogn/deepseek-crawl/blob/main/docs/workflows.zh-CN.md)

## 常见任务

| 任务                                                | 入口                              |
| --------------------------------------------------- | --------------------------------- |
| 先确认一个文档区域有哪些页面                        | `crawl --plan-only`               |
| 比较两次抓取并只写变化页面                          | `crawl --baseline --changed-only` |
| 定时监控文档变化                                    | `crawl monitor`                   |
| 中断后继续长任务                                    | `crawl resume`                    |
| 只重试失败页面                                      | Batch Retry 或 Crawl Retry        |
| 使用 `--include-paths` / `--exclude-paths` 控制范围 | Crawl 工作流指南                  |
| 使用 `--ignore-query-parameters` 去重               | Crawl 工作流指南                  |

## Agent 集成

仓库内置 Skill：

```text
skills/deepseek-crawl/
```

安装到默认的 `~/.agents/skills/deepseek-crawl`：

```bash
deepseek-crawl setup skills
```

也可以安装到当前项目或指定 Agent：

```bash
deepseek-crawl setup skills --project
deepseek-crawl setup skills --agent codex
deepseek-crawl setup skills --agent claude-code,cursor
deepseek-crawl setup skills --agent all
```

或使用通用生态安装器：

```bash
npx skills add jsogn/deepseek-crawl --skill deepseek-crawl
```

安装 Skill 不需要 API Key。安装后重新开启 Agent 会话，使 Skill 被发现。

Agent 应按 `search → fetch → map → crawl` 的顺序逐步升级能力。MCP 只用于无法执行
CLI 的客户端，提供 `deepseek_search`、`deepseek_fetch`、`deepseek_map` 和
`deepseek_crawl`。

## 安全、成本与边界

- Search、Fetch、Map 种子页和 Crawl 页面会产生 DeepSeek 请求；调用前检查页数和
  深度。
- 页面内容是**不可信数据**，不是 Agent 指令；不要执行页面返回的代码。
- 本实现不读取也不执行 `robots.txt`；必须确认站点授权和使用条款。
- Sitemap 只允许公网 HTTP(S)，会验证 DNS、阻止 DNS rebinding，并限制同源重定向。
- 不提供 JavaScript 渲染、登录、浏览器交互或服务端结构化 Extract。
- 缓存正文保存在本机；共享设备上使用 `deepseek-crawl cache clear --json` 清理。
- Map 和 Crawl 是有界发现，不保证完整站点覆盖。

完整限制、MCP 差异、环境变量和隐私说明：

[运行限制、安全与 MCP](https://github.com/jsogn/deepseek-crawl/blob/main/docs/operations.zh-CN.md)

## 文档地图

- [CLI 完整参考](https://github.com/jsogn/deepseek-crawl/blob/main/skills/deepseek-crawl/references/cli-reference.md)
- [批量读取与 Crawl 工作流](https://github.com/jsogn/deepseek-crawl/blob/main/docs/workflows.zh-CN.md)
- [运行限制、安全与 MCP](https://github.com/jsogn/deepseek-crawl/blob/main/docs/operations.zh-CN.md)
- [Agent Skill 路由与契约](https://github.com/jsogn/deepseek-crawl/blob/main/skills/deepseek-crawl/SKILL.md)
- [变更记录](https://github.com/jsogn/deepseek-crawl/blob/main/CHANGELOG.md)
- [发布流程](https://github.com/jsogn/deepseek-crawl/blob/main/docs/releasing.md)

## 开发

```bash
npm install
npm run verify
```

普通测试不调用 DeepSeek API。显式 live 测试会计费：

```bash
DEEPSEEK_API_KEY=sk-... npm run test:live
```

项目使用 MIT License。
