#!/usr/bin/env bash

set -Eeuo pipefail

container_name="deepseek-crawl-gateway-smoke-$$"
image_name="${DOCKER_SMOKE_IMAGE:-deepseek-crawl-gateway:smoke}"
gateway_token="smoke-gateway-token"
deepseek_token="smoke-deepseek-token"
provider_mode="no-fallback"
credits_cooldown_seconds="0"
max_concurrent_requests="7"
max_provider_requests="5"
max_crawl_jobs="3"
max_retained_crawl_jobs="9"
platform="${DOCKER_SMOKE_PLATFORM:-}"

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

build_args=(--tag "$image_name")
if [[ -n "$platform" ]]; then
  build_args+=(--platform "$platform")
fi
if [[ -n "${DOCKER_SMOKE_NODE_IMAGE:-}" ]]; then
  build_args+=(--build-arg "NODE_IMAGE=$DOCKER_SMOKE_NODE_IMAGE")
fi
docker build "${build_args[@]}" .

run_args=(
  --detach
  --name "$container_name"
  --publish "127.0.0.1::8787"
  --env "GATEWAY_API_KEY=$gateway_token"
  --env "DEEPSEEK_API_KEY=$deepseek_token"
  --env "DEEPSEEK_GATEWAY_PROVIDER_MODE=$provider_mode"
  --env "DEEPSEEK_GATEWAY_CREDITS_COOLDOWN_SECONDS=$credits_cooldown_seconds"
  --env "DEEPSEEK_GATEWAY_MAX_CONCURRENT_REQUESTS=$max_concurrent_requests"
  --env "DEEPSEEK_GATEWAY_MAX_PROVIDER_REQUESTS=$max_provider_requests"
  --env "DEEPSEEK_GATEWAY_MAX_CRAWL_JOBS=$max_crawl_jobs"
  --env "DEEPSEEK_GATEWAY_MAX_RETAINED_CRAWL_JOBS=$max_retained_crawl_jobs"
)
if [[ -n "$platform" ]]; then
  run_args+=(--platform "$platform")
fi
docker run "${run_args[@]}" "$image_name" >/dev/null

container_health=""
for ((attempt = 1; attempt <= 90; attempt += 1)); do
  container_health="$(
    docker inspect "$container_name" \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      2>/dev/null || true
  )"
  if [[ "$container_health" == "healthy" ]]; then
    break
  fi
  if [[ "$container_health" == "unhealthy" ]]; then
    docker logs "$container_name" >&2 || true
    printf 'Docker gateway did not become healthy: %s\n' "$container_health" >&2
    exit 1
  fi
  container_state="$(
    docker inspect "$container_name" --format '{{.State.Status}}' 2>/dev/null || true
  )"
  if [[ "$container_state" == "exited" || "$container_state" == "dead" ]]; then
    docker logs "$container_name" >&2 || true
    printf 'Docker gateway stopped before becoming healthy: %s\n' "$container_state" >&2
    exit 1
  fi
  sleep 1
done
if [[ "$container_health" != "healthy" ]]; then
  docker logs "$container_name" >&2 || true
  printf 'Timed out waiting for Docker gateway health: %s\n' "$container_health" >&2
  exit 1
fi

mapped_port="$(
  docker port "$container_name" 8787/tcp |
    awk -F: 'NR == 1 { print $NF }'
)"
if [[ -z "$mapped_port" ]]; then
  printf 'Docker gateway did not publish port 8787.\n' >&2
  exit 1
fi

health_response="$(
  curl --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:${mapped_port}/healthz"
)"
case "$health_response" in
  *'"status":"ok"'*) ;;
  *)
    printf 'Unexpected Docker gateway health response: %s\n' "$health_response" >&2
    exit 1
    ;;
esac
case "$health_response" in
  *'"mode":"remote"'*) ;;
  *)
    printf 'Docker gateway did not start in remote mode: %s\n' "$health_response" >&2
    exit 1
    ;;
esac
case "$health_response" in
  *'"provider_mode":"no-fallback"'*) ;;
  *)
    printf 'Docker gateway did not expose the configured provider mode: %s\n' \
      "$health_response" >&2
    exit 1
    ;;
esac
case "$health_response" in
  *'"credits_cooldown_seconds":0'*) ;;
  *)
    printf 'Docker gateway did not expose the configured cooldown: %s\n' \
      "$health_response" >&2
    exit 1
    ;;
esac
case "$health_response" in
  *'"max_concurrent_requests":7'*'"max_concurrent_provider_requests":5'*) ;;
  *)
    printf 'Docker gateway did not expose the configured HTTP/provider capacity: %s\n' \
      "$health_response" >&2
    exit 1
    ;;
esac
case "$health_response" in
  *'"max_active_crawl_jobs":3'*'"max_retained_crawl_jobs":9'*) ;;
  *)
    printf 'Docker gateway did not expose the configured Crawl capacity: %s\n' \
      "$health_response" >&2
    exit 1
    ;;
esac

container_uid="$(docker exec "$container_name" id -u)"
if [[ "$container_uid" == "0" ]]; then
  printf 'Docker gateway is running as root.\n' >&2
  exit 1
fi

container_logs="$(docker logs "$container_name" 2>&1)"
if [[ "$container_logs" == *"$gateway_token"* || "$container_logs" == *"$deepseek_token"* ]]; then
  printf 'Docker gateway logs contain a test credential.\n' >&2
  exit 1
fi

docker stop --timeout 30 "$container_name" >/dev/null
exit_code="$(docker inspect "$container_name" --format '{{.State.ExitCode}}')"
if [[ "$exit_code" != "0" ]]; then
  docker logs "$container_name" >&2 || true
  printf 'Docker gateway did not stop gracefully: exit code %s\n' "$exit_code" >&2
  exit 1
fi

printf 'Docker gateway smoke passed: health=%s, uid=%s, provider=%s, cooldown=%ss, http=%s, provider_requests=%s, crawl_jobs=%s, retained_jobs=%s, exit=%s\n' \
  "$container_health" "$container_uid" "$provider_mode" "$credits_cooldown_seconds" \
  "$max_concurrent_requests" "$max_provider_requests" "$max_crawl_jobs" \
  "$max_retained_crawl_jobs" "$exit_code"
