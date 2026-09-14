#!/usr/bin/env bash
# Validate immutable image references in the compose files and Dockerfiles.
#
# Static compose images and every Dockerfile FROM must carry a 64-hex SHA-256
# digest. The cloud compose file receives the web/gateway release images from
# concord.env, so --require-runtime-images additionally requires those two
# environment variables to be present and digest-qualified.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

REQUIRE_RUNTIME=0
for arg in "$@"; do
  case "$arg" in
    --require-runtime-images) REQUIRE_RUNTIME=1 ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "image-pins: unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

errors=0
checked=0
deferred=0

check_ref() {
  local source="$1"
  local ref="$2"
  if [[ "$ref" =~ @sha256:[0-9a-fA-F]{64}$ ]]; then
    checked=$((checked + 1))
    echo "image-pins: OK $source -> $ref"
  else
    echo "image-pins: FAIL $source is not digest-qualified: $ref" >&2
    errors=$((errors + 1))
  fi
}

while IFS=$'\t' read -r source ref; do
  [ -n "${source:-}" ] || continue
  case "$ref" in
    '${CONCORD_WEB_IMAGE:'*|'${CONCORD_GATEWAY_IMAGE:'*)
      deferred=$((deferred + 1))
      echo "image-pins: deferred $source -> $ref (runtime input)"
      ;;
    *)
      check_ref "$source" "$ref"
      ;;
  esac
done < <(
  while IFS= read -r file; do
    awk '$1 == "FROM" { print FILENAME "\t" $2 }' "$file"
  done < <(rg --files docker | rg '(^|/)(Dockerfile|[^/]+\.Dockerfile)$')
  awk '$1 == "image:" { print FILENAME "\t" $2 }' docker-compose.yml docker-compose.cloud.yml
)

for name in CONCORD_WEB_IMAGE CONCORD_GATEWAY_IMAGE; do
  value="${!name-}"
  if [ -n "$value" ]; then
    check_ref "$name environment" "$value"
  elif [ "$REQUIRE_RUNTIME" -eq 1 ]; then
    echo "image-pins: FAIL $name is required with --require-runtime-images" >&2
    errors=$((errors + 1))
  else
    deferred=$((deferred + 1))
    echo "image-pins: deferred $name (not set; use --require-runtime-images in deployment validation)"
  fi
done

if [ "$errors" -gt 0 ]; then
  echo "image-pins: $errors invalid reference(s); refusing a mutable-image result" >&2
  exit 1
fi

echo "image-pins: $checked immutable reference(s) checked; $deferred runtime input(s) deferred"
