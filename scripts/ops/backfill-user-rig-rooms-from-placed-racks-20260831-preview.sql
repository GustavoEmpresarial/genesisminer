-- Preview: (user, room) com racks colocados mas sem posse em user_rig_rooms.
-- Causa: lista my-rig-rooms abre por hasRacksHere; place exige user_rig_rooms.

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
SELECT
  rr.room_id,
  r.name AS room_name,
  COUNT(*) AS missing_ownership_rows,
  SUM(rr.racks) AS racks_affected,
  SUM(
    GREATEST(
      0,
      LEAST(
        GREATEST(0, rr.racks - COALESCE(r.initial_capacity, 0)),
        GREATEST(0, COALESCE(r.max_capacity, 0) - COALESCE(r.initial_capacity, 0))
      )
    )
  ) AS unlocked_slots_to_set
FROM rack_rooms rr
JOIN rig_rooms r ON r.id = rr.room_id
LEFT JOIN user_rig_rooms urr ON urr.user_id = rr.user_id AND urr.room_id = rr.room_id
WHERE urr.user_id IS NULL
GROUP BY rr.room_id, r.name
ORDER BY missing_ownership_rows DESC;
