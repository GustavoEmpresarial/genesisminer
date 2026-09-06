#!/usr/bin/env bash
# Purga cache Cloudflare (HTML/CSS/JS envenenados em /assets/* durante deploy).
# Requer no deploy/.env da VM:
#   CLOUDFLARE_API_TOKEN=...
#   CLOUDFLARE_ZONE_ID=...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${1:-$ROOT/deploy/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"
ZONE="${CLOUDFLARE_ZONE_ID:-${CF_ZONE_ID:-}}"

if [[ -z "$TOKEN" || -z "$ZONE" ]]; then
  echo "CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID required in $ENV_FILE" >&2
  exit 1
fi

PURGE_ALL="${PURGE_CF_ALL:-1}"

if [[ "$PURGE_ALL" == "1" ]]; then
  BODY='{"purge_everything":true}'
else
  BODY='{"files":["https://genesisdao.tech/","https://www.genesisdao.tech/","https://genesisdao.tech/assets/","https://www.genesisdao.tech/assets/"]}'
fi

echo "[cf-purge] zone=$ZONE purge_all=$PURGE_ALL"
curl -fsS -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data "$BODY"
echo
echo "[cf-purge] ok"
