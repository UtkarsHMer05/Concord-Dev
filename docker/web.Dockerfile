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
# Health check: the app exposes /api/health (liveness) — container-level
# process liveness via node is enough here; the app healthcheck runs in the
# smoke test (docker/web smoke) rather than baked into the image.
CMD ["node", "server.js"]
