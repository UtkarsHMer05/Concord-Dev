#!/usr/bin/env bash
# P6-M027 — Build and smoke-test the hardened release images (LOCAL ONLY).
#
# Images build from a CLEAN TREE of HEAD (git archive) — never the dirty
# working tree: in-flight edits must not leak into release artifacts, and
# the build must be reproducible from exactly what is committed.
#
# Verifies:
#   - images build clean from the exported tree
#   - gateway container starts, /api/v1/health/live responds, runs as
#     non-root (uid 10001), then stops
#   - web container is build-verified (full boot requires Clerk + DB env;
#     the smoke boots with a dummy DATABASE_URL and asserts the Next server
#     process starts serving — any HTTP response proves liveness)
# Then reports PASS/FAIL per image. No deployment.
#
# Usage: scripts/release/smoke-images.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

WORK=$(mktemp -d /tmp/concord-release-smoke.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
# Clean export of HEAD (tracked files only; no ignored/private content,
# no in-flight working-tree changes). public/wasm + .next are git-ignored
# build products — the web stage builds them inside the image.
git archive HEAD | tar -x -C "$WORK"
note_export() { printf '  clean tree: %s (%s files)\n' "$(git rev-parse --short HEAD)" "$(git ls-tree -r HEAD --name-only | wc -l | tr -d ' ')"; }
note_export

PASS=()
FAIL=()

note() { printf '  %s\n' "$*"; }

smoke_gateway() {
  local tag=concord-gateway:smoke
  note "building gateway image…"
  docker build -q -f docker/gateway.Dockerfile -t "$tag" "$WORK" >/dev/null
  note "starting gateway (loopback, dummy DB URL → it must still boot + serve health)…"
  local cid
  cid=$(docker run -d --rm \
    -e GATEWAY_BIND_HOST=0.0.0.0 \
    -e GATEWAY_BIND_PORT=8791 \
    --network host \
    -e GATEWAY_DATABASE_URL=postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test \
    -e GATEWAY_CLERK_ISSUER=https://fun-blowfish-5798.clerk.accounts.dev \
    "$tag")
  # The gateway fail-fast-exits (by design) without a reachable DB, so the
  # smoke uses the real loopback dev DB via host networking; no NATS/Redis
  # env → gateway runs degraded (local-only bus + no redis), which is the
  # documented posture for a packaging smoke. No client traffic is sent.
  local live=1
  for _ in $(seq 1 20); do
    if curl -sf "http://127.0.0.1:8791/api/v1/health/live" >/dev/null 2>&1; then live=0; break; fi
    sleep 0.5
  done
  local uid
  uid=$(docker exec "$cid" id -u 2>/dev/null || echo unknown)
  docker rm -f "$cid" >/dev/null 2>&1 || true
  if [ "$live" -eq 0 ] && [ "$uid" = "10001" ]; then
    note "gateway: health/live OK, uid=$uid (non-root) — PASS"
    PASS+=("gateway")
  else
    note "gateway: health/live=$live uid=$uid — FAIL"
    FAIL+=("gateway")
  fi
}

smoke_web() {
  local tag=concord-web:smoke
  note "building web image…"
  docker build -q -f docker/web.Dockerfile -t "$tag" "$WORK" >/dev/null
  note "starting web (dummy DB URL; process liveness via HTTP)…"
  local cid
  cid=$(docker run -d --rm -p 127.0.0.1:13000:3000 \
    -e DATABASE_URL=postgres://user:pass@127.0.0.1:1/none \
    -e NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_dummy \
    -e CLERK_SECRET_KEY=sk_test_dummy \
    "$tag")
  local up=1
  for _ in $(seq 1 40); do
    # Any HTTP response (even 5xx) proves the Next server is up.
    if curl -s -o /dev/null "http://127.0.0.1:13000/api/health" >/dev/null 2>&1; then up=0; break; fi
    curl -s -o /dev/null --connect-timeout 1 "http://127.0.0.1:13000/" >/dev/null 2>&1 && { up=0; break; }
    sleep 0.5
  done
  local uid
  uid=$(docker exec "$cid" id -u 2>/dev/null || echo unknown)
  docker rm -f "$cid" >/dev/null 2>&1 || true
  if [ "$up" -eq 0 ] && [ "$uid" = "1000" ]; then
    note "web: HTTP server responding, uid=$uid (non-root) — PASS"
    PASS+=("web")
  else
    note "web: http-up=$up uid=$uid — FAIL"
    FAIL+=("web")
  fi
}

echo "=== P6-M027 release-image smoke (local only) ==="
smoke_gateway
smoke_web
echo
if [ "${#FAIL[@]}" -eq 0 ]; then
  echo "RESULT: PASS (${#PASS[@]}/${#PASS[@]} images)"
else
  echo "RESULT: FAIL — images: ${FAIL[*]}"
  exit 1
fi
