-- Dry-count / preview: equip asic_dolar_f2p + asic_dolar_f2p2 into empty
-- holes on army/promo (+ merge) racks already in Sala ASICs.
-- Read-only. Does not mutate.
--
-- Prod:
--   PGPASS=$(grep '^POSTGRES_PASSWORD=' /root/genesis-current/deploy/.env | cut -d= -f2-)
--   docker exec -i -e PGPASSWORD="$PGPASS" postgres_app \
--     psql -U postgres -d minestation -v ON_ERROR_STOP=1 -P pager=off \
--     < /root/genesis-current/scripts/ops/equip-dolar-f2p-asic-room-racks-preview-20260827.sql

\set ON_ERROR_STOP on

\echo -- catalog duration (expect 28 day)
SELECT id, asic_duration_amount, asic_duration_unit, asic_duration_kind
FROM upgrades
WHERE id IN ('asic_dolar_f2p', 'asic_dolar_f2p2')
ORDER BY id;

\echo
\echo -- A) residual stock-only (qty>0, zero valid stock leases) — would mint
WITH now_ms AS (
  SELECT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS ms
),
residual AS (
  SELECT s.user_id, s.item_id, s.qty
  FROM stock s
  CROSS JOIN now_ms n
  WHERE s.item_id IN ('asic_dolar_f2p', 'asic_dolar_f2p2')
    AND s.qty > 0
    AND NOT EXISTS (
      SELECT 1
      FROM player_asic_leases pal
      WHERE pal.user_id = s.user_id
        AND pal.item_id = s.item_id
        AND pal.status = 'stock'
        AND pal.expires_at > n.ms
    )
)
SELECT item_id, COUNT(*)::int AS users, COALESCE(SUM(qty), 0)::int AS units_to_mint
FROM residual
GROUP BY item_id
ORDER BY item_id;

\echo
\echo -- B) target racks / holes / leases / fillable
WITH now_ms AS (
  SELECT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS ms
),
racks AS (
  SELECT
    pr.id AS rack_id,
    pr.user_id,
    pr.slot_index AS rack_slot_index,
    COALESCE(u.slots_capacity, 6)::int AS cap
  FROM placed_racks pr
  LEFT JOIN upgrades u ON u.id = pr.item_id
  WHERE pr.room_id = 'room_1775484506874'
    AND (
      pr.item_id IN ('rack_promo', 'rack_army')
      OR pr.item_id LIKE 'merge\_rack\_promo\_%' ESCAPE '\'
      OR pr.item_id LIKE 'merge\_rack\_army\_%' ESCAPE '\'
      OR (pr.item_id LIKE 'merge\_%' AND pr.item_id LIKE '%\_rack\_promo\_%')
      OR (pr.item_id LIKE 'merge\_%' AND pr.item_id LIKE '%\_rack\_army\_%')
    )
),
holes AS (
  SELECT r.user_id, r.rack_id, g.slot_index AS hole_si
  FROM racks r
  CROSS JOIN LATERAL generate_series(0, r.cap - 1) AS g(slot_index)
  WHERE NOT EXISTS (
    SELECT 1
    FROM rack_slots rs
    WHERE rs.rack_id = r.rack_id
      AND rs.slot_index = g.slot_index
      AND rs.machine_item_id IS NOT NULL
      AND btrim(rs.machine_item_id) <> ''
  )
),
leases AS (
  SELECT pal.user_id, pal.item_id, pal.id
  FROM player_asic_leases pal
  CROSS JOIN now_ms n
  WHERE pal.item_id IN ('asic_dolar_f2p', 'asic_dolar_f2p2')
    AND pal.status = 'stock'
    AND pal.expires_at > n.ms
),
per_user AS (
  SELECT
    COALESCE(h.user_id, l.user_id) AS user_id,
    COALESCE(h.holes, 0) AS holes,
    COALESCE(l.leases, 0) AS leases,
    LEAST(COALESCE(h.holes, 0), COALESCE(l.leases, 0)) AS fillable
  FROM (
    SELECT user_id, COUNT(*)::int AS holes FROM holes GROUP BY user_id
  ) h
  FULL OUTER JOIN (
    SELECT user_id, COUNT(*)::int AS leases FROM leases GROUP BY user_id
  ) l ON l.user_id = h.user_id
),
residual AS (
  SELECT COALESCE(SUM(s.qty), 0)::int AS units
  FROM stock s
  CROSS JOIN now_ms n
  WHERE s.item_id IN ('asic_dolar_f2p', 'asic_dolar_f2p2')
    AND s.qty > 0
    AND NOT EXISTS (
      SELECT 1 FROM player_asic_leases pal
      WHERE pal.user_id = s.user_id AND pal.item_id = s.item_id
        AND pal.status = 'stock' AND pal.expires_at > n.ms
    )
)
SELECT 'target_racks' AS k, COUNT(*)::int AS n FROM racks
UNION ALL SELECT 'empty_holes', COUNT(*)::int FROM holes
UNION ALL SELECT 'stock_leases_now', COUNT(*)::int FROM leases
UNION ALL SELECT 'stock_leases_f2p', COUNT(*)::int FROM leases WHERE item_id = 'asic_dolar_f2p'
UNION ALL SELECT 'stock_leases_f2p2', COUNT(*)::int FROM leases WHERE item_id = 'asic_dolar_f2p2'
UNION ALL SELECT 'would_mint_residual', (SELECT units FROM residual)
UNION ALL SELECT 'would_place_fillable', COALESCE(SUM(fillable), 0)::int FROM per_user
UNION ALL SELECT 'users_would_place', COUNT(*)::int FROM per_user WHERE fillable > 0
UNION ALL SELECT 'holes_after_place', COALESCE(SUM(holes - fillable), 0)::int FROM per_user
UNION ALL SELECT 'leases_stock_after_place',
  (SELECT COUNT(*)::int FROM leases) + (SELECT units FROM residual)
  - COALESCE((SELECT SUM(fillable) FROM per_user), 0);

\echo
\echo -- fillable note: residual mint adds leases before pair; adjust fillable for mint users
WITH now_ms AS (
  SELECT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS ms
),
racks AS (
  SELECT
    pr.id AS rack_id,
    pr.user_id,
    COALESCE(u.slots_capacity, 6)::int AS cap
  FROM placed_racks pr
  LEFT JOIN upgrades u ON u.id = pr.item_id
  WHERE pr.room_id = 'room_1775484506874'
    AND (
      pr.item_id IN ('rack_promo', 'rack_army')
      OR pr.item_id LIKE 'merge\_rack\_promo\_%' ESCAPE '\'
      OR pr.item_id LIKE 'merge\_rack\_army\_%' ESCAPE '\'
      OR (pr.item_id LIKE 'merge\_%' AND pr.item_id LIKE '%\_rack\_promo\_%')
      OR (pr.item_id LIKE 'merge\_%' AND pr.item_id LIKE '%\_rack\_army\_%')
    )
),
holes AS (
  SELECT r.user_id, COUNT(*)::int AS holes
  FROM racks r
  CROSS JOIN LATERAL generate_series(0, r.cap - 1) AS g(slot_index)
  WHERE NOT EXISTS (
    SELECT 1 FROM rack_slots rs
    WHERE rs.rack_id = r.rack_id AND rs.slot_index = g.slot_index
      AND rs.machine_item_id IS NOT NULL AND btrim(rs.machine_item_id) <> ''
  )
  GROUP BY r.user_id
),
leases AS (
  SELECT pal.user_id, COUNT(*)::int AS leases
  FROM player_asic_leases pal
  CROSS JOIN now_ms n
  WHERE pal.item_id IN ('asic_dolar_f2p', 'asic_dolar_f2p2')
    AND pal.status = 'stock' AND pal.expires_at > n.ms
  GROUP BY pal.user_id
),
mint AS (
  SELECT s.user_id, SUM(s.qty)::int AS mint_n
  FROM stock s
  CROSS JOIN now_ms n
  WHERE s.item_id IN ('asic_dolar_f2p', 'asic_dolar_f2p2')
    AND s.qty > 0
    AND NOT EXISTS (
      SELECT 1 FROM player_asic_leases pal
      WHERE pal.user_id = s.user_id AND pal.item_id = s.item_id
        AND pal.status = 'stock' AND pal.expires_at > n.ms
    )
  GROUP BY s.user_id
),
merged AS (
  SELECT
    COALESCE(h.user_id, l.user_id, m.user_id) AS user_id,
    COALESCE(h.holes, 0) AS holes,
    COALESCE(l.leases, 0) + COALESCE(m.mint_n, 0) AS leases_after_mint
  FROM holes h
  FULL OUTER JOIN leases l ON l.user_id = h.user_id
  FULL OUTER JOIN mint m ON m.user_id = COALESCE(h.user_id, l.user_id)
)
SELECT
  COALESCE(SUM(LEAST(holes, leases_after_mint)), 0)::int AS would_place_after_mint,
  COALESCE(SUM(holes), 0)::int AS holes_total,
  COALESCE(SUM(leases_after_mint), 0)::int AS leases_after_mint_total,
  COALESCE(SUM(GREATEST(0, leases_after_mint - holes)), 0)::int AS stock_leases_remaining_after,
  COALESCE(SUM(GREATEST(0, holes - leases_after_mint)), 0)::int AS holes_remaining_after
FROM merged;

\echo
\echo -- safety snapshot (pre)
WITH now_ms AS (SELECT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS ms)
SELECT 'f2p_slots_null_lease_asic_army_promo' AS k, COUNT(*)::int AS n
FROM rack_slots rs
JOIN placed_racks pr ON pr.id = rs.rack_id
WHERE pr.room_id = 'room_1775484506874'
  AND rs.machine_item_id IN ('asic_dolar_f2p', 'asic_dolar_f2p2')
  AND rs.machine_lease_id IS NULL
  AND (
    pr.item_id IN ('rack_promo', 'rack_army')
    OR pr.item_id LIKE 'merge\_rack\_promo\_%' ESCAPE '\'
    OR pr.item_id LIKE 'merge\_rack\_army\_%' ESCAPE '\'
    OR (pr.item_id LIKE 'merge\_%' AND pr.item_id LIKE '%\_rack\_promo\_%')
    OR (pr.item_id LIKE 'merge\_%' AND pr.item_id LIKE '%\_rack\_army\_%')
  )
UNION ALL
SELECT 'stock_qty_gt_lease_stock', COUNT(*)::int
FROM stock s
CROSS JOIN now_ms n
WHERE s.item_id IN ('asic_dolar_f2p', 'asic_dolar_f2p2')
  AND s.qty > COALESCE((
    SELECT COUNT(*)::int FROM player_asic_leases pal
    WHERE pal.user_id = s.user_id AND pal.item_id = s.item_id
      AND pal.status = 'stock' AND pal.expires_at > n.ms
  ), 0);
