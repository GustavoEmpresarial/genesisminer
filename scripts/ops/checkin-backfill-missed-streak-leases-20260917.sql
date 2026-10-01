-- Preview + listagem: jogadores com streak>=7 sem lease recente de asic_dolar_f2p
-- (bug 2026-09: Rust forçava streakRewardGranted=0; grant morto no path live).
--
-- NÃO fazer INSERT/UPDATE em player_asic_leases nem stock aqui —
-- dessincroniza o worker hardware. Creditar só via:
--   scripts/ops/checkin-backfill-missed-streak-leases-20260917.sh
--   (ou scripts/ops/checkin-compensate-streak-tickets-20260917.sh para os 2 tickets)
--
-- Constantes:
--   CHECKIN_REWARD_EVERY_DAYS = 7 (rust/genesis-core + server reward.ts)
--   ITEM prod = asic_dolar_f2p (settings.checkin_streak_reward_item_id)
--   Janela "grant morto desde": 2026-08-01 00:00:00 UTC
--     (cutover aproximado do path Rust live sem grant — ajustar se refinado)
--   Ops tag humana: 20260917-checkin-streak-backfill
--
-- Correr na VM:
--   PGPASS=$(grep '^POSTGRES_PASSWORD=' /root/genesis-current/deploy/.env | cut -d= -f2-)
--   docker exec -e PGPASSWORD="$PGPASS" postgres_app psql -U postgres -d minestation \
--     -f /root/genesis-current/scripts/ops/checkin-backfill-missed-streak-leases-20260917.sql

\echo '=== PREVIEW: afectados (streak>=7, última lease asic_dolar_f2p antes do gap / ausente) ==='

WITH consts AS (
  SELECT
    7::int AS checkin_reward_every_days,
    'asic_dolar_f2p'::text AS streak_item_id,
    (EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-08-01 00:00:00+00') * 1000)::bigint AS bug_grant_dead_since_ms,
    (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms
),
policy_item AS (
  SELECT COALESCE(NULLIF(BTRIM(value), ''), c.streak_item_id) AS item_id
  FROM consts c
  LEFT JOIN settings s ON s.key = 'checkin_streak_reward_item_id'
  LIMIT 1
),
last_leases AS (
  SELECT
    l.user_id,
    MAX(l.acquired_at) AS last_acquired_at,
    COUNT(*)::int AS lease_rows
  FROM player_asic_leases l
  CROSS JOIN policy_item p
  WHERE l.item_id = p.item_id
  GROUP BY l.user_id
)
SELECT
  gs.user_id,
  u.username,
  u.email,
  gs.checkin_streak,
  gs.last_checkin_day,
  ll.last_acquired_at,
  ll.lease_rows,
  CASE
    WHEN ll.last_acquired_at IS NULL THEN 'no_lease'
    WHEN ll.last_acquired_at < c.bug_grant_dead_since_ms THEN 'lease_before_gap'
    ELSE 'ok_or_post_gap'
  END AS gap_class
FROM game_states gs
CROSS JOIN consts c
LEFT JOIN last_leases ll ON ll.user_id = gs.user_id
LEFT JOIN users u ON u.id = gs.user_id
WHERE gs.checkin_streak >= c.checkin_reward_every_days
  AND (
    ll.last_acquired_at IS NULL
    OR ll.last_acquired_at < c.bug_grant_dead_since_ms
  )
ORDER BY gs.checkin_streak DESC, gs.user_id
LIMIT 500;

\echo '=== APPLY (só LISTA user_ids para o parent creditar via shell — sem mutação) ==='
\echo 'Copiar user_id → scripts/ops/checkin-backfill-missed-streak-leases-20260917.sh --apply'

WITH consts AS (
  SELECT
    7::int AS checkin_reward_every_days,
    'asic_dolar_f2p'::text AS streak_item_id,
    (EXTRACT(EPOCH FROM TIMESTAMPTZ '2026-08-01 00:00:00+00') * 1000)::bigint AS bug_grant_dead_since_ms
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
