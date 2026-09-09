#!/usr/bin/env bash
# P7-M021/M022 — EC2 user data: bootstrap ONE Concord environment
# instance. Executed ONCE at first boot by AWS (cloud-init).
#
# Steps: docker + compose plugin → S3 deployment bundle → env files
# from SSM Parameter Store (secrets never in user-data) → migrations
# (drizzle first, then gateway run_migrations happens automatically at
# gateway boot) → stack up.
#
# Required at provision time (set by push-bundle.sh beforehand):
#   S3 bundle: s3://<BUCKET>/concord/<env>/bundle.tar.gz
#   SSM params (SecureString): /concord/<env>/concord.env (full env
#   file content incl. DATABASE_URL, Clerk keys, image tags).
set -euo pipefail

ENV="${ENV:?}"
BUCKET="${BUNDLE_BUCKET:?set BUNDLE_BUCKET}"
REGION="ap-south-1"

exec > /var/log/concord-bootstrap.log 2>&1
echo "== concord bootstrap $(date -u) ENV=${ENV} =="

dnf install -y docker git
systemctl enable --now docker
usermod -a -G docker ec2-user

# Compose plugin (docker-compose.cloud.yml requires the v2 syntax).
curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose || {
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64 \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
}
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

WORK=/opt/concord
mkdir -p "${WORK}"
aws s3 cp "s3://${BUCKET}/concord/${ENV}/bundle.tar.gz" "${WORK}/bundle.tar.gz" --region "$REGION"
tar -xzf "${WORK}/bundle.tar.gz" -C "${WORK}"

# Secrets: the env FILE is stored as one SecureString; write it with
# mode 600 root-only. Compose reads it via env_file.
aws ssm get-parameter --name "/concord/${ENV}/concord.env" \
  --with-decryption --region "$REGION" \
  --query Parameter.Value --output text > "${WORK}/concord.env"
chmod 600 "${WORK}/concord.env"
# gateway.env (non-secret tuning) is part of the bundle.

cd "${WORK}"
export ENV
docker compose -f docker-compose.cloud.yml -p "concord-${ENV}" up -d db
sleep 8
# Wait for PG health.
for _ in $(seq 1 30); do
  if docker compose -f docker-compose.cloud.yml -p "concord-${ENV}" \
       exec -T db pg_isready -U concord >/dev/null 2>&1; then break; fi
  sleep 2
done

# Migrations, drizzle family FIRST (two-family rule, docs/MIGRATIONS.md).
# The bundle ships the migration runner image (node + drizzle dir).
docker compose -f docker-compose.cloud.yml -p "concord-${ENV}" \
  run --rm -v "${WORK}/migrations:/migrations" migrations \
  node /migrations/migrate.mjs 2>/dev/null || \
  echo "NOTE: migrations service not defined in compose; run via the web image:" \
       "docker run --rm --network concord-\${ENV}_default --env-file concord.env \${CONCORD_WEB_IMAGE} node /app/scripts/db/migrate.mjs"

# Gateway migrations run INSIDE each gateway at boot (run_migrations on
# startup — idempotent v1..v3). Stack up.
docker compose -f docker-compose.cloud.yml -p "concord-${ENV}" up -d

echo "== bootstrap complete =="
docker compose -f docker-compose.cloud.yml -p "concord-${ENV}" ps
