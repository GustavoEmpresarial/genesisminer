-- Purge catalog placeholders `temp_legacy_*_rally_v3` from `upgrades`.
-- Applied AFTER stock already remapped to `gpu_rally_v1` (2026-09-16 remap).
-- Live check context: 196 catalog placeholders; 0 stock / item_instances refs.
-- Idempotent: re-run is no-op when rows already gone (guards still pass with 0 refs).
-- Parent applies on VM — do not run from local workspace without confirmation.
--
-- Apply:
--   psql ... -v ON_ERROR_STOP=1 -f scripts/ops/purge-temp-legacy-rally-v3-catalog-placeholders-20260917.sql

\set ON_ERROR_STOP on

BEGIN;

-- Preview counts (read-only snapshot inside txn)
SELECT
  (SELECT count(*)::bigint
     FROM upgrades
    WHERE id LIKE 'temp_legacy\_%\_rally_v3' ESCAPE '\') AS upgrades_placeholders,
  (SELECT count(*)::bigint
     FROM stock
    WHERE item_id LIKE 'temp_legacy\_%\_rally_v3' ESCAPE '\') AS stock_refs,
  (SELECT count(*)::bigint
     FROM item_instances
    WHERE catalog_item_id LIKE 'temp_legacy\_%\_rally_v3' ESCAPE '\') AS item_instances_refs;

DO $purge$
DECLARE
  v_stock bigint;
  v_ii bigint;
  v_upgrades bigint;
BEGIN
  SELECT count(*)::bigint INTO v_stock
  FROM stock
  WHERE item_id LIKE 'temp_legacy\_%\_rally_v3' ESCAPE '\';

  SELECT count(*)::bigint INTO v_ii
  FROM item_instances
  WHERE catalog_item_id LIKE 'temp_legacy\_%\_rally_v3' ESCAPE '\';

  IF v_stock <> 0 OR v_ii <> 0 THEN
    RAISE EXCEPTION
      'purge_temp_legacy_rally_v3: refused — stock=% item_instances=% (expected 0 before delete)',
      v_stock, v_ii;
  END IF;

  SELECT count(*)::bigint INTO v_upgrades
  FROM upgrades
  WHERE id LIKE 'temp_legacy\_%\_rally_v3' ESCAPE '\';

  RAISE NOTICE 'purge_temp_legacy_rally_v3: deleting % upgrades placeholders', v_upgrades;

  DELETE FROM upgrades
  WHERE id LIKE 'temp_legacy\_%\_rally_v3' ESCAPE '\';
END
$purge$;

-- Post-check (expect 0)
SELECT count(*)::bigint AS remaining_placeholders
FROM upgrades
WHERE id LIKE 'temp_legacy\_%\_rally_v3' ESCAPE '\';

COMMIT;
