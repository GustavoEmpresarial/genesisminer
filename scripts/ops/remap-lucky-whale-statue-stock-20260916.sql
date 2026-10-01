-- Remap legacy bare whale chip stock → canonical mult_lucky_whale_statue.
-- Prevents silent wipe when bare + mult keys collided under stock normalizer.
-- Idempotent: re-run is a no-op once bare qty / stock instances are gone.
-- 2026-09-16

\set ON_ERROR_STOP on
BEGIN;

-- 1) Merge stock bare → mult (qty add), then drop bare rows
INSERT INTO stock (user_id, item_id, qty)
SELECT user_id, 'mult_lucky_whale_statue', qty
  FROM stock
 WHERE item_id = 'lucky_whale_statue'
   AND qty <> 0
ON CONFLICT (user_id, item_id) DO UPDATE
  SET qty = stock.qty + EXCLUDED.qty;

DELETE FROM stock WHERE item_id = 'lucky_whale_statue';

-- 2) Retarget stock-status item_instances catalog_item_id + printable code
UPDATE item_instances
   SET catalog_item_id = 'mult_lucky_whale_statue',
       code = 'mult_lucky_whale_statue:' || id::text
 WHERE catalog_item_id = 'lucky_whale_statue'
   AND status = 'stock';

-- 3) Verify: bare stock qty must be 0
SELECT COALESCE(SUM(qty), 0) AS bare_lucky_whale_stock_qty
  FROM stock
 WHERE item_id = 'lucky_whale_statue';

SELECT COUNT(*) AS bare_lucky_whale_stock_instances
  FROM item_instances
 WHERE catalog_item_id = 'lucky_whale_statue'
   AND status = 'stock';

COMMIT;
