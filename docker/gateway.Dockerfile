# P6-M027 — Hardened release image: Rust sync gateway.
# P7-M021 — ships the native C++ worker BINARY in the same image
# (GATEWAY_WORKER_BINARY=/app/concord-worker per docker-compose.cloud.yml
# and SECURITY.md §10.2: the gateway spawns the worker per maintenance
# request via stdio).
#
# Multi-stage build: cargo build in the builder stage (rust:1.98-alpine
# + toolchain 1.98.1 matching rust/rust-toolchain.toml), minimal runtime
# with only the binary + CA certs, non-root user (uid 10001), no
# cargo/rustc/package managers at runtime.
#
# Build: docker build -f docker/gateway.Dockerfile -t concord-gateway:release .
# Smoke: scripts/release/smoke-images.sh

# --- Stage 1: builder --------------------------------------------------------
# Digest-pinned (hardening E6): resolves to the exact audited content of
# the tag; Dependabot (docker ecosystem) opens refresh PRs when the tag
# moves — each refresh is rebuilt, SBOM-regenerated, and trivy-gated.
FROM rust:1.98-alpine@sha256:1716b3aa042d735f4566d14dc54e8037de9d69556e2d5dd58131d93a613d173d AS builder
# Pin the exact toolchain the repo pins (rust-toolchain.toml, 1.98.1).
RUN rustup toolchain install 1.98.1 --profile minimal \
    && rustup default 1.98.1
# C/C++ toolchain for native build scripts (aws-lc-rs in the JWT stack).
RUN apk add --no-cache musl-dev gcc g++
WORKDIR /build
# The whole rust workspace EXCEPT rust/target (see .dockerignore):
# manifests reference tests/ paths (cargo parses [[test]] entries at
# manifest load — the tests must be present even for a release binary
# build), and rust-toolchain.toml pins the exact toolchain.
COPY rust ./rust
RUN cargo build --release --manifest-path rust/sync-gateway/Cargo.toml

# --- Stage 1b: native worker (P7-M021) ---------------------------------------
# The C++ maintenance worker compiled for the image's own target arch
# (same flow as docker/worker.Dockerfile: Release, tests/benchmarks off,
# libstdc++/libgcc linked STATICALLY so the minimal runtime needs no
# extra packages).
FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce AS worker-builder
RUN apk add --no-cache cmake ninja gcc g++ musl-dev
WORKDIR /build
COPY cpp ./cpp
RUN cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCONCORD_BUILD_TESTS=OFF -DCONCORD_BUILD_BENCHMARKS=OFF \
    -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc" \
 && cmake --build build/native

# --- Stage 2: runtime --------------------------------------------------------
FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce AS runtime
# CA certs for Clerk HTTPS verification. Nothing else: no shell tools
# beyond busybox defaults, no package manager, no build toolchain.
# apk upgrade is a DELIBERATE, documented tradeoff (hardening E6): it
# keeps OS packages at security-fixed versions from the pinned base
# release repo, so image digests intentionally track the distro repo
# state at build time (the runtime layer is NOT byte-reproducible;
# the embedded binaries are). The trivy scan gate
# (scripts/security/scan-gate.sh) enforces the CVE posture of the
# result; refresh PRs re-run it.
RUN apk add --no-cache ca-certificates && apk upgrade
WORKDIR /app
# Workspace target dir lives at the workspace root (rust/target), not the
# member crate dir.
COPY --from=builder /build/rust/target/release/sync-gateway ./
# Native C++ maintenance worker (P7-M021): spawned per maintenance
# request via GATEWAY_WORKER_BINARY=/app/concord-worker (stdio
# protocol). Numeric chown (uid 10001 = the concord user created below
# — named --chown would fail because the user does not exist yet at
# COPY time).
COPY --from=worker-builder --chown=10001:10001 /build/build/native/worker/concord-worker /app/concord-worker
# Non-root, fixed uid for reproducibility.
RUN addgroup -S -g 10001 concord && adduser -S -u 10001 -G concord concord
USER concord
EXPOSE 8791
# HEALTHCHECK (P7-M016): the minimal runtime keeps busybox wget (alpine
# base) — no curl/node in this image by design. /api/v1/health/live is the
# process-liveness route (no DB dependency); /api/v1/health/ready would
# additionally require Postgres reachability — a readiness concern for
# orchestrators/load balancers, not an image health concern.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q -T 3 http://127.0.0.1:${GATEWAY_BIND_PORT:-8787}/api/v1/health/live || exit 1
# Signal handling (P7-M016, VERIFIED): exec-form ENTRYPOINT → the binary is
# PID 1 and tokio receives SIGTERM directly. Measured with `docker stop -t 30`:
# drain notice → 2 s bounded grace → exit 0 in ~2.2 s total. Do NOT wrap in
# a shell ENTRYPOINT (sh swallows signals).
# Runtime env (bind, DB URL, NATS, Redis, Clerk issuer, optional worker
# path) supplied at run time via env-file; never baked into the image.
ENTRYPOINT ["/app/sync-gateway"]
