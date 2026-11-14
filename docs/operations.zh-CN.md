# 运行限制、安全与 MCP

[English](operations.md) | **简体中文** | [返回 README](../README.md)

本指南覆盖计费、MCP、本地缓存、硬限制、Sitemap 网络策略、环境变量和隐私。

## 计费

- Search 按成功请求计费。
- Fetch 按成功页面请求计费。
- Map 会通过 DeepSeek Fetch 读取种子页，因此计费。
- Crawl 对每个成功读取的页面调用 DeepSeek Fetch。

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
- 不提供 JavaScript 渲染、浏览器交互、登录、后台服务或服务端结构化 Extract。
- Map 和 Crawl 是有界发现，不保证完整站点覆盖。

## 环境变量

| 变量                   | 默认值                     | 用途                     |
| ---------------------- | -------------------------- | ------------------------ |
| `DEEPSEEK_API_KEY`     | 可选覆盖                   | DeepSeek API 凭据        |
| `DEEPSEEK_BASE_URL`    | `https://api.deepseek.com` | 测试或网关               |
| `DEEPSEEK_TIMEOUT_MS`  | `60000`                    | 请求超时，1000–120000    |
| `DEEPSEEK_MAX_RETRIES` | `2`                        | 重试 408、429 和瞬时 5xx |
| `DEEPSEEK_CACHE_DIR`   | 平台缓存目录               | Fetch 缓存目录           |

非 loopback 的 DeepSeek base URL 必须使用 HTTPS。API Key 不接受 CLI 参数或 MCP
参数。

## 隐私

查询、原始问题、定位 IP 和目标页面 URL 会发送给 DeepSeek。Map 还会直接请求目标
站点 Sitemap。本工具不包含分析、遥测、崩溃上传或远程日志。API Key 只用于 DeepSeek
的 `Authorization` 请求头。
