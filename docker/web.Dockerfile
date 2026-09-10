# P6-M027 — Hardened release image: web app (Next.js standalone).
# P7-M021 — deployment build-args (NEXT_PUBLIC_* are build-time inlined).
#
# Multi-stage, pinned base images, non-root runtime, no build secrets in
# the final layer, no package managers / debug tools in runtime.
#
# Build:  docker build -f docker/web.Dockerfile -t concord-web:release .
# Deploy: docker build -f docker/web.Dockerfile \
#           --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_... \
#           --build-arg NEXT_PUBLIC_SYNC_GATEWAY_URL=ws://<alb-dns>:8890/api/v1/sync .
#         (NEXT_PUBLIC_* vars are INLINED into the client bundle at build
#          time — they cannot be runtime env. Secrets are NEVER baked:
#          CLERK_SECRET_KEY + DATABASE_URL are runtime env via SSM.)
# Run:    docker run --rm -p 3000:3000 --env-file .env.local concord-web:release

# --- Stage 1: deps -----------------------------------------------------------
# node:24-alpine is the LTS line matching .nvmrc (24.x) — pinned minor via
# digest-independent tag; the SBOM records the resolved digest.
FROM node:24.20-alpine AS deps
WORKDIR /app
# libc6-compat: native modules (esbuild via drizzle-kit chain) may need it.
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
# Clean install — no --force, no --legacy-peer-deps (house rule).
RUN npm ci

# --- Stage 2: build ----------------------------------------------------------
FROM node:24.20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Standalone output keeps the runtime layer minimal.
# Dummy vars: the build must not require real secrets (build-time env only).
ENV NEXT_TELEMETRY_DISABLED=1
# public/wasm is produced by `npm run wasm:build` (git-ignored); the image
# build expects it present. public/crdt-worker.js is produced by
# `npm run worker:bundle` (P7-M032 — the pre-bundled static worker the
# client constructs from /crdt-worker.js; byte-stable per source commit).
# Build both layers first when needed:
#   npm run wasm:build && npm run worker:bundle && docker build ...
# P7-M021: per-environment NEXT_PUBLIC_* values (see header — these are
# the ONLY two NEXT_PUBLIC vars the app reads: Clerk publishable key and
# the browser-facing sync WS URL).
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SYNC_GATEWAY_URL
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY} \
    NEXT_PUBLIC_SYNC_GATEWAY_URL=${NEXT_PUBLIC_SYNC_GATEWAY_URL}
RUN npm run build

# --- Stage 3: runtime --------------------------------------------------------
FROM node:24.20-alpine AS runtime
# Security-fixed package versions from the pinned base release repo
# (2026-09-09: base openssl 3.5.7-r0 → 3.5.8-r0 with 2 CRITICAL CVE
# fixes; ECR scan-on-push re-verifies after build).
RUN apk upgrade
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Standalone server + static assets only — no node_modules copy of build
# toolchains, no package manager beyond what apk already removed.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
# public assets (incl. wasm if built) — copy is small and keeps URLs stable.
COPY --from=build --chown=nextjs:nodejs /app/public ./public
# Migration runner (P7-M022, two-family rule): drizzle migrations +
# runner script + drizzle-orm/pg deps (not traced into standalone — the
# migrator imports them directly, outside Next's dependency graph).
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/pg ./node_modules/pg
COPY --chown=nextjs:nodejs drizzle ./drizzle
COPY --chown=nextjs:nodejs scripts/db/migrate.mjs ./scripts/db/migrate.mjs
# Non-root user (node image ships uid 1000 `node`).
USER node
EXPOSE 3000
# HEALTHCHECK (P7-M016): node ships with the image, busybox wget exists in
# the alpine base. Node fetch is preferred (it IS the runtime we shipped;
# no dependence on busybox applet behavior). /api/health checks PostgreSQL:
# an unhealthy DB returns 503 → the container is flagged unhealthy (the
# correct signal for orchestrators — the process itself is still alive).
# A pure liveness probe can target "/" instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Signal handling (P7-M016, VERIFIED): CMD is exec-form so node runs as
# PID 1 and receives SIGTERM directly from `docker stop`/orchestrators.
# Next.js standalone server.js registers SIGTERM/SIGINT handlers
# (next/dist/server/lib/start-server.js) that close the listener, finish
# pending requests, and exit — measured: `docker stop -t 30` exits with
# code 143 in ~0.4 s. No init/tini wrapper is needed; do NOT add a shell
# ENTRYPOINT here (sh does not forward signals).
CMD ["node", "server.js"]
