#!/usr/bin/env bash
# Compensa tickets check-in streak (2026-09-17): userIds 10589 e 12687.
#
# Credita 1x asic_dolar_f2p via genesisminer-hardware /v1/hardware/credit
# (duração lida de settings checkin_streak_reward_duration_* — tipicamente 45 day).
#
# NÃO fazer INSERT cru em player_asic_leases/stock.
# NÃO correr da workstation de desenvolvimento — só na VM (este script não faz deploy).
#
# Idempotência: correr UMA vez. Antes de cada credit, recusa se já existir lease
# asic_dolar_f2p com acquired_at na última hora (MS_PER_HOUR em server/shared/utils/time.ts).
#
# Uso (VM, repo em /root/genesis-current ou path equivalente):
#   bash scripts/ops/checkin-compensate-streak-tickets-20260917.sh
#   bash scripts/ops/checkin-compensate-streak-tickets-20260917.sh --dry-run
#
# Ops tag (humana): 20260917-checkin-streak-tickets
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${GENESIS_DEPLOY_ENV:-${REPO_ROOT}/deploy/.env}"
OPS_TAG='20260917-checkin-streak-tickets'
ITEM_ID='asic_dolar_f2p'
# Espelha CHECKIN_REWARD qty do grant (sempre 1 unidade).
CREDIT_QTY=1
# Espelha server/shared/utils/time.ts MS_PER_HOUR
MS_PER_HOUR=$((60 * 60 * 1000))
HARDWARE_CONTAINER='genesisminer-hardware'
POSTGRES_CONTAINER='postgres_app'
POSTGRES_DB="${POSTGRES_DB:-minestation}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
HARDWARE_PORT="${MINING_WORKER_PORT:-8091}"

USER_IDS=(10589 12687)
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      echo "Usage: $0 [--dry-run]"
      exit 0
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: deploy env não encontrado: $ENV_FILE" >&2
  exit 1
fi

# Prefer MINING_WORKER_AUTH_TOKEN (compose); aceitar alias legado MINING_WORKER_TOKEN se presente.
TOKEN="$(grep -E '^(MINING_WORKER_AUTH_TOKEN|MINING_WORKER_TOKEN)=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '\r' || true)"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: MINING_WORKER_AUTH_TOKEN (ou MINING_WORKER_TOKEN) ausente em $ENV_FILE" >&2
  exit 1
fi

PGPASS="$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '\r' || true)"
if [[ -z "${PGPASS}" ]]; then
  echo "ERROR: POSTGRES_PASSWORD ausente em $ENV_FILE" >&2
  exit 1
fi

psql_tAc() {
  docker exec -e PGPASSWORD="$PGPASS" "$POSTGRES_CONTAINER" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"
}

echo "[${OPS_TAG}] loading streak duration from settings…"
DURATION_AMOUNT="$(psql_tAc "SELECT NULLIF(BTRIM(value), '') FROM settings WHERE key = 'checkin_streak_reward_duration_amount' LIMIT 1;")"
DURATION_UNIT="$(psql_tAc "SELECT NULLIF(BTRIM(value), '') FROM settings WHERE key = 'checkin_streak_reward_duration_unit' LIMIT 1;")"
DURATION_AMOUNT="$(echo "$DURATION_AMOUNT" | tr -d '[:space:]')"
DURATION_UNIT="$(echo "$DURATION_UNIT" | tr -d '[:space:]')"
if [[ -z "$DURATION_AMOUNT" || -z "$DURATION_UNIT" ]]; then
  echo "ERROR: settings checkin_streak_reward_duration_amount/unit em falta — não inventar duração." >&2
  exit 1
fi
echo "[${OPS_TAG}] durationAmount=${DURATION_AMOUNT} durationUnit=${DURATION_UNIT} itemId=${ITEM_ID}"

NOW_MS="$(psql_tAc "SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;")"
NOW_MS="$(echo "$NOW_MS" | tr -d '[:space:]')"
CUTOFF_MS=$((NOW_MS - MS_PER_HOUR))

credit_one() {
  local uid="$1"
  local recent
  recent="$(psql_tAc "
    SELECT COUNT(*)::int
    FROM player_asic_leases
    WHERE user_id = ${uid}
      AND item_id = '${ITEM_ID}'
      AND acquired_at >= ${CUTOFF_MS};
  ")"
  recent="$(echo "$recent" | tr -d '[:space:]')"
  if [[ "${recent}" != "0" ]]; then
    echo "[${OPS_TAG}] SKIP userId=${uid} — já existe lease ${ITEM_ID} na última hora (idempotência)."
    return 0
  fi

  local body
  body="$(printf '{"userId":%s,"itemId":"%s","qty":%s,"durationAmount":%s,"durationUnit":"%s"}' \
    "$uid" "$ITEM_ID" "$CREDIT_QTY" "$DURATION_AMOUNT" "$DURATION_UNIT")"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[${OPS_TAG}] DRY-RUN would credit userId=${uid} body=${body}"
    return 0
  fi

  echo "[${OPS_TAG}] crediting userId=${uid}…"
  local resp
  resp="$(docker exec "$HARDWARE_CONTAINER" curl -sS -X POST \
    "http://127.0.0.1:${HARDWARE_PORT}/v1/hardware/credit" \
    -H 'content-type: application/json' \
    -H 'accept: application/json' \
    -H "x-mining-worker-token: ${TOKEN}" \
    -d "$body")"
  echo "[${OPS_TAG}] userId=${uid} response=${resp}"
  if ! echo "$resp" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    echo "ERROR: credit falhou para userId=${uid}" >&2
    exit 1
  fi
}

for uid in "${USER_IDS[@]}"; do
  credit_one "$uid"
done

echo "[${OPS_TAG}] done (dry_run=${DRY_RUN}). Verificar leases:"
echo "  SELECT user_id, id, acquired_at, expires_at, status FROM player_asic_leases"
echo "  WHERE user_id IN (10589,12687) AND item_id='${ITEM_ID}' ORDER BY acquired_at DESC;"
