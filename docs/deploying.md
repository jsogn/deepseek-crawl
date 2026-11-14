# Deploying the Firecrawl-Compatible Gateway

**English** | [简体中文](deploying.zh-CN.md) | [Back to README](../README.en.md)

The gateway can run as a local foreground process, a Docker service, or a
systemd-managed Node.js process. TLS and internet-facing rate limiting belong at
a reverse proxy.

## Required configuration

Remote mode requires:

```dotenv
GATEWAY_API_KEY=replace-with-a-long-random-secret
DEEPSEEK_API_KEY=sk-...
```

Optional:

```dotenv
FIRECRAWL_API_KEY=fc-...
FIRECRAWL_UPSTREAM_URL=https://api.firecrawl.dev
```

Keep the environment file private (`0600`). Never put these values in an image,
Compose file, shell command, or repository.

## Docker Compose

```bash
install -m 0600 .env.example .env
# Fill GATEWAY_API_KEY and DEEPSEEK_API_KEY. Add FIRECRAWL_API_KEY if available.
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 gateway
```

The Compose example:

- runs as the unprivileged `node` user from the Docker image
- publishes only `127.0.0.1:8787` on the host
- uses a read-only root filesystem and writable `/tmp`
- drops Linux capabilities
- forwards `SIGTERM` with `init: true`
- allows 30 seconds for graceful shutdown
- rotates JSON logs

Docker health:

```bash
curl --fail --silent http://127.0.0.1:8787/healthz
```

From a source checkout, maintainers can verify the full container lifecycle
without paid provider requests:

```bash
npm run smoke:docker
```

Stop:

```bash
docker compose down
```

## systemd

Install the built package under `/opt/deepseek-crawl`, create a dedicated
`deepseek-crawl` user, and place the environment file at
`/etc/deepseek-crawl/gateway.env` with mode `0600`.

```bash
sudo install -d -m 0750 -o deepseek-crawl -g deepseek-crawl /opt/deepseek-crawl
sudo install -d -m 0750 -o deepseek-crawl -g deepseek-crawl /etc/deepseek-crawl
sudo install -m 0644 deploy/deepseek-crawl-gateway.service \
  /etc/systemd/system/deepseek-crawl-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now deepseek-crawl-gateway
sudo systemctl status deepseek-crawl-gateway
```

The service sends `SIGTERM`, waits up to 30 seconds, keeps runtime state under
`/var/lib/deepseek-crawl`, and writes JSON request logs to journald.

## Reverse proxy

Use [nginx-gateway.conf](../deploy/nginx-gateway.conf) as a starting point. It
adds TLS, a global request rate, an 8 MiB body limit, and disables proxy
buffering so streamed Crawl responses remain streaming.

Point Firecrawl clients at the public HTTPS origin:

```js
const client = new Firecrawl({
  apiUrl: "https://crawl.example.com",
  apiKey: process.env.GATEWAY_API_KEY,
});
```

The gateway authentication limiter sees the reverse proxy address. Keep the
proxy rate limit enabled and configure trusted real-IP handling only when its
trust boundary is correct.

## Operational constraints

- Crawl jobs, the authentication limiter, and runtime state are process-local.
- Do not put multiple gateway replicas behind a load balancer unless polling,
  authentication limits, and job placement are redesigned.
- WebSocket `Watcher` is unsupported. Poll Crawl status instead.
- `gateway status` is useful on the same host. Inside a container, use
  `/healthz` and container health instead.
- Provider keys and `GATEWAY_API_KEY` are never written to request logs.

## Graceful shutdown

Docker and systemd both use `SIGTERM`. On shutdown the gateway:

1. stops accepting new connections
2. cancels active local DeepSeek Crawl jobs
3. drains in-flight HTTP requests
4. closes idle keep-alive connections
5. removes its runtime state file

Keep the process-manager stop timeout above the configured request timeout when
long streaming responses are expected.
