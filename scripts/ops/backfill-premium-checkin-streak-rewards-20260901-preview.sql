-- Preview: utilizadores premium que atingiram marcos 7/14/21… no check-in premium
-- mas não receberam máquina de sequência (bug no ramo premium até 2026-09-01).
--
-- Correr na VM:
--   PGPASS=$(grep '^POSTGRES_PASSWORD=' /root/genesis-current/deploy/.env | cut -d= -f2-)
--   docker exec -e PGPASSWORD="$PGPASS" postgres_app psql -U postgres -d minestation \
--     -f /root/genesis-current/scripts/ops/backfill-premium-checkin-streak-rewards-20260901-preview.sql

WITH premium_policy AS (
  SELECT COALESCE(NULLIF(BTRIM(value), ''), '195')::numeric AS min_usdc
  FROM settings
  WHERE key = 'checkin_premium_min_usdc'
  LIMIT 1
),
premium_users AS (
  SELECT DISTINCT p.user_id
  FROM admin_upgrade_purchases p
  INNER JOIN admin_upgrades u ON u.id = p.upgrade_id
  CROSS JOIN premium_policy pol
  WHERE u.price_usdc >= pol.min_usdc
),
premium_milestones AS (
  SELECT
    e.user_id,
    (e.payload->>'streak')::int AS streak,
    e.at_ms
  FROM mining_eligibility_events e
  INNER JOIN premium_users pu ON pu.user_id = e.user_id
  WHERE e.event_type = 'CHECKIN_RECORDED'
    AND COALESCE(e.payload->>'mode', '') = 'premium'
    AND (e.payload->>'streak') ~ '^[0-9]+$'
    AND ((e.payload->>'streak')::int % 7) = 0
    AND (e.payload->>'streak')::int > 0
),
backfill_state AS (
  SELECT COALESCE(value, '{}')::jsonb AS state
  FROM settings
  WHERE key = 'ops_backfill_premium_streak_20260901'
  LIMIT 1
)
SELECT
  pm.user_id,
  u.username,
  gs.checkin_streak AS current_streak,
  COUNT(*)::int AS milestone_events,
  ARRAY_AGG(pm.streak ORDER BY pm.at_ms) AS milestone_streaks,
  COALESCE(
    (SELECT jsonb_array_length(COALESCE((bs.state->pm.user_id::text->'grantedStreaks'), '[]'::jsonb)) FROM backfill_state bs),
    0
  ) AS already_backfilled
FROM premium_milestones pm
JOIN users u ON u.id = pm.user_id
LEFT JOIN game_states gs ON gs.user_id = pm.user_id
GROUP BY pm.user_id, u.username, gs.checkin_streak
ORDER BY milestone_events DESC, pm.user_id
LIMIT 200;
