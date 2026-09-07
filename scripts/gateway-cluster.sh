#!/usr/bin/env bash
# Phase 4 local cluster launcher (P4-M026/M027).
#
# Runs THREE gateway processes on the HOST (built for this machine — the
# release binary is Mach-O; containerizing the binary is Phase 7 image
# work) plus an nginx load balancer container proxying to them. Infra
# services (Postgres/NATS/Redis) run via docker compose.
#
#   ./scripts/gateway-cluster.sh start   # boots gw1-3 + lb
#   ./scripts/gateway-cluster.sh stop    # stops everything
#
# LB endpoint: ws://127.0.0.1:8890/api/v1/sync (round-robin, WS-upgrade).
set -euo pipefail
cd "$(dirname "$0")/.."

GW_BIN="rust/target/release/sync-gateway"
LB_PORT=8890
GW_PORTS=(8791 8792 8793)
PIDS=()

start() {
  test -x "$GW_BIN" || { echo "missing $GW_BIN — run cargo build --release"; exit 1; }
  docker compose up -d db nats redis >/dev/null
  common_env=(
    GATEWAY_DATABASE_URL="postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test"
    GATEWAY_CLERK_ISSUER="https://fun-blowfish-5798.clerk.accounts.dev"
    GATEWAY_NATS_URL="nats://127.0.0.1:4222"
    GATEWAY_REDIS_URL="redis://127.0.0.1:6379"
    GATEWAY_NATS_SUBJECT_PREFIX="concord.dev"
    RUST_LOG="info"
  )
  for i in 1 2 3; do
    port="${GW_PORTS[$((i-1))]}"
    echo "starting gateway$i on :$port"
    env "${common_env[@]}" \
      GATEWAY_ID="$i" GATEWAY_BIND_PORT="$port" \
      "$GW_BIN" > "/tmp/concord-gw$i.log" 2>&1 &
    PIDS+=("$!")
  done
  # LB container proxying to host gateways.
  docker rm -f concord-lb >/dev/null 2>&1 || true
  docker run -d --name concord-lb \
    -p "127.0.0.1:${LB_PORT}:8890" \
    -v "$(pwd)/scripts/lb/nginx.conf:/etc/nginx/nginx.conf:ro" \
    --add-host=host.docker.internal:host-gateway \
    nginx:1.29-alpine >/dev/null
  echo "cluster up: LB ws://127.0.0.1:${LB_PORT}/api/v1/sync over gateways ${GW_PORTS[*]}"
  echo "pids: ${PIDS[*]} (stop with $0 stop)"
}

stop() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  pkill -f "target/release/sync-gateway" 2>/dev/null || true
  docker rm -f concord-lb >/dev/null 2>&1 || true
  echo "cluster stopped"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop"; exit 2 ;;
esac
