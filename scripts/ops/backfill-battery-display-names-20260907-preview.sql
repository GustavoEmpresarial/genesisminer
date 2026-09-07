-- PREVIEW (read-only): battery display-name / image drift vs catalog.
--
-- stored_batteries.display_name / image_url and
-- placed_racks.battery_display_name / battery_image_url are denormalized copies
-- of upgrades.name / upgrades.image, snapshotted when the battery instance was
-- created. A catalog rename never touched them. This shows how many rows are
-- stale (would be fixed by the backfill).

\echo '== stored_batteries: rows whose display_name differs from catalog =='
SELECT COUNT(*) AS stale_name
FROM stored_batteries s
JOIN upgrades u ON u.id = s.item_id
WHERE s.display_name IS DISTINCT FROM u.name;

\echo '== stored_batteries: rows whose image_url differs from catalog =='
SELECT COUNT(*) AS stale_image
FROM stored_batteries s
JOIN upgrades u ON u.id = s.item_id
WHERE s.image_url IS DISTINCT FROM u.image;

\echo '== placed_racks (mounted batteries): battery_display_name differs =='
SELECT COUNT(*) AS stale_name
FROM placed_racks p
JOIN upgrades u ON u.id = p.battery_catalog_item_id
WHERE p.battery_display_name IS DISTINCT FROM u.name;

\echo '== placed_racks (mounted batteries): battery_image_url differs =='
SELECT COUNT(*) AS stale_image
FROM placed_racks p
JOIN upgrades u ON u.id = p.battery_catalog_item_id
WHERE p.battery_image_url IS DISTINCT FROM u.image;

\echo '== sample of stale stored_batteries (old vs catalog), max 25 =='
SELECT s.item_id,
       s.display_name AS old_name,
       u.name        AS catalog_name,
       COUNT(*)      AS instances
FROM stored_batteries s
JOIN upgrades u ON u.id = s.item_id
WHERE s.display_name IS DISTINCT FROM u.name
GROUP BY s.item_id, s.display_name, u.name
ORDER BY instances DESC
LIMIT 25;
