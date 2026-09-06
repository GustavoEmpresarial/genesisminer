-- PREVIEW only — no writes. Lists who exceeds max_capacity and what would return to inventory.
\set ON_ERROR_STOP on

\echo === summary: user-rooms over max_capacity ===
SELECT COUNT(*) AS overfilled_rooms,
       COUNT(DISTINCT user_id) AS users,
       SUM(placed_count - max_capacity) AS racks_to_recall,
       MAX(placed_count) AS max_placed
FROM (
  SELECT pr.user_id, pr.room_id, COUNT(*)::int AS placed_count, rr.max_capacity
  FROM placed_racks pr
  JOIN rig_rooms rr ON rr.id = pr.room_id
  GROUP BY pr.user_id, pr.room_id, rr.max_capacity
  HAVING COUNT(*) > rr.max_capacity
) t;

\echo === by room ===
SELECT rr.name, COUNT(*) AS overfilled, SUM(c.placed_count - c.max_capacity) AS excess_racks
FROM (
  SELECT pr.user_id, pr.room_id, COUNT(*)::int AS placed_count, rr.max_capacity
  FROM placed_racks pr
  JOIN rig_rooms rr ON rr.id = pr.room_id
  GROUP BY pr.user_id, pr.room_id, rr.max_capacity
  HAVING COUNT(*) > rr.max_capacity
) c
JOIN rig_rooms rr ON rr.id = c.room_id
GROUP BY rr.name
ORDER BY excess_racks DESC;

\echo === full offender list (user, room, placed, excess) ===
SELECT u.email, pr.user_id, rr.name AS room, COUNT(*)::int AS placed, rr.max_capacity,
       COUNT(*)::int - rr.max_capacity AS excess,
       COALESCE(urr.unlocked_slots, 0) AS unlocked_slots
FROM placed_racks pr
JOIN rig_rooms rr ON rr.id = pr.room_id
LEFT JOIN users u ON u.id = pr.user_id
LEFT JOIN user_rig_rooms urr ON urr.user_id = pr.user_id AND urr.room_id = pr.room_id
GROUP BY u.email, pr.user_id, rr.name, rr.max_capacity, urr.unlocked_slots
HAVING COUNT(*) > rr.max_capacity
ORDER BY excess DESC, u.email;

\echo === racks that WOULD be recalled (slot_index keep lowest max_capacity) ===
SELECT u.email, e.user_id, rr.name, e.slot_index, e.rack_id, e.chassis_id, e.wiring_id, e.battery_catalog_item_id
FROM (
  SELECT
    pr.id AS rack_id,
    pr.user_id,
    pr.room_id,
    pr.slot_index,
    pr.item_id AS chassis_id,
    pr.wiring_id,
    pr.battery_catalog_item_id,
    rr.max_capacity,
    ROW_NUMBER() OVER (
      PARTITION BY pr.user_id, pr.room_id
      ORDER BY pr.slot_index ASC NULLS LAST, pr.id ASC
    ) AS rn
  FROM placed_racks pr
  JOIN rig_rooms rr ON rr.id = pr.room_id
) e
JOIN users u ON u.id = e.user_id
JOIN rig_rooms rr ON rr.id = e.room_id
WHERE e.rn > e.max_capacity
ORDER BY e.user_id, e.room_id, e.slot_index DESC;

\echo === machines on those excess racks (timed vs permanent) ===
SELECT
  COUNT(*) FILTER (
    WHERE COALESCE(u.asic_duration_amount, 0) > 0
      AND NULLIF(btrim(COALESCE(u.asic_duration_unit, '')), '') IS NOT NULL
  ) AS timed_machines,
  COUNT(*) FILTER (
    WHERE NOT (
      COALESCE(u.asic_duration_amount, 0) > 0
      AND NULLIF(btrim(COALESCE(u.asic_duration_unit, '')), '') IS NOT NULL
    )
  ) AS permanent_machines
FROM rack_slots rs
JOIN (
  SELECT pr.id
  FROM (
    SELECT pr.id, pr.user_id, pr.room_id, rr.max_capacity,
      ROW_NUMBER() OVER (
        PARTITION BY pr.user_id, pr.room_id
        ORDER BY pr.slot_index ASC NULLS LAST, pr.id ASC
      ) AS rn
    FROM placed_racks pr
    JOIN rig_rooms rr ON rr.id = pr.room_id
  ) pr
  WHERE pr.rn > pr.max_capacity
) e ON e.id = rs.rack_id
LEFT JOIN upgrades u ON u.id = btrim(rs.machine_item_id)
WHERE btrim(COALESCE(rs.machine_item_id, '')) <> '';

\echo === unlocks that would be capped to purchasable max ===
SELECT COUNT(*) AS rows_to_cap, SUM(urr.unlocked_slots) AS sum_unlock_before
FROM user_rig_rooms urr
JOIN rig_rooms rr ON rr.id = urr.room_id
WHERE COALESCE(urr.unlocked_slots, 0) > GREATEST(rr.max_capacity - rr.initial_capacity, 0);
