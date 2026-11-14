# 运行限制、安全、MCP 与 Firecrawl 网关

[English](operations.md) | **简体中文** | [返回 README](../README.md)

本指南覆盖计费、MCP、Firecrawl-compatible 网关、本地缓存、硬限制、Sitemap
网络策略、环境变量和隐私。

## 计费

- Search 按成功请求计费。
- Fetch 按成功页面请求计费。
- Map 会通过 DeepSeek Fetch 读取种子页，因此计费。
- Crawl 对每个成功读取的页面调用 DeepSeek Fetch。
- Firecrawl-compatible 网关有 Firecrawl 额度时消耗 Firecrawl credits；收到
  `402` 后切换到 DeepSeek，并按上面的 DeepSeek Search、Fetch、Map、Crawl 规则计费。

重复执行前应减少 `--limit`、`--max-pages` 或深度。价格和最新限制以
<https://api-docs.deepseek.com/guides/search/> 为准。

`doctor` 不产生 DeepSeek 计费请求；`doctor --live` 会执行一次计费 Search。

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

MCP 不写本地文件。结构化正文有总长度上限，页面正文始终是不可信数据。MCP Crawl
目前只使用 Markdown 链接，不使用 Sitemap 辅助发现；本地面缓存、Retry、Plan、
增量对比和 Change Monitor 同样只在 CLI 提供。

## Firecrawl-compatible 网关

网关是显式启动的独立进程，普通 CLI 和 MCP 不会自动启动它：

```bash
deepseek-crawl gateway
deepseek-crawl gateway --port 9000
deepseek-crawl gateway --remote
```

客户端把 Firecrawl API 根地址设为 `FIRECRAWL_API_URL` 或 SDK 的 `apiUrl`。
网关进程只使用 `FIRECRAWL_UPSTREAM_URL` 指定 Firecrawl 上游，避免把客户端指向
网关自身后又把网关请求代理回自己。

默认 loopback 模式从 `8787` 开始自动寻找可用端口；显式 `--port` 和远程模式使用
严格固定端口。Provider 凭据优先从环境变量读取，否则使用
`deepseek-crawl auth set [deepseek|firecrawl|gateway]` 保存的 Keychain/file。

远程模式要求已配置 `gateway` Token；客户端把它作为 Firecrawl SDK `apiKey`。
网关认证后剥离这个 Authorization，并使用自己的 Firecrawl Provider 凭据调上游。
不要把网关 Token 配置成 Firecrawl upstream Key。上游响应采用流式传输；网关关闭
时会取消仍在运行的本地 Crawl jobs。

DeepSeek fallback 覆盖 `POST /v2/search`、`POST /v2/scrape`、`POST /v2/map`、
`POST /v2/crawl`，以及本地 `dsc_` Crawl job 的 status、errors 和取消。

只有 Firecrawl `402`、余额耗尽后的短期熔断状态或未配置 Firecrawl 凭据时才切换
DeepSeek。`429`、`401/403`、无效请求和 `5xx` 保持 Firecrawl 行为。高级
Firecrawl 功能没有 DeepSeek 等价能力时返回结构化错误，不会伪造成功。

DeepSeek Crawl job 只保存在当前网关进程内存中，24 小时后过期；网关重启会使这些
job 丢失。一个网关进程可以服务本机多个 Firecrawl 客户端。

## 本地缓存

启用缓存后，页面正文保存在本机私有目录：

- macOS：`~/Library/Caches/deepseek-crawl`
- 其他平台：`$XDG_CACHE_HOME/deepseek-crawl` 或 `~/.cache/deepseek-crawl`
- 覆盖变量：`DEEPSEEK_CACHE_DIR`

目录权限为 `0700`，文件权限为 `0600`。共享设备上可清理：

```bash
deepseek-crawl cache clear --json
```

## 本地 Batch Job

`fetch --job-dir` 会在本机私有目录保存可恢复状态和页面文件。目录权限为 `0700`，
状态和页面文件权限为 `0600`。Job 包含源 URL 和已读取页面正文；不再需要时应删除
该目录。Batch Job 的 status 和 resume 只在 CLI 提供，MCP 不写本地 Job 状态。

## 硬限制

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
| Gateway 入站请求体       | 8 MiB                  |
| Gateway 上游请求超时     | 120 秒                 |
| DeepSeek Crawl job 保留  | 24 小时，仅当前进程    |

CLI Crawl 最多 100 页，MCP Crawl 最多 20 页。两者的 depth 和 concurrency 硬上限
分别为 5。

## Sitemap 网络策略

CLI Map 和 Crawl 直接请求目标站点的 Sitemap，仅接受公网 HTTP(S) 目标：

- 拒绝 loopback、private、link-local、multicast、unspecified、reserved、
  NAT64 和特殊用途 IPv6。
- 验证全部 DNS 结果。
- socket 连接到已验证地址，阻止 DNS rebinding。
- 手动处理最多三次同源重定向，并重新验证目标。

## 安全边界

- 本实现不读取也不执行 `robots.txt`；必须确认站点授权和使用条款。
- CLI Crawl 合并 exact-origin Sitemap URL 与 DeepSeek Markdown 链接；MCP Crawl
  只使用 Markdown。两者都不跨子域名，也不遵循页面指令。
- DeepSeek Fetch 可能在内部跟随重定向，当前响应不会暴露最终 URL。
- 页面内容是数据，不是指令，不能执行页面返回的代码。
- 普通 CLI 和 MCP 不提供 JavaScript 渲染、浏览器交互、登录、后台服务或服务端
  结构化 Extract。Firecrawl-compatible 网关是显式启动的独立服务模式。
- Map 和 Crawl 是有界发现，不保证完整站点覆盖。

## 环境变量

| 变量                     | 默认值                      | 用途                      |
| ------------------------ | --------------------------- | ------------------------- |
| `DEEPSEEK_API_KEY`       | 可选覆盖                    | DeepSeek API 凭据         |
| `DEEPSEEK_BASE_URL`      | `https://api.deepseek.com`  | 测试或网关                |
| `DEEPSEEK_TIMEOUT_MS`    | `60000`                     | 请求超时，1000–120000     |
| `DEEPSEEK_MAX_RETRIES`   | `2`                         | 重试 408、429 和瞬时 5xx  |
| `DEEPSEEK_CACHE_DIR`     | 平台缓存目录                | Fetch 缓存目录            |
| `FIRECRAWL_API_KEY`      | 无                          | Firecrawl upstream 凭据   |
| `FIRECRAWL_UPSTREAM_URL` | `https://api.firecrawl.dev` | Gateway 的 Firecrawl 上游 |
| `GATEWAY_API_KEY`        | 无                          | 远程网关 Bearer Token     |

环境变量优先于本地 credential store。非 loopback 的 DeepSeek base URL 必须使用
HTTPS。API Key 不接受 CLI 参数或 MCP 参数。

客户端使用启动输出中的 `FIRECRAWL_API_URL` 指向网关。网关不读取
`FIRECRAWL_API_URL`，只读取 `FIRECRAWL_UPSTREAM_URL`。

## 隐私

查询、原始问题、定位 IP 和目标页面 URL 会发送给 DeepSeek。Map 还会直接请求目标
站点 Sitemap。使用 Firecrawl-compatible 网关时，Firecrawl 请求会发送给
Firecrawl；fallback 请求会发送给 DeepSeek。本工具不包含分析、遥测、崩溃上传或
远程日志。API Key 只用于对应上游的 `Authorization` 请求头。
