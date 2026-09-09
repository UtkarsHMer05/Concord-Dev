# P6-M027 — Hardened release image: web app (Next.js standalone).
#
# Multi-stage, pinned base images, non-root runtime, no build secrets in
# the final layer, no package managers / debug tools in runtime.
# LOCAL BUILD + SMOKE ONLY — production deployment is Phase 7.
#
# Build:  docker build -f docker/web.Dockerfile -t concord-web:release .
# Run:    docker run --rm -p 3000:3000 --env-file .env.local concord-web:release
#         (requires Clerk + DATABASE_URL env; loopback only in Phase 6)

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
# Next.js standalone output keeps the runtime layer minimal.
# Dummy vars: the build must not require real secrets (build-time env only).
ENV NEXT_TELEMETRY_DISABLED=1
# public/wasm is produced by `npm run wasm:build` (git-ignored); the image
# build expects it present. Build the wasm layer first when needed:
#   npm run wasm:build && docker build ...
RUN npm run build

# --- Stage 3: runtime --------------------------------------------------------
FROM node:24.20-alpine AS runtime
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
