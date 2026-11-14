# 批量读取与 Crawl 工作流

[English](workflows.md) | **简体中文** | [返回 README](../README.md)

本指南覆盖 Batch Fetch、Crawl Plan、增量对比、Change Monitor、可恢复任务和失败
重试。日常单页读取只需要 `fetch`；本指南适用于已知 URL 列表或需要遍历文档区域
的任务。

## 先选对工作流

| 目标                     | 推荐方式                              |
| ------------------------ | ------------------------------------- |
| 已有一批明确 URL         | `map --search` 后执行 Batch Fetch     |
| 先确认文档区域有哪些页面 | `crawl --plan-only`                   |
| 读取一个受限文档区域     | 有界 `crawl`                          |
| 比较两次抓取结果         | `crawl --baseline` 或 `crawl monitor` |
| 长时间任务意外中断       | `crawl resume`                        |
| 上次有部分页面失败       | Batch Retry 或 Crawl Retry            |

已知 URL 列表通常比整站 Crawl 更省请求。Crawl 用于确实需要页面发现和区域遍历的
场景，并始终受 origin、深度、页数、并发和路径过滤器约束。

## 批量 Fetch

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

`--input` 支持：

- Map JSON
- URL 字符串数组
- 包含 `url` 字段的对象数组
- 逐行 URL 文本
- `-`：从 stdin 读取

`--output-dir` 必须不存在。成功读取的页面写入稳定路径，部分失败不会丢弃成功页面。
输出目录包含 `fetch.json` 和 `pages/*.md`。

### Map 后发现并批量读取

```bash
deepseek-crawl map "https://api-docs.deepseek.com/" \
  --search guides \
  --json \
  -o .deepseek-crawl/map-docs.json

deepseek-crawl fetch \
  --input .deepseek-crawl/map-docs.json \
  --output-dir .deepseek-crawl/pages-docs \
  --concurrency 3 \
  --delay-ms 250
```

全部页面失败时仍会发布诊断报告，但命令退出码为 `1`。

### 缓存

缓存默认关闭。重复研究相同页面时显式设置 TTL：

```bash
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  --cache-ttl 3600 \
  --json
```

`--fresh` 强制调用 DeepSeek 并刷新缓存。只缓存成功响应。`retrieved_from` 表示
页面来自 `api` 还是 `cache`；Batch、Crawl、Plan 和 Retry 还提供缓存统计。

缓存命中在进入网络 scheduler 前解析，不应用 API 请求的 `--delay-ms` 和并发等待；
只有 cache miss 会进入 DeepSeek 限速。

默认缓存目录：

- macOS：`~/Library/Caches/deepseek-crawl`
- 其他平台：`$XDG_CACHE_HOME/deepseek-crawl` 或 `~/.cache/deepseek-crawl`
- 可用 `DEEPSEEK_CACHE_DIR` 覆盖

目录权限为 `0700`，文件权限为 `0600`。清理命令：

```bash
deepseek-crawl cache clear --json
```

### 只重试失败页面

```bash
deepseek-crawl fetch \
  --retry-failed .deepseek-crawl/pages-docs/fetch.json \
  --output-dir .deepseek-crawl/pages-docs-retry \
  --concurrency 3 \
  --delay-ms 250 \
  --cache-ttl 3600 \
  --json
```

Retry 忽略已成功页面，只请求可规范化的失败 URL。输出写入新目录，并保留
`retry_of`、原始索引和上次失败原因。无效 URL 进入 `retry_of.skipped`，重复失败
计入 `retry_of.deduplicated`。

## Crawl Plan

大面积 Crawl 前先生成初始发现计划：

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/" \
  --plan-only \
  --max-depth 1 \
  --max-pages 20 \
  --include-paths "/guides/*" \
  -o .deepseek-crawl/deepseek-guides-plan.json
```

Plan 只读取种子页和 Sitemap，不读取已发现子页面。`-o` 此时是单文件 JSON 路径，
目标不能已存在。

- `urls`：限制后选中的页面，可直接作为 Batch Fetch 输入。
- `deferred`：因页数限制延后的 URL。
- `filtered`：因跨域、路径过滤或发现上限省略的 URL。
- `diagnostics_truncated`：候选过多时诊断明细被截断。

Plan 描述初始深度 1 frontier，不代表递归发现后的完整站点。

## 执行有界 Crawl

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
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--json]
```

默认深度 `2`、最多 `20` 页、并发 `2`、请求间隔 `250 ms`。种子页深度为 `0`。
遍历按确定性深度层执行，只访问种子页的 exact origin，并记录部分失败。

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

Sitemap 模式：

- `include`：Sitemap 与种子页 Markdown 链接合并，默认值。
- `only`：只用 Sitemap URL。
- `skip`：只用 Markdown 链接。

Sitemap URL 从深度 1 开始，并遵守相同的 origin、路径、query、深度、页数和发现
限制。Sitemap 失败产生 warning；种子页失败是致命错误。

路径规则：

- 不含通配符时按路径段前缀匹配。
- `*` 匹配任意字符，`?` 匹配单个字符。
- include 为 OR；任一 exclude 命中时优先排除。
- 种子页始终读取。

成功输出：

```text
.deepseek-crawl/crawl-deepseek-guides/
  crawl.json
  pages/
    0001-page.md
    0002-example-docs.md
```

Crawl 先写隐藏 staging 目录，成功后整体发布。`-o` 目标不能已存在。SIGINT 会
中止请求、清理 staging，并以退出码 `130` 结束。

`crawl.json` 使用 schema v2，保存设置、统计、失败、warnings、页面来源、
`content_hash`、`sitemap_lastmod` 和稳定页面路径，不重复保存正文。

## 增量对比

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/guides/" \
  --baseline .deepseek-crawl/crawl-deepseek-guides/crawl.json \
  --changed-only \
  --cache-ttl 3600 \
  -o .deepseek-crawl/crawl-deepseek-guides-changes
```

`--baseline` 可以指向 schema v2 的 `crawl.json` 或包含该文件的目录。v1 报告会
被明确拒绝，不提供迁移兼容。`content_hash` 是 DeepSeek 原始 Markdown 在本地
截断前计算的 SHA-256。

`changes` 包括 `added`、`modified`、`unchanged`、`removed`。`--changed-only`
只写新增和修改页面；未变化页面仍保留在报告和统计中。

启用 baseline 和 `--changed-only` 时，如果页面位于当前 Crawl 的最深层、由 Sitemap
发现，且当前 `lastmod` 与 baseline 中保存的有效值相同，Crawl 会复用 baseline 的
`content_hash` 和页面摘要，不调用 DeepSeek Fetch。`stats.sitemap_lastmod_skipped`
报告跳过数量，页面仍出现在 `changes.unchanged` 中且不写页面文件。

更新、倒退、缺失或无效的 `lastmod` 都会正常读取页面。中间层页面也不会跳过，因为
其正文可能包含更深层链接。v2 baseline 允许单页缺少 `sitemap_lastmod`，该页正常
读取；页面摘要本身是必填结构。

## 持久化 Change Monitor

Monitor 只运行一次并退出，适合 cron、CI、系统定时器或 Agent Automation 重复调用：

```bash
deepseek-crawl crawl monitor "https://api-docs.deepseek.com/guides/" \
  --monitor-dir .deepseek-crawl/monitor/deepseek-guides \
  --max-depth 1 \
  --max-pages 20 \
  --include-paths "/guides/*" \
  --cache-ttl 3600 \
  --fail-on-change \
  -o .deepseek-crawl/monitor/deepseek-guides-runs \
  --json
```

状态目录保存 schema v2 baseline、抓取范围和最近结果。首次成功运行只建立 baseline。
后续运行创建新的时间戳输出目录，发布成功后才原子轮换 `state.json`。v1 state 会被
拒绝，必须 reset 后重新初始化。

首次运行固化 seed、深度、页数、过滤器、Sitemap 和并发参数。需要改变抓取范围时，
先执行 reset，再重新初始化。

```bash
deepseek-crawl crawl monitor status \
  .deepseek-crawl/monitor/deepseek-guides \
  --json

deepseek-crawl crawl monitor reset \
  .deepseek-crawl/monitor/deepseek-guides \
  --json
```

- `--fail-on-change`：存在有效变化时以退出码 `3` 结束。
- `--ignore-removed`：removed 不触发失败。
- `--only-modified`：只有 modified 触发，并只写 modified 页面。

同一 monitor 目录只允许一个 writer；失效 PID 锁可自动恢复。

## 可恢复 Crawl

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

`--job-dir` 保存 schema v2 的 `job.json`、页面、frontier、失败和 `writer.lock`。
每个页面完成后原子 checkpoint。中断不会删除 job；resume 跳过已完成的 seed、
Sitemap 发现和页面，只继续未完成工作。v1 job 会被拒绝。

`--job-dir` 暂不能与 `--plan-only`、`--baseline` 或 Retry 组合使用。

## 重试 Crawl 失败页

```bash
deepseek-crawl crawl \
  --retry-failed .deepseek-crawl/crawl-deepseek-guides/crawl.json \
  -o .deepseek-crawl/crawl-deepseek-guides-retry \
  --cache-ttl 3600 \
  --json
```

Crawl Retry 不重新读取种子页或成功页面，只重试仍在原 origin、depth 和页数范围内
的失败 URL。原始 index、depth、sources 和失败原因保留；跨域、无效或超限项目写入
`retry_of.skipped`。
