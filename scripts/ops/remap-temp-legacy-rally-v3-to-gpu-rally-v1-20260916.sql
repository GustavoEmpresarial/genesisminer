-- Mass convert invisible temp_legacy_*_rally_v3 stock → gpu_rally_v1.
-- Root cause: placeholder original=rally_v3 but upgrades.rally_v3 no longer exists,
-- so inventory resolve_stackable_rows skips the row (player sees "RALLY sumiu").
-- Idempotent once temp rows are gone.
-- Applied on prod 2026-09-16 (169 players / 349 qty).
-- 2026-09-16

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _rally_fix ON COMMIT DROP AS
SELECT user_id, sum(qty)::int AS qty
FROM stock
WHERE item_id LIKE 'temp_legacy\_%\_rally_v3' ESCAPE '\'
  AND qty > 0
GROUP BY user_id;

INSERT INTO stock (user_id, item_id, qty)
SELECT user_id, 'gpu_rally_v1', qty FROM _rally_fix
ON CONFLICT (user_id, item_id) DO UPDATE
  SET qty = stock.qty + EXCLUDED.qty;

DELETE FROM stock
WHERE item_id LIKE 'temp_legacy\_%\_rally_v3' ESCAPE '\';

UPDATE item_instances
SET catalog_item_id = 'gpu_rally_v1',
    code = 'gpu_rally_v1:' || id::text
WHERE catalog_item_id LIKE 'temp_legacy\_%\_rally_v3' ESCAPE '\'
  AND status = 'stock';

INSERT INTO inventory_movements (user_id, action, catalog_item_id, quantity_before, quantity_after, meta, created_at)
SELECT
  f.user_id,
  'admin_compensate',
  'gpu_rally_v1',
  coalesce(s.qty, 0) - f.qty,
  coalesce(s.qty, 0),
  '{"reason":"mass convert temp_legacy_*_rally_v3 (missing rally_v3 catalog) to gpu_rally_v1","converted_qty":' || f.qty::text || ',"ops":"20260916-rally-temp-legacy"}',
  (extract(epoch from now()) * 1000)::bigint
FROM _rally_fix f
LEFT JOIN stock s ON s.user_id = f.user_id AND s.item_id = 'gpu_rally_v1';

UPDATE game_states gs
SET inventory_version = inventory_version + 1,
    server_updated_at = (extract(epoch from now()) * 1000)::bigint
FROM _rally_fix f
WHERE gs.user_id = f.user_id;

SELECT count(*) AS remaining_temp_players, coalesce(sum(qty),0) AS remaining_temp_qty
FROM stock WHERE item_id LIKE 'temp_legacy\_%\_rally_v3' ESCAPE '\' AND qty > 0;

COMMIT;
