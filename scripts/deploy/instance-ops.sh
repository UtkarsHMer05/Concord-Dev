#!/usr/bin/env bash
# P7-M021+ — On-instance ops helper (ships INSIDE the deployment bundle).
#
# Runs ON the EC2 instance (via SSM RunCommand — aws ssm send-command
# --parameters 'commands=["bash /opt/concord/instance-ops.sh <verb>"]').
# One verb per argument keeps SSM payloads free of the quoting hell
# that inline commands hit.
#
# Verbs:
#   ps          — compose ps (all services, one line each)
#   health      — all HTTP health endpoints from the instance
#   logs <svc>  — last 30 log lines of a container (default web)
#   cron        — (re)install the nightly backup cron (AL2023 minimal
#                 has no /etc/cron.d; mkdir -p first)
#   cron-check  — print the installed cron file + crond status
#   psql        — both migration registries + table inventory
#   smoke       — instance-side WS smoke: gateway health/live on all
#                 three replicas via the nginx LB (:8890)
#   restart <svc> — docker compose restart one service
#   bootstrap   — re-run the full user-data bootstrap (idempotent:
#                 migrations no-op via registries; stack up no-op)
set -euo pipefail

UD_DIR="$(cd "$(dirname "$0")" && pwd)"   # /opt/concord
# Compose interpolation vars (PG_PASSWORD, image refs) live in the
# deployed concord.env — source it (KEY=VALUE lines) before compose.
set -a
. "${UD_DIR}/concord.env"
set +a
ENV="${ENV:?ENV not in concord.env}"
PROJECT="concord-${ENV}"
compose() { docker compose -f "${UD_DIR}/docker-compose.cloud.yml" -p "$PROJECT" "$@"; }

case "${1:-ps}" in
  ps)
    compose ps --format 'table {{.Name}}\t{{.Status}}'
    ;;
  health)
    echo "--- web :3000 /api/health"; curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/health
    echo "--- lb :8890 /api/v1/health/live (all 3 replicas behind nginx)"
    for i in 1 2 3; do curl -s -m 5 -o /dev/null -w "try$i %{http_code}\n" http://127.0.0.1:8890/api/v1/health/live; done
    echo "--- gateways direct"; for p in 8791 8792 8793; do
      curl -s -m 5 -o /dev/null -w "gw:$p %{http_code}\n" "http://127.0.0.1:${p}/api/v1/health/live" || true; done
    ;;
  logs)
    docker logs "concord-${ENV}-${2:-web}" 2>&1 | tail -30
    ;;
  cron)
    mkdir -p /etc/cron.d /var/backups/concord
    printf '%s\n' \
      '# Concord nightly PostgreSQL dump (03:15, gzip, keep 14) — OPERATIONS.md.' \
      "15 3 * * * root docker exec concord-${ENV}-db pg_dump -U concord -d concord | gzip > /var/backups/concord/concord-\$(date +\%Y\%m\%d).sql.gz && find /var/backups/concord -name 'concord-*.sql.gz' -mtime +14 -delete" \
      > /etc/cron.d/concord-backup
    chmod 644 /etc/cron.d/concord-backup
    echo "cron installed:"
    cat /etc/cron.d/concord-backup
    ;;
  cron-check)
    cat /etc/cron.d/concord-backup 2>/dev/null || echo "cron NOT installed"
    systemctl is-active crond 2>/dev/null || echo "crond: not a systemd unit (check: docker exec concord-${ENV}-db date)"
    ;;
  psql)
    docker exec "concord-${ENV}-db" psql -U concord -d concord -c \
      "SELECT (SELECT max(id) FROM drizzle.__drizzle_migrations) AS drizzle,
              (SELECT max(version) FROM gateway_schema_migrations) AS gateway;"
    docker exec "concord-${ENV}-db" psql -U concord -d concord -c \
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1;"
    ;;
  smoke)
    echo "WS-adjacent HTTP smoke via LB (auth not exercised here):"
    for i in 1 2 3 4 5 6; do
      curl -s -m 5 -o /dev/null -w "lb:%{http_code} " http://127.0.0.1:8890/api/v1/health/live
    done; echo
    echo "(round-robin across gw1..gw3 — every response must be 200)"
    ;;
  restart)
    compose restart "${2:?service name}"
    ;;
  bootstrap)
    bash "${UD_DIR}/user-data.sh"
    ;;
  *)
    echo "usage: instance-ops.sh {ps|health|logs <svc>|cron|cron-check|psql|smoke|restart <svc>|bootstrap}" >&2
    exit 2
    ;;
esac
