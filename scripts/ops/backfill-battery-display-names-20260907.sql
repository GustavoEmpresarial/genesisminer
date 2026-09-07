-- Backfill: refresh denormalized battery display-name / image copies from the
-- upgrades catalog. One-time fix for drift accumulated before genesis-hardware
-- catalog replace started cascading these (catalog/replace.rs::sync_battery_display_copies).
--
-- Safe: only rewrites a display string / image path to match the catalog by id.
-- Idempotent — re-running is a no-op. Transactional.

\set ON_ERROR_STOP on

BEGIN;

WITH upd AS (
  UPDATE stored_batteries s
     SET display_name = u.name,
         image_url    = u.image
    FROM upgrades u
   WHERE u.id = s.item_id
     AND (
       s.display_name IS DISTINCT FROM u.name
       OR s.image_url IS DISTINCT FROM u.image
     )
  RETURNING 1
)
SELECT COUNT(*) AS stored_batteries_updated FROM upd;

WITH upd AS (
  UPDATE placed_racks p
     SET battery_display_name = u.name,
         battery_image_url    = u.image
    FROM upgrades u
   WHERE u.id = p.battery_catalog_item_id
     AND (
       p.battery_display_name IS DISTINCT FROM u.name
       OR p.battery_image_url IS DISTINCT FROM u.image
     )
  RETURNING 1
)
SELECT COUNT(*) AS placed_racks_updated FROM upd;

COMMIT;

\echo '== verify: 0 stale rows expected =='
SELECT
  (SELECT COUNT(*) FROM stored_batteries s JOIN upgrades u ON u.id = s.item_id
     WHERE s.display_name IS DISTINCT FROM u.name OR s.image_url IS DISTINCT FROM u.image) AS stored_batteries_stale,
  (SELECT COUNT(*) FROM placed_racks p JOIN upgrades u ON u.id = p.battery_catalog_item_id
     WHERE p.battery_display_name IS DISTINCT FROM u.name OR p.battery_image_url IS DISTINCT FROM u.image) AS placed_racks_stale;
