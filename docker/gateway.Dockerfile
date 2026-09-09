# P6-M027 — Hardened release image: Rust sync gateway.
#
# Multi-stage build: cargo build in the builder stage (rust:1.98-alpine
# + toolchain 1.98.1 matching rust/rust-toolchain.toml), minimal runtime
# with only the binary + CA certs, non-root user (uid 10001), no
# cargo/rustc/package managers at runtime.
# LOCAL BUILD + SMOKE ONLY — production deployment is Phase 7. Note:
# Phase 4 runs gateways on the HOST (host networking for NATS/Redis/PG);
# the container is the release-candidate packaging proof for Phase 7.
#
# Build: docker build -f docker/gateway.Dockerfile -t concord-gateway:release .
# Smoke: scripts/release/smoke-images.sh

# --- Stage 1: builder --------------------------------------------------------
FROM rust:1.98-alpine AS builder
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

# --- Stage 2: runtime --------------------------------------------------------
FROM alpine:3.22 AS runtime
# CA certs for Clerk HTTPS verification. Nothing else: no shell tools
# beyond busybox defaults, no package manager, no build toolchain.
RUN apk add --no-cache ca-certificates
WORKDIR /app
# Workspace target dir lives at the workspace root (rust/target), not the
# member crate dir.
COPY --from=builder /build/rust/target/release/sync-gateway ./
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
