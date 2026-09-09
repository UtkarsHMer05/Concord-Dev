#!/usr/bin/env bash
# P7-M021/M022/M029 — Build + publish ONE environment's release.
#
# Everything runs from a CLEAN export of the release-candidate commit
# (git archive — never the dirty working tree):
#   1. ECR repos (concord-web / concord-gateway) — created if missing.
#   2. ARM64 release images built with the environment's NEXT_PUBLIC_*
#      values BAKED at build time (they are client-inlined — see
#      docker/web.Dockerfile): web (with wasm staged first) and gateway
#      (ships the native C++ worker binary).
#   3. Images tagged :<short-sha> AND :<env> — the short-sha tag IS the
#      release-candidate identity (M022 "exact commit"; M029 freeze).
#   4. SSM SecureString /concord/<env>/concord.env — the FULL runtime
#      env file (secrets + image refs) written from local .env.local
#      values; NEVER printed, NEVER committed.
#   5. Deployment bundle (compose file + nginx conf + prometheus +
#      grafana provisioning + initdb + rendered user-data) →
#      s3://<bucket>/concord/<env>/bundle.tar.gz.
#
# Usage (ENV is required; COMMIT optional — defaults to HEAD):
#   ENV=staging ./scripts/deploy/push-bundle.sh
#   ENV=production COMMIT=<sha> ./scripts/deploy/push-bundle.sh
#
# Required local env (read from .env.local — names only):
#   DATABASE_URL, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY,
#   CLERK_JWT_ISSUER_DOMAIN
# The STAGING/PROD database URLs are DERIVED from DATABASE_URL by
# swapping host:port to db:5432 (the compose service) — the cloud DB
# password is PG_PASSWORD (generated per environment if unset, stored in
# the SSM SecureString only).
set -euo pipefail
cd "$(dirname "$0")/../.."

ENV="${ENV:?set ENV=staging|production}"
COMMIT="${COMMIT:-$(git rev-parse --short HEAD)}"
REGION="${AWS_REGION:-ap-south-1}"
ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
BUCKET="${BUNDLE_BUCKET:-concord-deploy-${ACCOUNT_ID}}"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
WASM_REQUIRED=yes   # the web image bakes public/wasm at build time

echo "== concord release build: ENV=${ENV} COMMIT=${COMMIT} =="

# ---------------------------------------------------------------------------
# 0. Local prerequisites.
# ---------------------------------------------------------------------------
if [ ! -f .env.local ]; then
  echo "error: .env.local missing (source of Clerk keys for the env file)" >&2
  exit 2
fi
# Load names only — values are consumed below without echoing.
set -a
. ./.env.local
set +a
: "${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:?NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY missing in .env.local}"
: "${CLERK_SECRET_KEY:?CLERK_SECRET_KEY missing in .env.local}"
: "${CLERK_JWT_ISSUER_DOMAIN:?CLERK_JWT_ISSUER_DOMAIN missing in .env.local}"
: "${DATABASE_URL:?DATABASE_URL missing in .env.local}"
PG_PASSWORD="${PG_PASSWORD:-$(openssl rand -hex 24)}"
PG_USER=concord
PG_DB=concord

# ---------------------------------------------------------------------------
# 1. ECR repos (idempotent).
# ---------------------------------------------------------------------------
for repo in concord-web concord-gateway; do
  aws ecr describe-repositories --region "$REGION" --repository-names "$repo" \
    --query 'repositories[0].repositoryName' --output text 2>/dev/null \
    | grep -qx "$repo" 2>/dev/null || \
  aws ecr create-repository --region "$REGION" --repository-name "$repo" \
    --image-tag-mutability IMMUTABLE \
    --image-scanning-configuration scanOnPush=true \
    >/dev/null
  echo "  ecr: ${repo} ready (IMMUTABLE tags, scan-on-push)"
done

# ---------------------------------------------------------------------------
# 2. Clean release tree (git archive of the RC commit).
# ---------------------------------------------------------------------------
WORK=$(mktemp -d /tmp/concord-release.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
git archive "${COMMIT}" | tar -x -C "$WORK"
echo "  clean tree: $(git rev-parse --short "${COMMIT}") ($(git ls-tree -r "${COMMIT}" --name-only | wc -l | tr -d ' ') files)"

# 3. Stage the wasm build products into the export (git-ignored; the
#    web image build expects public/wasm present — docker/web.Dockerfile).
if [ ! -f public/wasm/concord-crdt.wasm ]; then
  echo "  public/wasm missing locally — building (npm run wasm:build)…"
  npm run wasm:build
fi
mkdir -p "${WORK}/public/wasm"
cp public/wasm/concord-crdt.js public/wasm/concord-crdt.wasm "${WORK}/public/wasm/"

# ---------------------------------------------------------------------------
# 4. Build + push ARM64 images (from the clean tree, NOT the worktree).
# ---------------------------------------------------------------------------
WEB_IMAGE="${REGISTRY}/concord-web:${COMMIT}"
GW_IMAGE="${REGISTRY}/concord-gateway:${COMMIT}"

# Resolve the sync URL from the ALB DNS name for this environment.
ALB_DNS=$(aws elbv2 describe-load-balancers --region "$REGION" \
  --names "concord-${ENV}-lb" \
  --query 'LoadBalancers[0].DNSName' --output text)
if [ -z "$ALB_DNS" ] || [ "$ALB_DNS" = "None" ]; then
  echo "error: ALB concord-${ENV}-lb not found — run provision.sh first" >&2
  exit 2
fi
SYNC_URL="ws://${ALB_DNS}:8890/api/v1/sync"
APP_URL="http://${ALB_DNS}"

echo "  building web image (NEXT_PUBLIC baked: sync=${SYNC_URL})…"
docker build -q -f docker/web.Dockerfile \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}" \
  --build-arg NEXT_PUBLIC_SYNC_GATEWAY_URL="${SYNC_URL}" \
  -t concord-web:"${COMMIT}" "${WORK}" >/dev/null
docker tag concord-web:"${COMMIT}" "$WEB_IMAGE"

echo "  building gateway image (rust + native C++ worker)…"
docker build -q -f docker/gateway.Dockerfile \
  -t concord-gateway:"${COMMIT}" "${WORK}" >/dev/null
docker tag concord-gateway:"${COMMIT}" "$GW_IMAGE"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "https://${REGISTRY}" >/dev/null
# ECR tags are IMMUTABLE: re-publishing the same commit (e.g. after a
# bundle-only fix — images unchanged) must SKIP the push, not fail it.
push_if_absent() {  # $1 = full image ref
  local repo tag
  repo="${1%%:*}"; repo="${repo##*/}"; tag="${1##*:}"
  if aws ecr describe-images --region "$REGION" --repository-name "$repo" \
       --image-ids "imageTag=${tag}" >/dev/null 2>&1; then
    echo "  ecr: ${repo}:${tag} already pushed (immutable) — skip"
  else
    docker push -q "$1" >/dev/null
    echo "  pushed: $1"
  fi
}
push_if_absent "$WEB_IMAGE"
push_if_absent "$GW_IMAGE"

# ---------------------------------------------------------------------------
# 5. SSM SecureString — the full runtime env file.
# ---------------------------------------------------------------------------
GATEWAY_ALLOWED_ORIGINS="${APP_URL}"
cat > "${WORK}/concord.env" <<EOF
# Concord ${ENV} runtime environment (SSM SecureString; rendered
# $(date -u +%Y-%m-%dT%H:%MZ) from commit ${COMMIT}).
# Compose interpolation + container env_file. SECRETS — never commit.

# --- compose interpolation ---
ENV=${ENV}
PG_USER=${PG_USER}
PG_PASSWORD=${PG_PASSWORD}
PG_DB=${PG_DB}
CONCORD_WEB_IMAGE=${WEB_IMAGE}
CONCORD_GATEWAY_IMAGE=${GW_IMAGE}

# --- web (Next.js runtime; NEXT_PUBLIC_* were baked at image build) ---
DATABASE_URL=postgres://${PG_USER}:${PG_PASSWORD}@db:5432/${PG_DB}
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
CLERK_SECRET_KEY=${CLERK_SECRET_KEY}

# --- gateways (shared by gw1..gw3; per-replica vars in compose) ---
GATEWAY_BIND_HOST=0.0.0.0
GATEWAY_DATABASE_URL=postgres://${PG_USER}:${PG_PASSWORD}@db:5432/${PG_DB}
GATEWAY_CLERK_ISSUER=${CLERK_JWT_ISSUER_DOMAIN}
GATEWAY_ALLOWED_ORIGINS=${GATEWAY_ALLOWED_ORIGINS}
GATEWAY_NATS_URL=nats://nats:4222
GATEWAY_REDIS_URL=redis://redis:6379
GATEWAY_NATS_SUBJECT_PREFIX=concord.${ENV}
GATEWAY_WORKER_BINARY=/app/concord-worker
GATEWAY_RATE_CONNECT_PER_MIN=60
GATEWAY_MAX_FRAME_SIZE=8388608
GATEWAY_DB_POOL_SIZE=8
RUST_LOG=info
EOF
aws ssm put-parameter --region "$REGION" \
  --name "/concord/${ENV}/concord.env" \
  --type SecureString \
  --value "$(cat "${WORK}/concord.env")" \
  --overwrite >/dev/null
echo "  ssm: /concord/${ENV}/concord.env written (SecureString)"
rm -f "${WORK}/concord.env"   # never leave the secret in the build tree

# ---------------------------------------------------------------------------
# 6. Deployment bundle → S3.
# ---------------------------------------------------------------------------
BUNDLE="${WORK}/bundle.tar.gz"
STAGE="${WORK}/bundle-stage"
mkdir -p "${STAGE}"
cp docker-compose.cloud.yml "${STAGE}/"
cp scripts/deploy/nginx.cloud.conf "${STAGE}/"
cp scripts/deploy/prometheus.cloud.yml.in "${STAGE}/prometheus.cloud.yml"
# Grafana provisioning: datasource (prometheus on the compose network) +
# dashboard loader + the three dashboards. Layout mirrors local dev
# (docker-compose.yml): provisioning at grafana.cloud, dashboard JSONs
# at grafana.cloud-dashboards (/var/lib/grafana/dashboards in the
# container — the path dashboards.yml points at).
mkdir -p "${STAGE}/grafana.cloud/datasources" "${STAGE}/grafana.cloud/dashboards" \
         "${STAGE}/grafana.cloud-dashboards"
cp scripts/observability/grafana/provisioning/datasources/prometheus.yml \
   "${STAGE}/grafana.cloud/datasources/prometheus.yml"
cp scripts/observability/grafana/provisioning/dashboards/dashboards.yml \
   "${STAGE}/grafana.cloud/dashboards/dashboards.yml"
for d in scripts/observability/grafana/dashboards/*.json; do
  cp "$d" "${STAGE}/grafana.cloud-dashboards/"
done
mkdir -p "${STAGE}/initdb"
cp scripts/deploy/initdb/01-extensions.sql "${STAGE}/initdb/"
# Rendered user-data (ENV/BUCKET baked; secrets stay in SSM).
sed -e "s/__ENV__/${ENV}/g" -e "s/__BUCKET__/${BUCKET}/g" \
  scripts/deploy/user-data.sh > "${STAGE}/user-data.sh"

# COPYFILE_DISABLE: macOS bsdtar otherwise embeds AppleDouble `._*`
# resource-fork files for every copied file — observed breaking Grafana
# provisioning on staging (it tried to parse ._dashboards.yml as YAML).
# COPYFILE_DISABLE=1 must be exported BEFORE tar; also clean any that
# slipped in (belt and suspenders).
find "${STAGE}" -name '._*' -type f -delete
COPYFILE_DISABLE=1 tar -czf "$BUNDLE" -C "$STAGE" .
aws s3 mb "s3://${BUCKET}" --region "$REGION" 2>/dev/null || true
aws s3api put-public-access-block --bucket "$BUCKET" --region "$REGION" \
  --public-access-block-config \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
  2>/dev/null || true
aws s3 cp "$BUNDLE" "s3://${BUCKET}/concord/${ENV}/bundle.tar.gz" --region "$REGION"
echo "  s3: bundle uploaded → s3://${BUCKET}/concord/${ENV}/bundle.tar.gz"

echo
echo "== release published (${ENV}) =="
echo "  commit:   ${COMMIT}"
echo "  web:      ${WEB_IMAGE}"
echo "  gateway:  ${GW_IMAGE}"
echo "  app url:  ${APP_URL}   (sync: ${SYNC_URL})"
