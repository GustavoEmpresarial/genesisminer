-- Gate C: Sala ASICs + Sala NFTs → fixed capacity 18/18.
-- Stock migration 20260827350000 only updates WHERE initial=max=12;
-- on this DB those rooms are 12/40 and 12/18 → would update 0 rows.
-- This apply is id-scoped for the same product intent.

BEGIN;

UPDATE rig_rooms
SET initial_capacity = 18, max_capacity = 18
WHERE id IN ('room_1775484506874', 'room_1777158991085')
  AND (initial_capacity IS DISTINCT FROM 18 OR max_capacity IS DISTINCT FROM 18);

INSERT INTO _prisma_migrations (
  id, checksum, finished_at, migration_name, started_at, applied_steps_count, logs
)
SELECT
  gen_random_uuid()::text,
  'd90395a881641acbaae2213a6947e387de97b9fd54a36eafc768f80e5086f0a7',
  NOW(),
  '20260827350000_rig_rooms_capacity_18',
  NOW(),
  1,
  'Applied id-scoped UPDATE (ASIC+NFT → 18/18). Stock WHERE initial=max=12 matched 0 rows.'
WHERE NOT EXISTS (
  SELECT 1 FROM _prisma_migrations
  WHERE migration_name = '20260827350000_rig_rooms_capacity_18'
);

COMMIT;

SELECT id, name, initial_capacity, max_capacity, allowed_levels
FROM rig_rooms
WHERE id IN ('room_1775484506874', 'room_1777158991085');

SELECT value AS site_maintenance FROM settings WHERE key = 'site_maintenance';
