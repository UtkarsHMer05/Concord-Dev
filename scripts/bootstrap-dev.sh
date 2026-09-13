#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Concord dev-environment bootstrap (release 1.0.0).
#
# One-shot setup for a fresh checkout (macOS + Linux):
#   1. checks every prerequisite with a per-tool fix hint,
#   2. installs node modules (npm ci when a lockfile exists, else install),
#   3. starts the local Postgres/NATS/Redis stack,
#   4. runs database migrations,
#   5. prints the next steps (npm run dev).
#
# Compatibility: bash 3.2+ (macOS ships 3.2 — no bash 4-isms), macOS and
# Linux. No secrets are written anywhere: the compose stack ships documented
# local-dev credentials only (see docker-compose.yml).
#
# Usage:
#   bash scripts/bootstrap-dev.sh          # full bootstrap
#   SKIP_DOCKER=1 bash scripts/bootstrap-dev.sh   # skip compose+migrate
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0

log()   { printf '[bootstrap] %s\n' "$*"; }
hint()  { printf '           fix: %s\n' "$*"; }
ok()    { printf '[bootstrap] ok: %s\n' "$*"; }
fail()  {
  printf '[bootstrap] MISSING: %s\n' "$1" >&2
  hint "$2"
  failures=$((failures + 1))
}

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
log "checking prerequisites..."

# --- node (>= the .nvmrc line, currently 24.x) --------------------------------
EXPECTED_NODE="$(grep -E '^[0-9]+' .nvmrc | cut -d. -f1)"
EXPECTED_NODE="${EXPECTED_NODE:-24}"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if [ "$NODE_MAJOR" -lt "$EXPECTED_NODE" ]; then
    fail "node $NODE_MAJOR found, need >= v$EXPECTED_NODE (.nvmrc)" \
      "source ~/.nvm/nvm.sh && nvm use $(cat .nvmrc)  # or: brew install node@$EXPECTED_NODE"
  else
    ok "node $(node --version)"
  fi
else
  fail "node not found (needs >= v$EXPECTED_NODE per .nvmrc)" \
    "install nvm (https://github.com/nvm-sh/nvm) then: nvm install $(cat .nvmrc)"
fi

# --- cmake >= 3.24 (cpp/CMakeLists.txt minimum) -------------------------------
if command -v cmake >/dev/null 2>&1; then
  CMAKE_VERSION="$(cmake --version | head -1 | awk '{print $NF}')"
  CMAKE_MAJOR="${CMAKE_VERSION%%.*}"
  CMAKE_MINOR="$(printf '%s' "$CMAKE_VERSION" | cut -d. -f2)"
  CMAKE_MAJOR="${CMAKE_MAJOR:-0}"; CMAKE_MINOR="${CMAKE_MINOR:-0}"
  if [ "$CMAKE_MAJOR" -lt 3 ] || { [ "$CMAKE_MAJOR" -eq 3 ] && [ "$CMAKE_MINOR" -lt 24 ]; }; then
    fail "cmake $CMAKE_VERSION found, need >= 3.24" "brew install cmake (macOS) / apt install cmake (Linux)"
  else
    ok "cmake $CMAKE_VERSION"
  fi
else
  fail "cmake not found (need >= 3.24)" "brew install cmake (macOS) / apt install cmake (Linux)"
fi

# --- ninja --------------------------------------------------------------------
if command -v ninja >/dev/null 2>&1; then
  ok "ninja $(ninja --version)"
else
  fail "ninja not found (native build generator: scripts/verify-native.sh)" \
    "brew install ninja (macOS) / apt install ninja-build (Linux)"
fi

# --- rust toolchain (rustup recommended; rust-toolchain.toml pins the channel) -
if command -v cargo >/dev/null 2>&1; then
  ok "cargo $(cargo --version | awk '{print $2}')"
else
  fail "cargo not found (rust sync-gateway)" \
    "install rustup (https://rustup.rs) — rust/rust-toolchain.toml pins the toolchain"
fi

# --- docker (+ compose plugin, for the dev Postgres/NATS/Redis stack) --------
if command -v docker >/dev/null 2>&1; then
  ok "docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)"
  if ! docker compose version >/dev/null 2>&1; then
    fail "docker compose plugin not available" \
      "install the compose plugin (Docker Desktop, or 'apt install docker-compose-plugin')"
  fi
else
  fail "docker not found (dev databases + reliability stacks)" \
    "install Docker Desktop (macOS) or docker engine + compose plugin (Linux)"
fi

# --- emscripten (OPTIONAL: only the WASM build needs it) ----------------------
if command -v emcc >/dev/null 2>&1; then
  ok "emcc (optional, found)"
else
  log "OPTIONAL not installed: emcc (Emscripten) — only needed for the WASM build (npm run wasm:build); skipping"
fi

# --- git (repo tooling: provenance gate, SBOM git sha) ------------------------
if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')"
else
  fail "git not found (provenance + SBOM tooling)" "brew install git / apt install git"
fi

if [ "$failures" -gt 0 ]; then
  printf '[bootstrap] %d prerequisite(s) missing — fix the above and re-run.\n' "$failures" >&2
  exit 1
fi
log "all prerequisites present."

# ---------------------------------------------------------------------------
# 2. Node modules (npm ci with the lockfile; npm install without)
# ---------------------------------------------------------------------------
log "installing node modules..."
if [ -f package-lock.json ]; then
  npm ci --ignore-scripts
else
  npm install --ignore-scripts
fi
ok "node_modules ready"

# ---------------------------------------------------------------------------
# 3. Dev database (docker compose) + migrations
# ---------------------------------------------------------------------------
if [ "${SKIP_DOCKER:-0}" = "1" ]; then
  log "SKIP_DOCKER=1 — skipping compose stack + migrations"
else
  log "starting local infrastructure (docker compose up -d db nats redis)..."
  docker compose up -d db nats redis
  ok "dev infrastructure up (Postgres 5433, NATS 4222, Redis 6379)"

  log "running migrations (npm run db:migrate)..."
  npm run db:migrate
  ok "migrations applied"

  log "preparing the ISOLATED test database (npm run db:test:prepare)..."
  if npm run db:test:prepare; then
    ok "test database ready (concord_test)"
  else
    fail "isolated test-database preparation failed" \
      "ensure the compose Postgres service is healthy, then re-run: npm run db:test:prepare"
  fi
fi

if [ "$failures" -gt 0 ]; then
  printf '[bootstrap] %d failure(s) remain — bootstrap did not complete.\n' "$failures" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Next steps
# ---------------------------------------------------------------------------
cat <<'EOF'

[bootstrap] DONE. Next steps:

  npm run dev                 # start the web app (Next.js)
  npm run db:studio           # optional: browse the schema in Drizzle Studio

  # Gateway (Rust) — separate terminal, needs the compose db from above:
  cd rust && cargo run        # dev gateway (GATEWAY_DATABASE_URL in .env.local)

  # Full gates before opening a PR:
  bash scripts/verify-all.sh
  bash scripts/verify-all.sh --strict   # release/audit mode; no required skips

Docs: docs/ (see docs/SECURITY.md for the local stack details).
EOF
