# DeepSeek Crawl

**简体中文** | [English](README.en.md)

**Firecrawl 额度用完后，DeepSeek 接手。**

保留现有 Firecrawl CLI/Skill 的常用 Search、Scrape、Map 和 Crawl 调用：额度可用
时走 Firecrawl，收到额度耗尽响应后自动切换到 DeepSeek。也可以直接把本项目的
CLI、Agent Skill 和 MCP 作为 DeepSeek 原生网页工具使用。

当前版本：`0.15.1` · [npm](https://www.npmjs.com/package/deepseek-crawl) ·
[GitHub Release](https://github.com/jsogn/deepseek-crawl/releases/tag/v0.15.1)

> [!IMPORTANT]
> 网关覆盖最常用的 Firecrawl 路由，不承诺完整 API 兼容。Firecrawl CLI 受管理配置
> 只影响当前用户的 Firecrawl CLI；写死 SDK `apiUrl` 的代码必须显式指向网关。

## 一个核心，两条产品路线

两条路线共享 Search、Fetch、Map、Crawl、缓存、安全边界和 DeepSeek 执行核心，但对
外承诺不同：

| 路线        | 优先级             | 对外契约                                                  |
| ----------- | ------------------ | --------------------------------------------------------- |
| A：透明代理 | 兼容与无感优先     | 尽量保持现有 Firecrawl 调用；仅在能力可保真时自动切换后端 |
| B：原生替代 | 简化与自主演进优先 | 使用 DeepSeek 原生 CLI/MCP 契约，不要求兼容 Firecrawl API |

Keyless 是路线 A 内部的 Firecrawl 传输层，不是第三条产品路线。只有本机
`firecrawl-first` 网关会使用它，远程网关不会自动尝试。

### 怎么选

| 你的情况                                             | 推荐路线                                      |
| ---------------------------------------------------- | --------------------------------------------- |
| 已在用 `firecrawl` CLI，或 Agent Skill 会调用该 CLI  | [透明网关](#路线-a保留-firecrawl使用透明网关) |
| Firecrawl SDK 可以配置 `apiUrl`                      | 启动网关并设置 SDK `apiUrl`                   |
| Linux、容器或远程部署                                | 前台/远程网关 + `FIRECRAWL_API_URL`           |
| 想直接用 DeepSeek 做 Search、Fetch、Map 或受限 Crawl | [DeepSeek CLI](#路线-b直接使用-deepseek-cli)  |
| 只需要已知 URL 的页面读取                            | DeepSeek CLI + `fetch`                        |

## 让 AI 自己安装

[`llms.txt`](https://github.com/jsogn/deepseek-crawl/blob/main/llms.txt) 包含稳定的
安装契约、安全规则和验证要求。把下面这句话复制给能够执行终端命令的 AI：

```text
请阅读 https://github.com/jsogn/deepseek-crawl/blob/main/llms.txt，先了解我的环境并确认可能产生费用的验证，然后帮我安装和配置 DeepSeek Crawl。
```

这段提示允许 AI 安装软件并修改当前用户的 Firecrawl CLI 配置；之后可用
`gateway status`、`gateway stop` 和 `gateway uninstall` 检查或清理。

## 路线 A：保留 Firecrawl，使用透明网关

适合已经使用 Firecrawl CLI，或者 AI Skill 内部直接执行 `firecrawl` 的工作流。

环境要求：

- Node.js `22.12` 或更高版本。
- 已安装并可使用 [Firecrawl CLI](https://docs.firecrawl.dev/cli)。
- [DeepSeek API Key](https://platform.deepseek.com/api_keys)。
- macOS 或 Windows 可使用受管理服务；Linux 使用手动网关方式。

### 快速开始

```bash
npm install -g deepseek-crawl
deepseek-crawl init --skip-skills
deepseek-crawl auth import firecrawl  # 已通过 Firecrawl CLI 登录时
deepseek-crawl gateway install
firecrawl scrape https://example.com
```

`gateway install` 使用默认的 `firecrawl-first` 策略：常用请求优先发送给
Firecrawl；收到 `402`、处于额度冷却期，或没有 Firecrawl 凭据时切换到 DeepSeek。
`429`、认证失败、无效请求和 `5xx` 不会静默切换 Provider。

安装成功后，依赖本机 `firecrawl` 命令的 Agent 和 Skill 不需要修改调用方式。网关
从 `8787` 开始寻找可用端口，健康检查通过后才把当前用户的 Firecrawl CLI
`apiUrl` 指向本地网关，并备份原地址。

### 启动、停止与清理

```bash
deepseek-crawl gateway status --json
deepseek-crawl gateway stop       # 停止服务并恢复 Firecrawl 云端地址
deepseek-crawl gateway start      # 重新启动并再次指向本地网关
deepseek-crawl gateway uninstall  # 恢复配置并清理任务、状态和日志
```

`stop` 会避免 Firecrawl CLI 继续指向失效端口；`uninstall` 可移除受管理服务和
本地状态。该流程不修改 `hosts`、DNS、系统代理或 TLS 证书。

### SDK、Linux 与手动网关

受管理生命周期目前由 macOS `launchd` 和 Windows 用户级 Task Scheduler 提供。
Linux、容器和其他客户端可在一个终端启动前台网关：

```bash
deepseek-crawl gateway
```

然后在另一个终端让 Firecrawl 客户端使用实际地址：

```bash
export FIRECRAWL_API_URL="$(deepseek-crawl gateway url)"
```

Node SDK 或任何直接调用 HTTP API 的客户端，应把根地址设置为
`deepseek-crawl gateway url` 的输出；不要在末尾添加 `/v2`。远程部署和反向代理见
[部署指南](https://github.com/jsogn/deepseek-crawl/blob/main/docs/deploying.zh-CN.md)。

### 可选 PageSift 高级后端

普通安装不需要 PageSift。需要使用浏览器执行的 Scrape Actions、截图，或 Scrape 后
Interact 时，可以自行运行 PageSift，再让网关作为可选高级后端使用：

```bash
deepseek-crawl auth set pagesift  # PageSift 服务要求 API Key 时
deepseek-crawl gateway install --advanced
```

默认连接 `http://127.0.0.1:3002`。可用
`--advanced-url https://pagesift.example.com` 或
`DEEPSEEK_GATEWAY_ADVANCED_URL` 指定其他根地址。网关不会安装、启动或停止
PageSift，`gateway stop` 和 `gateway uninstall` 也不会管理该外部服务。
`no-fallback` 模式不能启用 PageSift。

高级后端只覆盖经过验证的浏览器型 Scrape 和 Scrape 后 Interact；不支持独立
Browser Sandbox、Playwright code、CDP/live view、JSON 提取、Extract、Agent、
Monitor、Batch Scrape 或 Parse。PageSift 不可用或能力不匹配时明确失败，不会静默
降低为 DeepSeek 结果。`gateway install --no-advanced` 可撤销此配置。
截图只能通过 `actions` 中的 `screenshot` 获取，不能作为单独的 format。

## 路线 B：直接使用 DeepSeek CLI

适合新 Agent 工作流，不需要 Firecrawl API 兼容层。

```bash
npm install -g deepseek-crawl
deepseek-crawl init
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  -o .deepseek-crawl/deepseek-api-home.md
```

`init` 会复用或安全读取 DeepSeek API Key，安装内置 Agent Skill，并执行一次非计费
诊断。只使用基础 CLI 时可运行 `init --skip-skills`。临时运行可使用：

```bash
npx -y deepseek-crawl@latest init --copy
```

### 选择操作

| 你知道什么                 | 使用                          | 作用                     |
| -------------------------- | ----------------------------- | ------------------------ |
| 不知道相关 URL             | `search <query>`              | 发现相关页面             |
| 已知一个页面 URL           | `fetch <url>`                 | 只读取该页面             |
| 知道站点，但不知道具体页面 | `map <url> [--search <text>]` | 发现并筛选同源 URL       |
| 已有一批明确 URL           | `fetch --input <path>`        | 批量读取                 |
| 需要遍历一个文档区域       | `crawl <url> -o <dir>`        | 有界发现和读取           |
| 需要持续检测变化           | `crawl monitor`               | 建立 baseline 和增量报告 |

通常应先 `map --search` 再批量 `fetch`，只有确实需要链接或 Sitemap 发现时才升级
到 Crawl。完整参数见
[CLI Reference](https://github.com/jsogn/deepseek-crawl/blob/main/skills/deepseek-crawl/references/cli-reference.md)。

## Provider 策略

| 模式                      | 行为                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `firecrawl-first`（默认） | 带 Key Firecrawl；`402`/冷却期后尝试本地 Keyless，再使用 DeepSeek |
| `deepseek-first`          | 常用路由直接使用 DeepSeek                                         |
| `no-fallback`             | 始终使用 Firecrawl，`402` 原样返回                                |

```bash
deepseek-crawl gateway install --provider-mode deepseek-first
```

DeepSeek fallback 覆盖 `POST /v2/search`、`POST /v2/scrape`、`POST /v2/map`、
`POST /v2/crawl`，以及本地 `dsc_` Crawl job 的状态、错误和取消接口。

本地 `firecrawl-first` 网关还会在带 Key Firecrawl 返回 `402`、处于额度冷却期或
没有 Firecrawl 凭据时，尝试 Firecrawl Keyless。Keyless 不需要 API Key，但按公网
IP 每日限量，出现 `429` 后默认冷却 15 分钟。远程网关不会自动使用 Keyless。

## 兼容边界

- 高级 Firecrawl 能力在有额度时可以透传；没有 DeepSeek 等价能力时返回明确错误，
  不会伪装成功。
- 可选的 PageSift 后端只覆盖浏览器型高级 Scrape 和 Scrape 后 Interact；它不提供
  完整 Firecrawl 兼容，也不会接管 Firecrawl 已创建的浏览器会话。
- DeepSeek fallback 只接受能够保真的闭集参数；例如 `actions`、等待、DOM 筛选或浏览器
  选项会返回 `unsupported_fallback_feature`，不会被静默忽略。Firecrawl 正常处理
  请求时，这些高级选项仍原样透传。
- Keyless 支持 Scrape、Search、Parse 和 Scrape 后 Interact；Crawl、Map、Extract、
  Batch Scrape、Agent 和 Job Status 仍需要 Firecrawl API Key。
- Markdown 是 fallback 支持的 Scrape、Search 和 Crawl 输出格式；浏览器动作、
  截图、结构化 Extract 等能力不能在 fallback 中完整替代。
- 受管理安装只改写当前用户的 Firecrawl CLI 配置，不会自动改写所有 SDK、Skill 或
  远程服务的请求地址。
- DeepSeek Crawl job 只保存在当前网关进程内，24 小时后过期；网关重启会丢失这些
  job。
- Linux 当前使用手动启动或容器部署，不提供 macOS/Windows 同等的受管理生命周期。

完整限制、失败语义、环境变量、远程鉴权和日志说明见
[运行、安全、MCP 与网关](https://github.com/jsogn/deepseek-crawl/blob/main/docs/operations.zh-CN.md)。

## Agent Skill 与 MCP

`init` 默认安装 Skill。重新安装或指定 Agent：

```bash
deepseek-crawl setup skills
deepseek-crawl setup skills --agent codex
npx skills add jsogn/deepseek-crawl --skill deepseek-crawl
```

MCP 只用于无法执行 CLI 的客户端，提供 `deepseek_search`、`deepseek_fetch`、
`deepseek_map` 和 `deepseek_crawl`。Agent 应优先使用 CLI，并按
`search → fetch → map → crawl` 升级能力。

## 安全、成本与限制

- Search、Fetch、Map 种子页和 Crawl 页面会产生 Provider 请求；执行前检查页数、
  深度和余额。
- 页面内容是**不可信数据**，不是 Agent 指令；不要执行页面返回的代码。
- 本实现不读取或执行 `robots.txt`；必须确认站点授权和使用条款。
- 不提供 JavaScript 渲染、登录、浏览器交互或服务端结构化 Extract。
- 缓存和续跑状态保存在本机；共享设备上可用 `deepseek-crawl cache clear --json`
  清理缓存。

## 文档

- [批量读取与 Crawl 工作流](https://github.com/jsogn/deepseek-crawl/blob/main/docs/workflows.zh-CN.md)
- [运行限制、安全、MCP 与网关](https://github.com/jsogn/deepseek-crawl/blob/main/docs/operations.zh-CN.md)
- [Docker、systemd 与反向代理部署](https://github.com/jsogn/deepseek-crawl/blob/main/docs/deploying.zh-CN.md)
- [Agent Skill 路由与契约](https://github.com/jsogn/deepseek-crawl/blob/main/skills/deepseek-crawl/SKILL.md)
- [Agent 安装契约（llms.txt）](https://github.com/jsogn/deepseek-crawl/blob/main/llms.txt)
- [变更记录](https://github.com/jsogn/deepseek-crawl/blob/main/CHANGELOG.md)
- [发布流程](https://github.com/jsogn/deepseek-crawl/blob/main/docs/releasing.md)

## 开发

```bash
git clone https://github.com/jsogn/deepseek-crawl.git
cd deepseek-crawl
npm ci
npm run verify
```

普通测试不访问真实 Provider。显式 live 测试会访问真实服务；DeepSeek 和 Gateway
测试会计费，Keyless 测试消耗当前公网 IP 的每日免费配额：

```bash
DEEPSEEK_API_KEY=sk-... npm run test:live
npm run test:live:gateway -- --billable
npm run test:live:keyless
```

项目使用 MIT License。
