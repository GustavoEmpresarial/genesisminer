-- Heal: materializa stored_batteries em falta para UUID montados em placed_racks.
-- Idempotente (ON CONFLICT DO NOTHING). Não inventa catalog quando battery_catalog_item_id é NULL.
-- Uso (prod): psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/heal-orphan-mounted-batteries.sql
-- NÃO apaga stock. NÃO muda modelo stock-only do inventário jogável.

BEGIN;

-- mapping pré-heal (orphans por catalog)
SELECT pr.battery_catalog_item_id AS item_id, COUNT(*) AS orphan_count
FROM placed_racks pr
WHERE pr.battery_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM stored_batteries sb WHERE sb.id = pr.battery_id)
GROUP BY 1
ORDER BY 2 DESC;

INSERT INTO stored_batteries (
  id, user_id, item_id, display_name, image_url,
  status, location, rack_id, slot_id, room_id,
  version, last_moved_at, updated_at
)
SELECT
  pr.battery_id,
  pr.user_id,
  btrim(pr.battery_catalog_item_id),
  NULLIF(btrim(COALESCE(pr.battery_display_name, '')), ''),
  NULLIF(btrim(COALESCE(pr.battery_image_url, '')), ''),
  'EQUIPPED',
  'RACK',
  pr.id,
  COALESCE(pr.slot_index, 0),
  COALESCE(NULLIF(btrim(COALESCE(pr.room_id::text, '')), ''), 'room_initial'),
  0,
  NOW(),
  NOW()
FROM placed_racks pr
WHERE pr.battery_id IS NOT NULL
  AND btrim(pr.battery_id::text) <> ''
  AND pr.battery_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND pr.battery_catalog_item_id IS NOT NULL
  AND btrim(pr.battery_catalog_item_id) <> ''
  AND NOT EXISTS (SELECT 1 FROM stored_batteries sb WHERE sb.id = pr.battery_id)
ON CONFLICT (id) DO NOTHING;

-- pós-heal orphans remaining (deve ser só NULL catalog / sem catalog válido)
SELECT COUNT(*) AS orphans_remaining
FROM placed_racks pr
WHERE pr.battery_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND NOT EXISTS (SELECT 1 FROM stored_batteries sb WHERE sb.id = pr.battery_id);

COMMIT;
