# P7-M016 — Hardened release image: native maintenance worker (C++).
#
# The worker is a standalone, dependency-free C++20 executable (cpp/worker —
# no third-party deps, verified P6-M025 SBOM). The gateway spawns it per
# maintenance request (GATEWAY_WORKER_BINARY points at /app/concord-worker
# inside the gateway container, or the binary is shipped in the same image
# via a sidecar/copy pattern chosen by the deployment).
#
# The build compiles INSIDE the image for the image's own target arch —
# the same cmake flow as CI (`.github/workflows/phase6-release-artifacts.yml`
# builds build/native/worker/concord-worker with cmake+Release):
#
#   docker build -f docker/worker.Dockerfile -t concord-worker:release .
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f docker/worker.Dockerfile ...   # per-target compilation
#
# TARGETARCH: BuildKit sets this automatically for the platform being built
# (linux/arm64 on Apple Silicon, linux/amd64 in the CI runner). The builder
# image matches the platform by definition — so the binary is ALWAYS
# compiled for the target the image will run on; there is no
# cross-compiler handoff to get wrong. Pinning builder tags per arch keeps
# the base digest deterministic.
#
# Smoke: scripts/release/smoke-images.sh runs the CMD_GENERATE_OPS stdin
# probe (command 6 → status 0 + digest + ≥1 batch), the same probe proven
# by the phase6 release-artifacts workflow.

# --- Stage 1: builder --------------------------------------------------------
# gcc in alpine builds the C++20 core with no external dependencies.
# (Tag matches the platform BuildKit is building for.) Digest-pinned
# (hardening E6); Dependabot (docker ecosystem) opens refresh PRs.
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS builder
RUN apk add --no-cache cmake ninja gcc g++ musl-dev
WORKDIR /build
# The worker + the CRDT core it wraps. .dockerignore excludes rust/target
# only; cpp/ is small and self-contained.
COPY cpp ./cpp
# Same flags as CI (Release; tests off for the artifact build). The C++
# runtime (libstdc++/libgcc_s) is linked STATICALLY so the runtime image
# needs no extra packages — the CI tar artifact assumes the host OS
# provides them, but a minimal container must not.
RUN cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCONCORD_BUILD_TESTS=OFF -DCONCORD_BUILD_BENCHMARKS=OFF \
    -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc" \
 && cmake --build build/native

# --- Stage 2: runtime --------------------------------------------------------
# Static-friendly minimal runtime: alpine + nothing but the binary. musl
# already matches the builder's libc; libstdc++ is linked in statically.
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS runtime
ARG CONCORD_VERSION=1.0.1
ARG CONCORD_GIT_SHA=unknown
LABEL org.opencontainers.image.title="Concord native worker" \
      org.opencontainers.image.version="$CONCORD_VERSION" \
      org.opencontainers.image.revision="$CONCORD_GIT_SHA"
# apk upgrade is a DELIBERATE, documented tradeoff (hardening E6): it
# keeps the base's libcrypto3 at security-fixed versions from the
# pinned release repo, so this layer is NOT byte-reproducible (the
# statically linked worker binary is). The trivy scan gate enforces
# the CVE posture; refresh PRs re-run it.
RUN apk upgrade
# Non-root, fixed uid (mirrors the gateway image's concord user so a shared
# deployment can mount/copy the binary with one ownership story).
RUN addgroup -S -g 10001 concord && adduser -S -u 10001 -G concord concord
COPY --from=builder --chown=concord:concord /build/build/native/worker/concord-worker /app/concord-worker
# No shell entry: the worker is a spawned stdin/stdout process. The
# generate_ops probe (below) is also the standard container health check —
# an executable that cannot answer it is not shippable.
USER concord
WORKDIR /app
# HEALTHCHECK (P7-M016): the worker is a process-per-request stdin/stdout
# binary, so "health" = the generate_ops probe answers correctly. Probe
# bytes are the EXACT frame the phase6 workflow proved:
#   [u32 24][u32 6 (cmd)][u64 1 (seed)][u32 10 (ops)][u32 2 (replicas)]
#   [u32 0 (shape)]
# (hex: 18000000 06000000 0100000000000000 0a000000 02000000 00000000;
# 24-byte payload under the [u32 len] prefix). Expected response head:
# [u32 status=0][u32 digest_len][digest][u32 batch_count] — od reads the
# first u32 and the check requires 0. Python is NOT in the runtime image.
HEALTHCHECK --interval=60s --timeout=10s --start-period=5s --retries=2 \
  CMD ["/bin/sh", "-c", "printf '\\x18\\x00\\x00\\x00\\x06\\x00\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x0a\\x00\\x00\\x00\\x02\\x00\\x00\\x00\\x00\\x00\\x00\\x00' | /app/concord-worker 2>/dev/null | od -An -tu4 -N4 | grep -q '^[[:space:]]*0[[:space:]]*$' || exit 1"]
