-- Restaura unopened_boxes de pacotes de upgrade comprados sem abertura correspondente.
-- Ticket: JFRB33 (user 41) + outros com "caixa do upgrade sumiu" / não consegue resgatar.
-- 2026-08-31

BEGIN;

WITH buys AS (
  SELECT user_id, upgrade_id, COUNT(*)::int AS buys
  FROM admin_upgrade_purchases
  GROUP BY user_id, upgrade_id
),
opens AS (
  SELECT
    user_id,
    CASE
      WHEN box_id LIKE 'upgrade_pkg_%' THEN SUBSTRING(box_id FROM 13)
      ELSE NULL
    END AS upgrade_id,
    COUNT(*)::int AS opens
  FROM lucky_box_openings
  WHERE box_id LIKE 'upgrade_pkg_%'
  GROUP BY user_id, 2
),
missing AS (
  SELECT
    b.user_id,
    ('upgrade_pkg_' || b.upgrade_id) AS box_id,
    GREATEST(0, b.buys - COALESCE(o.opens, 0))::int AS need
  FROM buys b
  LEFT JOIN opens o ON o.user_id = b.user_id AND o.upgrade_id = b.upgrade_id
  WHERE GREATEST(0, b.buys - COALESCE(o.opens, 0)) > 0
    AND EXISTS (SELECT 1 FROM loot_boxes lb WHERE lb.id = 'upgrade_pkg_' || b.upgrade_id)
)
INSERT INTO unopened_boxes (user_id, box_id, qty)
SELECT user_id, box_id, need FROM missing
ON CONFLICT (user_id, box_id) DO UPDATE
SET qty = GREATEST(unopened_boxes.qty, EXCLUDED.qty);

-- Preview / verify for ticket user 41
SELECT ub.user_id, u.email, ub.box_id, ub.qty, lb.name
FROM unopened_boxes ub
JOIN users u ON u.id = ub.user_id
LEFT JOIN loot_boxes lb ON lb.id = ub.box_id
WHERE ub.user_id = 41 OR ub.box_id = 'upgrade_pkg_73ef0b0b-47c4-4f15-a9fd-10dd2525e977'
ORDER BY ub.user_id, ub.box_id;

COMMIT;
