# 部署 Firecrawl-compatible 网关

[English](deploying.md) | **简体中文** | [返回 README](../README.md)

网关可以前台运行，也可以作为 Docker 或 systemd 管理的 Node.js 服务运行。
TLS 和面向公网的全局限流应放在反向代理层。

## 必需配置

远程模式至少需要：

```dotenv
GATEWAY_API_KEY=替换为足够长的随机密钥
DEEPSEEK_API_KEY=sk-...
```

可选：

```dotenv
FIRECRAWL_API_KEY=fc-...
FIRECRAWL_UPSTREAM_URL=https://api.firecrawl.dev
DEEPSEEK_GATEWAY_PROVIDER_MODE=firecrawl-first
DEEPSEEK_GATEWAY_CREDITS_COOLDOWN_SECONDS=60
DEEPSEEK_GATEWAY_MAX_CONCURRENT_REQUESTS=100
DEEPSEEK_GATEWAY_MAX_PROVIDER_REQUESTS=100
DEEPSEEK_GATEWAY_MAX_CRAWL_JOBS=10
DEEPSEEK_GATEWAY_MAX_RETAINED_CRAWL_JOBS=100
```

Provider 模式默认为 `firecrawl-first`。设为 `deepseek-first` 可让常用路由直接
使用 DeepSeek；设为 `no-fallback` 会让常用路由始终使用 Firecrawl，并原样返回
额度错误。

额度熔断默认 60 秒，只在 `firecrawl-first` 生效。设为 `0` 表示每次请求都重新
尝试 Firecrawl。

并发默认有硬上限。若当前网关与其他任务共享 Provider 限流，可降低
`DEEPSEEK_GATEWAY_MAX_PROVIDER_REQUESTS` 或
`DEEPSEEK_GATEWAY_MAX_CRAWL_JOBS`。

环境文件权限应为 `0600`。不要把 Token 写入镜像、Compose 文件、命令行或仓库。

## Docker Compose

```bash
install -m 0600 .env.example .env
# 填写 GATEWAY_API_KEY 和 DEEPSEEK_API_KEY；有 Firecrawl 时再填 FIRECRAWL_API_KEY
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 gateway
```

Compose 示例会：

- 使用镜像中的非 root `node` 用户
- 只在宿主机 `127.0.0.1:8787` 发布端口
- 使用只读根文件系统和可写 `/tmp`
- 丢弃 Linux capabilities
- 通过 `init: true` 正确转发 `SIGTERM`
- 给优雅关闭最多 30 秒
- 限制并轮转 JSON 日志

健康检查：

```bash
curl --fail --silent http://127.0.0.1:8787/healthz
```

在源码仓库中可以用下面的命令验证完整的容器生命周期，不会产生 Provider 计费请求：

```bash
npm run smoke:docker
```

停止：

```bash
docker compose down
```

## systemd

将构建后的包安装到 `/opt/deepseek-crawl`，创建专用 `deepseek-crawl` 用户，并将
环境文件放在 `/etc/deepseek-crawl/gateway.env`，权限设为 `0600`。

```bash
sudo install -d -m 0750 -o deepseek-crawl -g deepseek-crawl /opt/deepseek-crawl
sudo install -d -m 0750 -o deepseek-crawl -g deepseek-crawl /etc/deepseek-crawl
sudo install -m 0644 deploy/deepseek-crawl-gateway.service \
  /etc/systemd/system/deepseek-crawl-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now deepseek-crawl-gateway
sudo systemctl status deepseek-crawl-gateway
```

服务使用 `SIGTERM`，最多等待 30 秒，把运行状态放在
`/var/lib/deepseek-crawl`，JSON 请求日志写入 journald。

## 反向代理

可以从 [nginx-gateway.conf](../deploy/nginx-gateway.conf) 开始。示例提供 TLS、
全局请求限流和 8 MiB 请求体限制，并关闭 proxy buffering，保证流式响应不被
代理层重新整包缓冲。

Firecrawl 客户端连接公网 HTTPS 地址：

```js
const client = new Firecrawl({
  apiUrl: "https://crawl.example.com",
  apiKey: process.env.GATEWAY_API_KEY,
});
```

网关认证限流看到的是反向代理地址。保留代理层全局限流，并且只有在信任边界明确时
才配置真实客户端 IP 的传递。

## 运行限制

- Crawl jobs、认证限流和运行状态都属于单个进程。
- 不要把多个网关副本直接放到负载均衡后面，除非重新设计轮询、认证限流和任务路由。
- WebSocket `Watcher` 不受支持，请轮询 Crawl 状态。
- `gateway status` 适合同一主机；容器内应使用 `/healthz` 和容器健康状态。
- Provider Key 和 `GATEWAY_API_KEY` 不会写入请求日志。

## 优雅关闭

Docker 和 systemd 都发送 `SIGTERM`。网关关闭时会：

1. 停止接受新连接
2. 取消仍在运行的本地 DeepSeek Crawl jobs
3. 排空在途 HTTP 请求
4. 关闭空闲 keep-alive 连接
5. 删除运行状态文件

预计有长时间流式响应时，进程管理器的停止超时应大于请求超时。
