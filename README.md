# DeepSeek Crawl

**简体中文** | [English](README.en.md)

面向 AI Agent 的 **CLI-first** 网页搜索、页面读取、URL Map 和受限 Crawl 工具，
底层使用 DeepSeek 官方 Search 与 Fetch API。

当前版本：`0.13.0` · [npm](https://www.npmjs.com/package/deepseek-crawl) ·
[GitHub Release](https://github.com/jsogn/deepseek-crawl/releases/tag/v0.13.0)

```text
Agent → deepseek-crawl CLI → DeepSeek API → 文件/JSON → Agent
```

它用于替代 Firecrawl 的常见 Search、Scrape、Map 和 Crawl 能力。普通 CLI 和
MCP 只调用 DeepSeek；包内另有可选的 Firecrawl-compatible 网关，用于兼容现有
Firecrawl v2 客户端并在额度耗尽时切换到 DeepSeek。
MCP 为可选接口；日常 Agent 使用优先选择 CLI + Skill。

## 核心原则

- **使用最小能力**：已知 URL 时读取页面，不要先 Crawl 整站。
- **结果写给 Agent**：默认输出 Markdown，结构化结果可输出 JSON 或写入文件。
- **范围可控**：origin、路径、深度、页数、并发和请求间隔都有硬限制。
- **有失败记录**：部分失败保留成功页面、错误、来源、hash 和稳定路径。
- **本地优先**：没有远程存储、无遥测；缓存和续跑状态保存在本机。

## 安装与首次运行

### 环境要求

- Node.js 22.12 或更高版本。
- [DeepSeek API Key](https://platform.deepseek.com/api_keys)。
- Map 和 Crawl 需要能直接访问目标站点的 Sitemap。

### 选择安装方式

| 使用方式      | 适合场景                      | 命令                                         |
| ------------- | ----------------------------- | -------------------------------------------- |
| `npx`         | 临时体验或 CI                 | `npx -y deepseek-crawl@latest`               |
| 全局安装      | 日常重复使用 CLI              | `npm install -g deepseek-crawl`              |
| 项目依赖      | 固定版本或集成到 Node.js 项目 | `npm install deepseek-crawl`                 |
| GitHub `main` | 测试尚未发布的最新代码        | `npm install -g github:jsogn/deepseek-crawl` |

日常使用推荐全局安装：

```bash
npm install -g deepseek-crawl
deepseek-crawl --version
```

版本命令应输出当前发布版本，例如：

```text
0.13.0
```

如果全局 npm 没有写权限，不要直接使用 `sudo npm install -g`。应使用自带的
Node.js 版本管理器，或配置当前用户的 npm global prefix 后再安装。

不全局安装也可以临时运行同一个 CLI：

```bash
npx -y deepseek-crawl@latest --version
npx -y deepseek-crawl@latest init --copy
```

作为项目依赖安装后，通过 `npx deepseek-crawl` 调用：

```bash
npm install deepseek-crawl
npx deepseek-crawl --version
npx deepseek-crawl init --project
```

GitHub 安装会跟随 `main`，只建议用于测试未发布改动：

```bash
npm install -g github:jsogn/deepseek-crawl
deepseek-crawl --version
```

全局安装升级到最新发布版：

```bash
npm install -g deepseek-crawl@latest
```

### 首次初始化

全局安装后运行：

```bash
deepseek-crawl init
```

`init` 会在缺少凭据时通过隐藏输入读取 API Key，安装内置 Agent Skill，并运行一次
非计费 `doctor`。已有环境变量或本机凭据会直接复用，不会重复询问。

默认安装到 `~/.agents/skills/deepseek-crawl`。安装到当前项目或指定 Agent：

```bash
deepseek-crawl init --project
deepseek-crawl init --skip-skills
deepseek-crawl init --agent codex
deepseek-crawl init --agent claude-code,cursor
```

使用 `--json` 可获得单次运行的聚合结果，适合脚本和 Agent：

```bash
deepseek-crawl init --json
```

`init` 不会调用计费接口。使用 `npx` 临时运行时建议加 `--copy`，避免 Skill
链接指向可能被清理的 npx 缓存。使用 `--copy` 的 Skill 需要重新运行
`init --skip-auth --copy --force` 才能更新。

重新开启 Agent 会话后，Skill 才会被发现。

### 手动管理 API Key

`init` 是普通首次安装的推荐入口。需要单独更换或删除凭据时，以下命令以全局安装
为例；使用 `npx` 时在前面加上 `npx -y deepseek-crawl@latest`。

```bash
deepseek-crawl auth set
deepseek-crawl auth status --json
```

`auth set` 通过隐藏终端读取 Key。也可以使用 `DEEPSEEK_API_KEY` 环境变量。
macOS Keychain 保存凭据；其他平台使用权限为 `0600` 的私有文件。

`auth status` 只显示来源和存储后端，不输出 Key。删除本机凭据：

```bash
deepseek-crawl auth remove
```

网关相关 Provider 凭据使用同一套命令：

```bash
deepseek-crawl auth import firecrawl
deepseek-crawl auth set firecrawl
deepseek-crawl auth set gateway
deepseek-crawl auth status firecrawl --json
deepseek-crawl auth remove gateway
```

如果本机已经运行 `firecrawl config`，`auth import firecrawl` 会从 Firecrawl
CLI 的平台配置目录读取 Key，只显示首尾掩码，再写入 DeepSeek Crawl 自己的
Keychain/file store。`FIRECRAWL_API_KEY` 环境变量仍然优先；导入命令会明确提示
这种覆盖关系。

不指定 Provider 时仍默认为 `deepseek`，兼容原有命令。

### 验证 CLI 与凭据

```bash
deepseek-crawl doctor
```

`init` 已经包含同样的检查。`doctor` 检查配置且不调用计费接口；
`doctor --live` 会执行一次计费 Search。

### 查看账户余额

```bash
deepseek-crawl balance
deepseek-crawl balance --json
```

余额查询读取 DeepSeek `/user/balance`，不会产生计费请求。`--json` 输出稳定的
`available` 和按币种排序的 `balances[]`，可直接用于 Agent 或脚本判断 DeepSeek
当前是否可用；使用 `-o` 可原子写入文件。

### 第一次请求

安装和认证成功后，用一个已知 URL 验证端到端读取：

```bash
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  -o .deepseek-crawl/deepseek-api-home.md
```

这条命令会产生一次 DeepSeek Fetch 请求。需要完全无计费的安装检查时，到此为止，
只使用 `--version`、`init`、`auth status`、`doctor` 和 `balance`。

`init` 默认安装 Agent Skill；只使用基础 CLI 时可添加 `--skip-skills`。更多安装
位置和目标见下方 [Agent 集成](#agent-集成)。

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

大规模 Batch 可启用本地 Job 检查点。Job 目录和最终输出目录必须不存在且不能
互相嵌套：

```bash
deepseek-crawl fetch \
  --input .deepseek-crawl/map-docs.json \
  --output-dir .deepseek-crawl/pages-docs \
  --job-dir .deepseek-crawl/jobs/docs

deepseek-crawl fetch status .deepseek-crawl/jobs/docs --json
deepseek-crawl fetch resume .deepseek-crawl/jobs/docs
```

续跑只请求尚未完成的 URL，不重复读取已成功页面。任务完成后才原子发布最终
`fetch.json` 和页面目录。

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

## Firecrawl-compatible 网关（可选）

普通 CLI 和 MCP 不启动 HTTP 服务。需要让现有 Firecrawl v2 客户端直接连接时：

```bash
deepseek-crawl auth import firecrawl
deepseek-crawl gateway
```

已有 Firecrawl CLI 登录时可直接导入；也可以继续使用
`auth set firecrawl` 手动输入。只使用 DeepSeek 可以不导入 Firecrawl 凭据，
网关仍可工作。DeepSeek Key
继续使用现有的 `deepseek-crawl auth set` 或 Keychain 配置。

本地默认从 `8787` 开始寻找可用端口，冲突时自动尝试下一个，并打印实际地址。
指定 `--port` 时该端口变为严格固定；被占用会直接失败。

其他终端或脚本可以发现当前实际地址：

```bash
deepseek-crawl gateway url
deepseek-crawl gateway status --json
```

只有一个实例时，`gateway url` 直接输出 URL；多个实例并存时需要
`gateway url --port 8788`。运行状态只保存 PID、URL、启动时间和模式，不保存
Provider Key。`gateway status` 会通过 `/healthz` 验证进程并清理陈旧状态。
`gateway status` 同时显示 DeepSeek、Firecrawl 和远程网关认证是否已配置及来源，
可以替代连续执行多个 `auth status`。

客户端通常只需要 Firecrawl API 地址：

```bash
export FIRECRAWL_API_URL=http://127.0.0.1:<打印的端口>
```

Node SDK 本地模式可以只设置根地址；不要在 `apiUrl` 末尾添加 `/v2`：

```js
import { Firecrawl } from "firecrawl";

const firecrawl = new Firecrawl({
  apiUrl: "http://127.0.0.1:8787", // 使用启动输出中的实际端口
});
```

常用路由 `POST /v2/search`、`POST /v2/scrape`、`POST /v2/map` 和
`POST /v2/crawl` 会优先调用 Firecrawl。Firecrawl 返回 `402`、或未配置
Firecrawl 凭据时，网关使用 DeepSeek；Crawl 还会提供兼容的 job status、errors
和取消接口。`429`、认证错误、无效请求和服务端错误保持 Firecrawl 响应，不会
静默切换。

网关进程只读取 `FIRECRAWL_UPSTREAM_URL` 作为 Firecrawl 上游地址，默认
`https://api.firecrawl.dev`。`FIRECRAWL_API_URL` 是客户端地址，不会被网关用作
上游，以免代理自身形成循环。

高级 Firecrawl 能力在有额度时可透传；没有 DeepSeek 等价能力时不会伪装成功。
DeepSeek Crawl job 只保存在当前网关进程内，24 小时后过期。

远程模式使用固定默认端口 `8787`，并且必须配置网关 Token：

```bash
deepseek-crawl auth set gateway
deepseek-crawl gateway --remote
```

远程客户端把网关 Token 作为 Firecrawl SDK `apiKey`。网关校验后会剥离它，并使用
服务器自己的 Firecrawl Provider 凭据访问上游，避免把网关凭据泄露给 Firecrawl。
`--allow-remote` 作为旧参数仍兼容，但新用法统一为 `--remote`。
CI 和容器可以直接用 `GATEWAY_API_KEY` 环境变量覆盖已存储 Token。

Firecrawl 上游响应采用流式透传，不会把大型 Crawl 响应完整缓冲在网关内存中。
网关正常关闭时会取消仍在运行的本地 DeepSeek Crawl jobs。

远程网关默认对同一来源连续 5 次认证失败锁定 60 秒，并将并发请求限制为 100。
每个请求返回 `x-request-id`。CLI 网关向 stderr 写入单行 JSON 请求日志，只记录
规范化路由、状态码、耗时、Provider 和 fallback 原因，不记录 Key、正文、查询
字符串或完整目标 URL。默认 header timeout 为 15 秒、request timeout 为 120 秒、
keep-alive timeout 为 5 秒。

官方 SDK 的 WebSocket `Watcher` 暂不支持；网关对 upgrade 请求返回结构化
`426 websocket_not_supported`。请使用官方 SDK 默认的 Crawl 轮询/convenience
方法，或 `startCrawl` + `getCrawlStatus`。

离线兼容测试使用官方 `firecrawl` Node SDK，覆盖 Search、Scrape、Map、Crawl、
fallback 和结构化错误，不访问真实付费 API。

## Agent 集成

`deepseek-crawl init` 会一并完成默认 Skill 安装。以下命令用于只安装或重新配置
Skill：

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
- Firecrawl-compatible 网关只兼容常用接口；高级 Firecrawl 功能不能用 DeepSeek
  替代。
- 缓存正文保存在本机；共享设备上使用 `deepseek-crawl cache clear --json` 清理。
- Map 和 Crawl 是有界发现，不保证完整站点覆盖。

完整限制、MCP 差异、环境变量和隐私说明：

[运行限制、安全、MCP 与网关](https://github.com/jsogn/deepseek-crawl/blob/main/docs/operations.zh-CN.md)

## 文档地图

- [CLI 完整参考](https://github.com/jsogn/deepseek-crawl/blob/main/skills/deepseek-crawl/references/cli-reference.md)
- [批量读取与 Crawl 工作流](https://github.com/jsogn/deepseek-crawl/blob/main/docs/workflows.zh-CN.md)
- [运行限制、安全、MCP 与网关](https://github.com/jsogn/deepseek-crawl/blob/main/docs/operations.zh-CN.md)
- [Docker、systemd 与反向代理部署](https://github.com/jsogn/deepseek-crawl/blob/main/docs/deploying.zh-CN.md)
- [Agent Skill 路由与契约](https://github.com/jsogn/deepseek-crawl/blob/main/skills/deepseek-crawl/SKILL.md)
- [变更记录](https://github.com/jsogn/deepseek-crawl/blob/main/CHANGELOG.md)
- [发布流程](https://github.com/jsogn/deepseek-crawl/blob/main/docs/releasing.md)

## 开发

```bash
git clone https://github.com/jsogn/deepseek-crawl.git
cd deepseek-crawl
npm ci
npm run build
npm link
node dist/bin.js --version
npm run verify
```

普通测试不调用 DeepSeek API。显式 live 测试会计费：

```bash
DEEPSEEK_API_KEY=sk-... npm run test:live
```

显式验证官方 Firecrawl SDK 经 Gateway 的 Firecrawl 透传和 DeepSeek fallback：

```bash
npm run test:live:gateway -- --billable
```

该命令固定执行两次 `example.com` 单页 Scrape；缺少 `--billable` 时会拒绝运行。
凭据从环境变量或本机 Secure Store 读取，不会输出 Key。

增加 `--matrix` 后会再执行 Search 和 Map，总共 6 个受限操作：

```bash
npm run test:live:gateway -- --billable --matrix
```

项目使用 MIT License。
