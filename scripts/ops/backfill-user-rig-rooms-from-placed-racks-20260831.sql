-- Backfill: cria user_rig_rooms para (user, room) com racks já colocados
-- mas sem linha de posse. Corrige "sala aparece / place rejeita purchase access".
-- Idempotente (ON CONFLICT DO NOTHING).

BEGIN;

WITH rack_rooms AS (
  SELECT
    user_id,
    CASE
      WHEN room_id IS NULL OR BTRIM(COALESCE(room_id, '')) = '' OR BTRIM(room_id) = 'main'
        THEN 'room_initial'
      ELSE BTRIM(room_id)
    END AS room_id,
    COUNT(*)::int AS racks
  FROM placed_racks
  GROUP BY 1, 2
),
to_insert AS (
  SELECT
    rr.user_id,
    rr.room_id,
    GREATEST(
      0,
      LEAST(
        GREATEST(0, rr.racks - COALESCE(r.initial_capacity, 0)),
        GREATEST(0, COALESCE(r.max_capacity, 0) - COALESCE(r.initial_capacity, 0))
      )
    )::int AS unlocked_slots
  FROM rack_rooms rr
  JOIN rig_rooms r ON r.id = rr.room_id
  LEFT JOIN user_rig_rooms urr ON urr.user_id = rr.user_id AND urr.room_id = rr.room_id
  WHERE urr.user_id IS NULL
)
INSERT INTO user_rig_rooms (user_id, room_id, purchased_at, unlocked_slots)
SELECT user_id, room_id, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, unlocked_slots
FROM to_insert
ON CONFLICT (user_id, room_id) DO NOTHING;

-- Verificação: gaps restantes devem ser 0
WITH rack_rooms AS (
  SELECT
    user_id,
    CASE
      WHEN room_id IS NULL OR BTRIM(COALESCE(room_id, '')) = '' OR BTRIM(room_id) = 'main'
        THEN 'room_initial'
      ELSE BTRIM(room_id)
    END AS room_id,
    COUNT(*)::int AS racks
  FROM placed_racks
  GROUP BY 1, 2
)
SELECT COUNT(*) AS remaining_gaps
FROM rack_rooms rr
JOIN rig_rooms r ON r.id = rr.room_id
LEFT JOIN user_rig_rooms urr ON urr.user_id = rr.user_id AND urr.room_id = rr.room_id
WHERE urr.user_id IS NULL;

COMMIT;
