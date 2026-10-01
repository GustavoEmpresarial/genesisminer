#!/usr/bin/env bash
# Backfill conservador: 1x asic_dolar_f2p por user afectado (streak>=7, lease antes do gap).
#
# 1) Lista user_ids via a mesma lógica do .sql (preview).
# 2) Com --apply: credita 1 cada via genesisminer-hardware /v1/hardware/credit.
#
# NÃO INSERT cru em leases/stock.
# Idempotência: skip se lease asic_dolar_f2p acquired_at na última hora (MS_PER_HOUR).
# Ops tag humana: 20260917-checkin-streak-backfill
#
# Uso (VM):
#   bash scripts/ops/checkin-backfill-missed-streak-leases-20260917.sh          # list only
#   bash scripts/ops/checkin-backfill-missed-streak-leases-20260917.sh --dry-run # list + would-credit
#   bash scripts/ops/checkin-backfill-missed-streak-leases-20260917.sh --apply
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${GENESIS_DEPLOY_ENV:-${REPO_ROOT}/deploy/.env}"
OPS_TAG='20260917-checkin-streak-backfill'
ITEM_ID='asic_dolar_f2p'
CREDIT_QTY=1
# Espelha server/shared/utils/time.ts MS_PER_HOUR
MS_PER_HOUR=$((60 * 60 * 1000))
# Espelha CHECKIN_REWARD_EVERY_DAYS
CHECKIN_REWARD_EVERY_DAYS=7
# Cutover aproximado path Rust live sem grant (UTC) — mesma fonte do .sql
BUG_GRANT_DEAD_SINCE_SQL="TIMESTAMPTZ '2026-08-01 00:00:00+00'"
HARDWARE_CONTAINER='genesisminer-hardware'
POSTGRES_CONTAINER='postgres_app'
POSTGRES_DB="${POSTGRES_DB:-minestation}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
HARDWARE_PORT="${MINING_WORKER_PORT:-8091}"

APPLY=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      echo "Usage: $0 [--dry-run|--apply]"
      exit 0
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: deploy env não encontrado: $ENV_FILE" >&2
  exit 1
fi

TOKEN="$(grep -E '^(MINING_WORKER_AUTH_TOKEN|MINING_WORKER_TOKEN)=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '\r' || true)"
PGPASS="$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '\r' || true)"
if [[ -z "${TOKEN}" || -z "${PGPASS}" ]]; then
  echo "ERROR: MINING_WORKER_AUTH_TOKEN/TOKEN ou POSTGRES_PASSWORD em falta em $ENV_FILE" >&2
  exit 1
fi

psql_tAc() {
  docker exec -e PGPASSWORD="$PGPASS" "$POSTGRES_CONTAINER" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"
}

echo "[${OPS_TAG}] listing affected user_ids…"
mapfile -t USER_IDS < <(psql_tAc "
WITH consts AS (
  SELECT
    ${CHECKIN_REWARD_EVERY_DAYS}::int AS checkin_reward_every_days,
    '${ITEM_ID}'::text AS streak_item_id,
    (EXTRACT(EPOCH FROM ${BUG_GRANT_DEAD_SINCE_SQL}) * 1000)::bigint AS bug_grant_dead_since_ms
),
policy_item AS (
  SELECT COALESCE(NULLIF(BTRIM(value), ''), c.streak_item_id) AS item_id
  FROM consts c
  LEFT JOIN settings s ON s.key = 'checkin_streak_reward_item_id'
  LIMIT 1
),
last_leases AS (
  SELECT l.user_id, MAX(l.acquired_at) AS last_acquired_at
  FROM player_asic_leases l
  CROSS JOIN policy_item p
  WHERE l.item_id = p.item_id
  GROUP BY l.user_id
)
SELECT gs.user_id
FROM game_states gs
CROSS JOIN consts c
LEFT JOIN last_leases ll ON ll.user_id = gs.user_id
WHERE gs.checkin_streak >= c.checkin_reward_every_days
  AND (
    ll.last_acquired_at IS NULL
    OR ll.last_acquired_at < c.bug_grant_dead_since_ms
  )
ORDER BY gs.user_id;
")

echo "[${OPS_TAG}] count=${#USER_IDS[@]}"
if [[ "${#USER_IDS[@]}" -eq 0 ]]; then
  echo "[${OPS_TAG}] nenhum afectado."
  exit 0
fi
printf '%s\n' "${USER_IDS[@]}"

if [[ "$APPLY" -eq 0 && "$DRY_RUN" -eq 0 ]]; then
  echo "[${OPS_TAG}] list-only. Re-run com --dry-run ou --apply para creditar."
  exit 0
fi

DURATION_AMOUNT="$(psql_tAc "SELECT NULLIF(BTRIM(value), '') FROM settings WHERE key = 'checkin_streak_reward_duration_amount' LIMIT 1;")"
DURATION_UNIT="$(psql_tAc "SELECT NULLIF(BTRIM(value), '') FROM settings WHERE key = 'checkin_streak_reward_duration_unit' LIMIT 1;")"
DURATION_AMOUNT="$(echo "$DURATION_AMOUNT" | tr -d '[:space:]')"
DURATION_UNIT="$(echo "$DURATION_UNIT" | tr -d '[:space:]')"
if [[ -z "$DURATION_AMOUNT" || -z "$DURATION_UNIT" ]]; then
  echo "ERROR: settings checkin_streak_reward_duration_amount/unit em falta — não inventar duração." >&2
  exit 1
fi

NOW_MS="$(psql_tAc "SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;")"
NOW_MS="$(echo "$NOW_MS" | tr -d '[:space:]')"
CUTOFF_MS=$((NOW_MS - MS_PER_HOUR))

for uid in "${USER_IDS[@]}"; do
  uid="$(echo "$uid" | tr -d '[:space:]')"
  [[ -z "$uid" ]] && continue
  recent="$(psql_tAc "
    SELECT COUNT(*)::int FROM player_asic_leases
    WHERE user_id = ${uid} AND item_id = '${ITEM_ID}' AND acquired_at >= ${CUTOFF_MS};
  ")"
  recent="$(echo "$recent" | tr -d '[:space:]')"
  if [[ "${recent}" != "0" ]]; then
    echo "[${OPS_TAG}] SKIP userId=${uid} — lease recente (1h)."
    continue
  fi
  body="$(printf '{"userId":%s,"itemId":"%s","qty":%s,"durationAmount":%s,"durationUnit":"%s"}' \
    "$uid" "$ITEM_ID" "$CREDIT_QTY" "$DURATION_AMOUNT" "$DURATION_UNIT")"
  if [[ "$DRY_RUN" -eq 1 || "$APPLY" -eq 0 ]]; then
    echo "[${OPS_TAG}] DRY-RUN would credit userId=${uid}"
    continue
  fi
  echo "[${OPS_TAG}] crediting userId=${uid}…"
  resp="$(docker exec "$HARDWARE_CONTAINER" curl -sS -X POST \
    "http://127.0.0.1:${HARDWARE_PORT}/v1/hardware/credit" \
    -H 'content-type: application/json' \
    -H 'accept: application/json' \
    -H "x-mining-worker-token: ${TOKEN}" \
    -d "$body")"
  echo "[${OPS_TAG}] userId=${uid} response=${resp}"
  if ! echo "$resp" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    echo "ERROR: credit falhou userId=${uid}" >&2
    exit 1
  fi
done

echo "[${OPS_TAG}] done apply=${APPLY} dry_run=${DRY_RUN}"
