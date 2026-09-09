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
  # dbq '<sql>' — ad-hoc SQL against the cloud DB (read-only usage
  # intended). Piped via stdin so SSM JSON never touches the SQL.
  dbq)
    [ -n "${2:-}" ] || { echo "usage: instance-ops.sh dbq '<sql>'" >&2; exit 2; }
    printf '%s\n' "$2" | docker exec -i "concord-${ENV}-db" psql -U concord -d concord
    ;;
  # dbops <documentId> — durable op-log stats for one document.
  dbops)
    DOC="${2:?document id}"
    printf "SELECT count(*) AS ops, max(id) AS max_seq FROM crdt_operations WHERE document_id = '%s';\n" "$DOC" \
      | docker exec -i "concord-${ENV}-db" psql -U concord -d concord
    ;;
  smoke)
    echo "WS-adjacent HTTP smoke via LB (auth not exercised here):"
    for i in 1 2 3 4 5 6; do
      curl -s -m 5 -o /dev/null -w "lb:%{http_code} " http://127.0.0.1:8890/api/v1/health/live
    done; echo
    echo "(round-robin across gw1..gw3 — every response must be 200)"
    ;;
  worker)
    # generate_ops probe — the EXACT frame proven by the phase6 release
    # workflow: [u32 24][u32 6 cmd][u64 1 seed][u32 10 ops][u32 2
    # replicas][u32 0 shape]. Written via printf INSIDE this script (no
    # SSM JSON escaping in the path); expected head: [u32 0][u32 len]…
    probe=$(docker exec concord-"${ENV}"-gw1 sh -c \
      "printf '\\x18\\x00\\x00\\x00\\x06\\x00\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x0a\\x00\\x00\\x00\\x02\\x00\\x00\\x00\\x00\\x00\\x00\\x00' | /app/concord-worker 2>/dev/null | od -An -tu4 -N4 | tr -d '[:space:]'")
    echo "worker probe status: ${probe} (expect 0)"
    [ "$probe" = "0" ] && echo "WORKER: PASS" || echo "WORKER: FAIL"
    ;;
  prom)
    # Prometheus health + scrape targets + one gateway metric family.
    echo "--- targets up:"
    curl -s -m 5 'http://127.0.0.1:9090/api/v1/query?query=up' \
      | tr ',' '\n' | grep -E 'job|instance|"1"' | head -12
    echo "--- sample gateway metric (concord_* family):"
    curl -s -m 5 'http://127.0.0.1:9090/api/v1/query?query={__name__=~"concord.*"}' \
      | tr ',' '\n' | grep -oE '"__name__":"[^"]*"|"value":\["[0-9.]+"' | head -10
    ;;
  grafana)
    curl -s -m 5 -o /dev/null -w 'grafana loopback http: %{http_code}\n' \
      "http://127.0.0.1:3001/api/health"
    curl -s -m 5 "http://127.0.0.1:3001/api/health" | head -c 120; echo
    ;;
  restart)
    compose restart "${2:?service name}"
    ;;
  db-reset-password)
    # Recovery verb (used ONCE on staging 2026-09-09 after a re-publish
    # regenerated PG_PASSWORD): set the compose Postgres user's password
    # to the value in the deployed concord.env. docker exec runs as the
    # container's local superuser, so no password is needed to connect —
    # the ALTER runs entirely on the instance; nothing secret passes
    # through SSM JSON. Idempotent. (The SQL is piped via stdin: psql -v
    # variables cannot substitute into ALTER USER ... PASSWORD.)
    NEWPW="$(grep -E '^PG_PASSWORD=' "${UD_DIR}/concord.env" | cut -d= -f2-)"
    [ -n "$NEWPW" ] || { echo "PG_PASSWORD not found in concord.env" >&2; exit 2; }
    # shellcheck disable=SC2016  # single quotes keep $ literal for psql
    printf 'ALTER USER concord WITH PASSWORD %s;\n' "'$NEWPW'" \
      | docker exec -i "concord-${ENV}-db" psql -U concord -d concord
    echo "DB password aligned with concord.env"
    ;;
  bootstrap)
    bash "${UD_DIR}/user-data.sh"
    ;;
  *)
    echo "usage: instance-ops.sh {ps|health|logs <svc>|cron|cron-check|psql|dbq <sql>|dbops <doc>|worker|prom|grafana|smoke|restart <svc>|db-reset-password|bootstrap}" >&2
    exit 2
    ;;
esac
