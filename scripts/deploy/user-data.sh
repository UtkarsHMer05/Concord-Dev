#!/usr/bin/env bash
# P7-M021/M022 — EC2 user data: bootstrap ONE Concord environment
# instance. Executed ONCE at first boot by AWS (cloud-init).
#
# Rendered by scripts/deploy/push-bundle.sh before launch: the
# __ENV__ and __BUCKET__ placeholders below are substituted with the
# target environment and bundle bucket (user-data is NOT secret — the
# secrets come from SSM Parameter Store at boot).
#
# Steps: docker + compose plugin → AWS CLI → ECR login (instance
# profile) → S3 deployment bundle → SSM Parameter Store secrets (never
# in user-data, never baked in images) → drizzle migrations (two-family
# rule: drizzle FIRST via the compose "migrations" service) → stack up
# (each gateway then applies its own migration family idempotently at
# boot) → nightly backup cron (docs/OPERATIONS.md).
#
# Required at provision time (set by push-bundle.sh beforehand):
#   S3 bundle:       s3://<BUCKET>/concord/<env>/bundle.tar.gz
#   SSM SecureString: /concord/<env>/concord.env  (full env file content)
#   IAM instance profile "concord-<env>-instance-role" attached by
#   provision.sh (ECR pull + S3 read + SSM read only).
set -euo pipefail

ENV="__ENV__"
BUCKET="__BUCKET__"
REGION="ap-south-1"

exec > /var/log/concord-bootstrap.log 2>&1
echo "== concord bootstrap $(date -u) ENV=${ENV} =="

dnf install -y docker
systemctl enable --now docker

# AWS CLI (not in the minimal AL2023 image) + SSM agent plugin for
# Session Manager access (the deployment's only shell path; no SSH
# ingress exists — SECURITY.md §10.3).
dnf install -y aws-cli
dnf install -y amazon-ssm-agent || true
systemctl enable --now amazon-ssm-agent || true

# Compose plugin (docker-compose.cloud.yml requires the v2 syntax).
mkdir -p /usr/local/lib/docker/cli-plugins
curl -sSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

WORK=/opt/concord
mkdir -p "${WORK}"
aws s3 cp "s3://${BUCKET}/concord/${ENV}/bundle.tar.gz" "${WORK}/bundle.tar.gz" --region "$REGION"
tar -xzf "${WORK}/bundle.tar.gz" -C "${WORK}"

# Secrets: the env FILE is stored as one SecureString; write it with
# mode 600 root-only. Compose interpolation (vars referenced by
# docker-compose.cloud.yml) AND container env_file both consume it.
aws ssm get-parameter --name "/concord/${ENV}/concord.env" \
  --with-decryption --region "$REGION" \
  --query Parameter.Value --output text > "${WORK}/concord.env"
chmod 600 "${WORK}/concord.env"

cd "${WORK}"

# ECR login through the instance profile (the bundle's images are
# private-repo refs; docker needs registry credentials to pull). Account
# id via STS — the instance-identity JSON parse previously used here was
# quoting-fragile and silently produced an empty host ("no such host",
# observed on staging AND production first boot; the completed staging
# deployment was finished manually via SSM before the root cause was
# isolated). STS caller-identity via the instance profile is robust.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_HOST="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "https://${ECR_HOST}"

# Compose reads ${...} interpolation vars from the environment: source
# the env file (it contains only KEY=VALUE lines).
set -a
. "${WORK}/concord.env"
set +a

# --- Two-family migration rule (docs/MIGRATIONS.md): drizzle FIRST --
# The migrations service (same web image, entrypoint
# node scripts/db/migrate.mjs) runs once against the db service, then
# exits. Gateway v1 FKs reference the drizzle-owned documents table.
docker compose -f docker-compose.cloud.yml -p "concord-${ENV}" \
  --profile migrate up -d db
for _ in $(seq 1 30); do
  if docker compose -f docker-compose.cloud.yml -p "concord-${ENV}" \
       exec -T db pg_isready -U concord >/dev/null 2>&1; then break; fi
  sleep 2
done
docker compose -f docker-compose.cloud.yml -p "concord-${ENV}" \
  --profile migrate run --rm migrations
echo "drizzle family applied (registry: drizzle.__drizzle_migrations)"

# --- Stack up (gateway run_migrations apply family v1..v3 at boot) ---
docker compose -f docker-compose.cloud.yml -p "concord-${ENV}" up -d

# nginx (lb) resolves its static upstream hostnames (gw1..gw3) to IPs
# ONCE at startup. `up -d` recreates only services whose image/config
# changed — on a gateway image roll the gateways get NEW container IPs
# while the untouched lb keeps serving the stale ones → "no live
# upstreams" 502s (observed on production 2026-09-10: gw IPs shifted on
# the e754122 roll and every :8890 request 502'd for 20+ minutes).
# A one-container restart re-resolves; it costs <2s and is idempotent
# on first boot.
docker compose -f docker-compose.cloud.yml -p "concord-${ENV}" restart lb

# --- Nightly backup cron (docs/OPERATIONS.md § Scheduled backups) ---
# The minimal AL2023 image has NO /etc/cron.d — create it (and the
# backup dir) before writing the cron file.
mkdir -p /etc/cron.d /var/backups/concord
printf '%s\n' \
  '# Concord nightly PostgreSQL dump (03:15, gzip, keep 14) — OPERATIONS.md.' \
  '15 3 * * * root docker exec concord-'"${ENV}"'-db pg_dump -U concord -d concord | gzip > /var/backups/concord/concord-$(date +\%Y\%m\%d).sql.gz && find /var/backups/concord -name "concord-*.sql.gz" -mtime +14 -delete' \
  > /etc/cron.d/concord-backup
chmod 644 /etc/cron.d/concord-backup

echo "== bootstrap complete =="
docker compose -f docker-compose.cloud.yml -p "concord-${ENV}" ps
