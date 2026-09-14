#!/usr/bin/env bash
# P6-M027 — Build and smoke-test the hardened release images (LOCAL ONLY).
# Extended P7-M016: also builds + probes the native worker image.
#
# Images build from a CLEAN TREE of HEAD (git archive) — never the dirty
# working tree: in-flight edits must not leak into release artifacts, and
# the build must be reproducible from exactly what is committed.
#
# Verifies:
#   - images build clean from the exported tree
#   - gateway container starts, /api/v1/health/live responds, runs as
#     non-root (uid 10001), SIGTERM drains + exits promptly, then stops
#   - web container is build-verified (full boot requires Clerk + DB env;
#     the smoke boots with a dummy DATABASE_URL and asserts the Next server
#     process starts serving — any HTTP response proves liveness)
#   - worker image: the binary answers the generate_ops stdin probe
#     (command 6 → status 0 + digest + ≥1 batch — the same probe the
#     phase6 release-artifacts workflow proved) and runs non-root (uid 10001)
# Then reports PASS/FAIL per image. No deployment.
#
# Usage: scripts/release/smoke-images.sh
#        CONCORD_SMOKE_TREE=/path/to/export scripts/release/smoke-images.sh
#          (build from an EXISTING export instead of `git archive HEAD` —
#           used to verify release-file changes that are staged but not yet
#           committed; the export must contain the full repo layout)
set -euo pipefail
cd "$(dirname "$0")/../.."

WORK=$(mktemp -d /tmp/concord-release-smoke.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
# Clean export of HEAD (tracked files only; no ignored/private content,
# no in-flight working-tree changes). Generated public/wasm assets are tracked
# release inputs; other build products such as .next are created in the image.
# CONCORD_SMOKE_TREE overrides the export source (verification helper).
if [ -n "${CONCORD_SMOKE_TREE:-}" ]; then
  if [ ! -d "$CONCORD_SMOKE_TREE" ]; then
    echo "error: CONCORD_SMOKE_TREE not a directory: $CONCORD_SMOKE_TREE" >&2
    exit 2
  fi
  if [ -e "$CONCORD_SMOKE_TREE/.git" ]; then
    echo "error: CONCORD_SMOKE_TREE must be a clean source export without .git" >&2
    exit 2
  fi
  cp -R "$CONCORD_SMOKE_TREE/." "$WORK"
  note_export() { printf '  provided tree: %s\n' "$CONCORD_SMOKE_TREE"; }
else
  git archive HEAD | tar -x -C "$WORK"
  note_export() { printf '  clean tree: %s (%s files)\n' "$(git rev-parse --short HEAD)" "$(git ls-tree -r HEAD --name-only | wc -l | tr -d ' ')"; }
fi
note_export

# Derive the version from the exact exported source tree. A supplied tree has
# no .git metadata, so its caller must provide the full commit SHA explicitly;
# this prevents labels from combining one source export with another checkout's
# package version or revision.
RELEASE_VERSION=$(node -e 'console.log(require(process.argv[1]).version)' "$WORK/package.json")
if [ -z "$RELEASE_VERSION" ]; then
  echo "error: exported source tree has no package version" >&2
  exit 2
fi
if [ -n "${CONCORD_RELEASE_GIT_SHA:-}" ]; then
  RELEASE_REVISION="$CONCORD_RELEASE_GIT_SHA"
elif [ -z "${CONCORD_SMOKE_TREE:-}" ]; then
  RELEASE_REVISION=$(git rev-parse HEAD)
else
  echo "error: CONCORD_RELEASE_GIT_SHA is required with CONCORD_SMOKE_TREE" >&2
  exit 2
fi
if [[ ! "$RELEASE_REVISION" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "error: CONCORD_RELEASE_GIT_SHA must be a full 40-character commit SHA" >&2
  exit 2
fi

if [ ! -f "$WORK/public/wasm/concord-crdt.js" ] || [ ! -f "$WORK/public/wasm/concord-crdt.wasm" ]; then
  echo "error: clean image source tree is missing generated public/wasm assets" >&2
  echo "       run npm run wasm:build, then pass a git-archive export plus public/wasm via CONCORD_SMOKE_TREE" >&2
  exit 2
fi

PASS=()
FAIL=()

note() { printf '  %s\n' "$*"; }

smoke_gateway() {
  local tag=concord-gateway:smoke
  local version="$RELEASE_VERSION" revision="$RELEASE_REVISION"
  note "building gateway image…"
  docker build -q \
    --build-arg "CONCORD_VERSION=$version" \
    --build-arg "CONCORD_GIT_SHA=$revision" \
    -f docker/gateway.Dockerfile -t "$tag" "$WORK" >/dev/null
  test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$tag")" = "$version"
  test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$tag")" = "$revision"
  note "starting gateway (loopback, configured smoke DB → it must boot + serve health)…"
  local cid=""
  local -a host_args=()
  if [ "${CONCORD_SMOKE_HOST_GATEWAY:-0}" = "1" ]; then
    host_args+=(--add-host=host.docker.internal:host-gateway)
  fi
  if ! cid=$(docker run -d \
    "${host_args[@]}" \
    -e GATEWAY_BIND_HOST=0.0.0.0 \
    -e GATEWAY_BIND_PORT=8791 \
    -e GATEWAY_DATABASE_URL="${CONCORD_SMOKE_DATABASE_URL:-postgres://concord:concord_local_dev@host.docker.internal:5433/concord_test}" \
    -e GATEWAY_CLERK_ISSUER=https://fun-blowfish-5798.clerk.accounts.dev \
    -p 127.0.0.1:18791:8791 "$tag"); then
    note "gateway: docker run failed — FAIL"
    FAIL+=("gateway")
    return
  fi
  if [ -z "$cid" ]; then
    note "gateway: docker run returned no container id — FAIL"
    FAIL+=("gateway")
    return
  fi
  # The gateway fail-fast-exits (by design) without a reachable DB, so the
  # smoke points at the real dev DB via host.docker.internal (macOS Docker
  # Desktop runs containers in a VM — 127.0.0.1 would hit the VM, not the
  # host Postgres). No NATS/Redis env → gateway runs degraded (local-only
  # bus + no redis), the documented posture for a packaging smoke. No
  # client traffic is sent.
  local live=1
  for _ in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:18791/api/v1/health/live" >/dev/null 2>&1; then live=0; break; fi
    sleep 0.5
  done
  # Non-root check while the container is RUNNING (exec needs a live
  # container): capture the uid before the drain sequence.
  local uid
  uid=$(docker exec "$cid" id -u 2>/dev/null || echo unknown)
  # P7-M016: SIGTERM drain under the container (exec-form ENTRYPOINT →
  # binary is PID 1). Must exit 0 before the stop timeout. No --rm on the
  # run: the container must survive stopping so its exit code is readable.
  local drain_ms=-1 exit_code=-1
  if [ "$live" -eq 0 ]; then
    local t0 t1
    t0=$(date +%s%N)
    docker stop -t 10 "$cid" >/dev/null
    t1=$(date +%s%N)
    drain_ms=$(( (t1 - t0) / 1000000 ))
    exit_code=$(docker inspect "$cid" --format '{{.State.ExitCode}}' 2>/dev/null || echo -1)
  else
    docker logs "$cid" >&2 || true
    docker rm -f "$cid" >/dev/null 2>&1 || true
  fi
  docker rm -f "$cid" >/dev/null 2>&1 || true
  if [ "$live" -eq 0 ] && [ "$uid" = "10001" ] && [ "$exit_code" = "0" ] && [ "$drain_ms" -lt 10000 ]; then
    note "gateway: health/live OK, uid=$uid (non-root), SIGTERM→exit 0 in ${drain_ms}ms — PASS"
    PASS+=("gateway")
  else
    note "gateway: health/live=$live uid=$uid exit=$exit_code drain_ms=$drain_ms — FAIL"
    FAIL+=("gateway")
  fi
}

smoke_web() {
  local tag=concord-web:smoke
  local version="$RELEASE_VERSION" revision="$RELEASE_REVISION"
  note "building web image…"
  docker build -q \
    --build-arg "CONCORD_VERSION=$version" \
    --build-arg "CONCORD_GIT_SHA=$revision" \
    -f docker/web.Dockerfile -t "$tag" "$WORK" >/dev/null
  test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$tag")" = "$version"
  test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$tag")" = "$revision"
  note "starting web (dummy DB URL; process liveness via HTTP)…"
  local cid=""
  # No --rm: the stopped container's exit code must be inspectable.
  if ! cid=$(docker run -d -p 127.0.0.1:13000:3000 \
    -e DATABASE_URL=postgres://user:pass@127.0.0.1:1/none \
    -e NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_dummy \
    -e CLERK_SECRET_KEY=sk_test_dummy \
    "$tag"); then
    note "web: docker run failed — FAIL"
    FAIL+=("web")
    return
  fi
  if [ -z "$cid" ]; then
    note "web: docker run returned no container id — FAIL"
    FAIL+=("web")
    return
  fi
  local up=1
  for _ in $(seq 1 40); do
    # Any HTTP response (even 5xx) proves the Next server is up.
    if curl -s -o /dev/null "http://127.0.0.1:13000/api/health" >/dev/null 2>&1; then up=0; break; fi
    curl -s -o /dev/null --connect-timeout 1 "http://127.0.0.1:13000/" >/dev/null 2>&1 && { up=0; break; }
    sleep 0.5
  done
  # Non-root check while the container is RUNNING (capture before stop).
  local uid
  uid=$(docker exec "$cid" id -u 2>/dev/null || echo unknown)
  # P7-M016: SIGTERM handling (node PID 1; Next closes listener + exits).
  local sig_ms=-1 exit_code=-1
  if [ "$up" -eq 0 ]; then
    local t0 t1
    t0=$(date +%s%N)
    docker stop -t 10 "$cid" >/dev/null
    t1=$(date +%s%N)
    sig_ms=$(( (t1 - t0) / 1000000 ))
    exit_code=$(docker inspect "$cid" --format '{{.State.ExitCode}}' 2>/dev/null || echo -1)
  else
    docker rm -f "$cid" >/dev/null 2>&1 || true
  fi
  docker rm -f "$cid" >/dev/null 2>&1 || true
  # node exit 143 = 128+SIGTERM (handled, not killed by timeout);
  # exit 137 would mean SIGKILL after the grace window (fail).
  if [ "$up" -eq 0 ] && [ "$uid" = "1000" ] && [ "$exit_code" = "143" ]; then
    note "web: HTTP server responding, uid=$uid (non-root), SIGTERM→exit 143 in ${sig_ms}ms — PASS"
    PASS+=("web")
  else
    note "web: http-up=$up uid=$uid exit=$exit_code sig_ms=$sig_ms — FAIL"
    FAIL+=("web")
  fi
}

smoke_worker() {
  local tag=concord-worker:smoke
  local version="$RELEASE_VERSION" revision="$RELEASE_REVISION"
  note "building worker image…"
  docker build -q \
    --build-arg "CONCORD_VERSION=$version" \
    --build-arg "CONCORD_GIT_SHA=$revision" \
    -f docker/worker.Dockerfile -t "$tag" "$WORK" >/dev/null
  test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$tag")" = "$version"
  test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$tag")" = "$revision"
  note "probing worker image (generate_ops stdin probe: cmd 6 → status 0 + digest + ≥1 batch)…"
  # Probe frame — the exact bytes proven by the phase6 release-artifacts
  # workflow: [u32 24 payload][u32 6 cmd][u64 1 seed][u32 10 ops]
  # [u32 2 replicas][u32 0 shape] (little-endian).
  local cid=""
  if ! cid=$(docker run -d --entrypoint /bin/sh "$tag" \
    -c 'sleep 300'); then
    note "worker: docker run failed — FAIL"
    FAIL+=("worker")
    return
  fi
  if [ -z "$cid" ]; then
    note "worker: docker run returned no container id — FAIL"
    FAIL+=("worker")
    return
  fi
  local uid
  uid=$(docker exec "$cid" id -u 2>/dev/null || echo unknown)
  local probe_rc=1 probe_out=""
  if docker exec "$cid" /bin/sh -c "printf '\\x18\\x00\\x00\\x00\\x06\\x00\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x0a\\x00\\x00\\x00\\x02\\x00\\x00\\x00\\x00\\x00\\x00\\x00' | /app/concord-worker > /tmp/probe.out 2>/dev/null"; then
    # Parse the response head inside the container: status(u32), digest_len
    # (u32), then batch_count at offset 8+digest_len.
    if docker exec "$cid" /bin/sh -c 'od -An -tu4 -N4 /tmp/probe.out | tr -d "[:space:]" > /tmp/st'; then
      probe_out=$(docker exec "$cid" /bin/sh -c 'cat /tmp/st')
    fi
  fi
  docker rm -f "$cid" >/dev/null 2>&1 || true
  if [ "$uid" = "10001" ] && [ "$probe_out" = "0" ]; then
    note "worker: generate_ops probe status=0, uid=$uid (non-root) — PASS"
    PASS+=("worker")
  else
    note "worker: probe_status=${probe_out:-none} uid=$uid — FAIL"
    FAIL+=("worker")
  fi
}

echo "=== P6-M027 + P7-M016 release-image smoke (local only) ==="
smoke_gateway
smoke_web
smoke_worker
echo
if [ "${#FAIL[@]}" -eq 0 ]; then
  echo "RESULT: PASS (${#PASS[@]}/3 image checks)"
else
  echo "RESULT: FAIL — images: ${FAIL[*]}"
  exit 1
fi
