#!/usr/bin/env bash
# Apply + verify additive indexes: 20260820010000_perf_hotpath_indexes
#
# DEFAULT = verify only (safe, read-only).
# APPLY requires CONFIRM=1 and an explicit mode.
#
# Modes:
#   verify          — list expected indexes; exit 1 if any missing (default)
#   apply-sql       — run migration.sql via psql (recommended for dump-based VPS)
#   apply-prisma    — npx prisma migrate deploy (only if migration history is intentional)
#
# Usage:
#   ./scripts/apply-perf-hotpath-indexes.sh verify
#   CONFIRM=1 ./scripts/apply-perf-hotpath-indexes.sh apply-sql
#   CONFIRM=1 ./scripts/apply-perf-hotpath-indexes.sh apply-prisma
#
# Requires: DATABASE_URL in env (or .env loaded by caller). Never prints the URL.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_SQL="$ROOT/prisma/migrations/20260820010000_perf_hotpath_indexes/migration.sql"
MODE="${1:-verify}"

EXPECTED_INDEXES=(
  users_blocked_ranking_excluded_idx
  placed_racks_is_on_user_idx
  placed_racks_user_id_idx
  player_listings_status_expires_idx
  player_listings_user_status_idx
  player_listings_status_reserved_until_idx
  p2p_trade_history_buyer_created_idx
  p2p_trade_history_seller_created_idx
  mining_yield_history_effective_at_idx
  mining_yield_history_coin_effective_idx
  withdrawal_requests_user_created_idx
)

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_database_url() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    if [[ -f "$ROOT/.env" ]]; then
      local line
      line="$(grep -E '^DATABASE_URL=' "$ROOT/.env" | tail -n1 || true)"
      if [[ -n "$line" ]]; then
        DATABASE_URL="${line#DATABASE_URL=}"
        DATABASE_URL="${DATABASE_URL#\"}"
        DATABASE_URL="${DATABASE_URL%\"}"
        DATABASE_URL="${DATABASE_URL#\'}"
        DATABASE_URL="${DATABASE_URL%\'}"
        export DATABASE_URL
      fi
    fi
  fi
  [[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL não definido (env ou .env)."
}

psql_q() {
  # -v ON_ERROR_STOP=1; no password echo; quiet tuples
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q "$@"
}

verify_indexes() {
  require_database_url
  [[ -f "$MIG_SQL" ]] || die "migration.sql em falta: $MIG_SQL"

  echo "== verify: índices esperados (${#EXPECTED_INDEXES[@]}) =="
  local missing=0
  local found
  found="$(psql_q -Atc "
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = ANY(ARRAY[
        $(printf "'%s'," "${EXPECTED_INDEXES[@]}" | sed 's/,$//')
      ])
    ORDER BY 1;
  ")"

  local idx
  for idx in "${EXPECTED_INDEXES[@]}"; do
    if printf '%s\n' "$found" | grep -qx "$idx"; then
      echo "  OK  $idx"
    else
      echo "  MISSING  $idx"
      missing=$((missing + 1))
    fi
  done

  if [[ "$missing" -gt 0 ]]; then
    echo "== FAIL: $missing índice(s) em falta =="
    exit 1
  fi
  echo "== PASS: todos os índices presentes =="
}

apply_sql() {
  require_database_url
  [[ -f "$MIG_SQL" ]] || die "migration.sql em falta: $MIG_SQL"
  [[ "${CONFIRM:-}" == "1" ]] || die "Defina CONFIRM=1 para aplicar (modo apply-sql)."

  echo "== apply-sql: a correr migration.sql (CREATE INDEX IF NOT EXISTS) =="
  psql_q -f "$MIG_SQL"
  echo "== apply-sql: done; a verificar =="
  verify_indexes
}

apply_prisma() {
  require_database_url
  [[ "${CONFIRM:-}" == "1" ]] || die "Defina CONFIRM=1 para aplicar (modo apply-prisma)."

  echo "== apply-prisma: prisma migrate deploy =="
  echo "AVISO: em VMs cutover/dump-based o projeto documenta NÃO usar migrate deploy"
  echo "        cegamente. Preferir apply-sql se _prisma_migrations não estiver alinhado."
  (
    cd "$ROOT"
    npx prisma migrate deploy
  )
  echo "== apply-prisma: done; a verificar =="
  verify_indexes
}

case "$MODE" in
  verify) verify_indexes ;;
  apply-sql) apply_sql ;;
  apply-prisma) apply_prisma ;;
  -h|--help|help)
    sed -n '1,25p' "$0"
    ;;
  *)
    die "modo desconhecido: $MODE (verify|apply-sql|apply-prisma)"
    ;;
esac
