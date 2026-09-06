-- Cap excess placed racks to rig_rooms.max_capacity (product hard cap, typically 18).
-- Excess racks (highest slot_index first kept? NO — keep LOWEST slot_index, recall the rest)
-- are lease-aware returned to inventory (same semantics as global-lease-aware-recall).
-- Also clamps user_rig_rooms.unlocked_slots so initial+unlocked cannot exceed max.
--
-- Preview:
--   psql ... -f scripts/ops/cap-room-overfill-to-max-20260831-preview.sql
-- Apply:
--   psql ... -v ON_ERROR_STOP=1 -f scripts/ops/cap-room-overfill-to-max-20260831.sql
--
-- Idempotent: second run finds 0 excess racks.

\set ON_ERROR_STOP on

BEGIN;

DO $cap$
DECLARE
  c_ms_per_day constant bigint := 86400000;
  c_days_per_week constant int := 7;
  c_days_per_month_approx constant int := 30;
  c_days_per_year_approx constant int := 365;
  c_now_ms bigint;

  v_excess_racks int;
  v_filled_slots int;
  v_timed_orphans int;
  v_minted int;
  v_leases_released int;
  v_pm_sync int;
  v_perm_stock int;
  v_hw_stock int;
  v_unlocks_capped int;
  v_users_bumped int;
BEGIN
  c_now_ms := (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint;

  -- ------------------------------------------------------------------
  -- 0) Excess racks: rn > max_capacity (keep lowest slot_index)
  -- ------------------------------------------------------------------
  CREATE TEMP TABLE _excess_racks ON COMMIT DROP AS
  SELECT ranked.id AS rack_id, ranked.user_id, ranked.room_id, ranked.slot_index,
         ranked.item_id, ranked.wiring_id, ranked.battery_id, ranked.battery_catalog_item_id,
         ranked.max_capacity, ranked.placed_total, ranked.rn
  FROM (
    SELECT
      pr.id,
      pr.user_id,
      pr.room_id,
      pr.slot_index,
      pr.item_id,
      pr.wiring_id,
      pr.battery_id,
      pr.battery_catalog_item_id,
      rr.max_capacity,
      COUNT(*) OVER (PARTITION BY pr.user_id, pr.room_id) AS placed_total,
      ROW_NUMBER() OVER (
        PARTITION BY pr.user_id, pr.room_id
        ORDER BY pr.slot_index ASC NULLS LAST, pr.id ASC
      ) AS rn
    FROM placed_racks pr
    INNER JOIN rig_rooms rr ON rr.id = pr.room_id
  ) ranked
  WHERE ranked.rn > ranked.max_capacity;

  SELECT count(*)::int INTO v_excess_racks FROM _excess_racks;

  RAISE NOTICE 'cap_overfill: excess_racks=%', v_excess_racks;

  IF v_excess_racks > 0 THEN
    -- Report table (session) for operators
    CREATE TEMP TABLE _cap_overfill_report ON COMMIT PRESERVE ROWS AS
    SELECT
      e.user_id,
      u.email,
      e.room_id,
      rr.name AS room_name,
      e.max_capacity,
      e.placed_total,
      e.placed_total - e.max_capacity AS excess_count,
      e.rack_id,
      e.slot_index,
      e.item_id AS chassis_id,
      e.wiring_id,
      e.battery_catalog_item_id
    FROM _excess_racks e
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN rig_rooms rr ON rr.id = e.room_id
    ORDER BY e.placed_total DESC, e.user_id, e.room_id, e.slot_index DESC;

    -- ------------------------------------------------------------------
    -- 1) Filled machine slots on excess racks only
    -- ------------------------------------------------------------------
    CREATE TEMP TABLE _slots ON COMMIT DROP AS
    SELECT
      pr.user_id,
      rs.rack_id,
      rs.slot_index,
      btrim(rs.machine_item_id) AS machine_item_id,
      rs.machine_lease_id,
      CASE
        WHEN COALESCE(u.asic_duration_amount, 0) > 0
         AND NULLIF(btrim(COALESCE(u.asic_duration_unit, '')), '') IS NOT NULL
        THEN true
        ELSE false
      END AS is_timed,
      CASE lower(btrim(COALESCE(u.asic_duration_unit, '')))
        WHEN 'day' THEN (u.asic_duration_amount::bigint * c_ms_per_day)
        WHEN 'week' THEN (u.asic_duration_amount::bigint * c_days_per_week * c_ms_per_day)
        WHEN 'month' THEN (u.asic_duration_amount::bigint * c_days_per_month_approx * c_ms_per_day)
        WHEN 'year' THEN (u.asic_duration_amount::bigint * c_days_per_year_approx * c_ms_per_day)
        ELSE NULL
      END AS duration_ms
    FROM rack_slots rs
    INNER JOIN _excess_racks pr ON pr.rack_id = rs.rack_id
    LEFT JOIN upgrades u ON u.id = btrim(rs.machine_item_id)
    WHERE btrim(COALESCE(rs.machine_item_id, '')) <> '';

    SELECT count(*)::int INTO v_filled_slots FROM _slots;

    SELECT count(*)::int INTO v_timed_orphans
    FROM _slots WHERE is_timed AND machine_lease_id IS NULL;

    IF EXISTS (
      SELECT 1 FROM _slots
      WHERE is_timed AND machine_lease_id IS NULL AND (duration_ms IS NULL OR duration_ms <= 0)
    ) THEN
      RAISE EXCEPTION 'cap_overfill: timed orphan slot(s) with invalid catalog duration';
    END IF;

    -- ------------------------------------------------------------------
    -- 2) Mint stock leases for timed orphans (never stock.qty++ timed)
    -- ------------------------------------------------------------------
    CREATE TEMP TABLE _minted ON COMMIT DROP AS
    SELECT
      gen_random_uuid() AS lease_id,
      s.user_id,
      s.rack_id,
      s.slot_index,
      s.machine_item_id AS item_id,
      c_now_ms AS acquired_at,
      c_now_ms + s.duration_ms AS expires_at
    FROM _slots s
    WHERE s.is_timed AND s.machine_lease_id IS NULL;

    INSERT INTO player_asic_leases (id, user_id, item_id, acquired_at, expires_at, status, rack_id, slot_index)
    SELECT lease_id, user_id, item_id, acquired_at, expires_at, 'stock', NULL, NULL
    FROM _minted;

    GET DIAGNOSTICS v_minted = ROW_COUNT;

    INSERT INTO player_machines (
      id, user_id, catalog_item_id, location, rack_id, slot_index,
      version, expires_at, acquired_at, legacy_lease_id
    )
    SELECT
      m.lease_id, m.user_id, m.item_id, 'INVENTORY', NULL, NULL,
      1, m.expires_at, m.acquired_at, m.lease_id
    FROM _minted m;

    UPDATE rack_slots rs
    SET machine_lease_id = m.lease_id
    FROM _minted m
    WHERE rs.rack_id = m.rack_id AND rs.slot_index = m.slot_index;

    UPDATE _slots s
    SET machine_lease_id = m.lease_id
    FROM _minted m
    WHERE s.rack_id = m.rack_id AND s.slot_index = m.slot_index;

    -- ------------------------------------------------------------------
    -- 3) Release equipped leases bound to excess racks / listed slots
    -- ------------------------------------------------------------------
    UPDATE player_asic_leases pal
    SET status = 'stock', rack_id = NULL, slot_index = NULL
    WHERE pal.status = 'equipped'
      AND (
        pal.id IN (SELECT machine_lease_id FROM _slots WHERE machine_lease_id IS NOT NULL)
        OR pal.rack_id IN (SELECT rack_id FROM _excess_racks)
        OR EXISTS (
          SELECT 1 FROM _slots s
          WHERE s.rack_id = pal.rack_id AND s.slot_index = pal.slot_index
        )
      );

    GET DIAGNOSTICS v_leases_released = ROW_COUNT;

    UPDATE player_machines pm
    SET location = 'INVENTORY',
        rack_id = NULL,
        slot_index = NULL,
        version = pm.version + 1
    WHERE pm.location = 'EQUIPPED'
      AND pm.rack_id IN (SELECT rack_id FROM _excess_racks);

    GET DIAGNOSTICS v_pm_sync = ROW_COUNT;

    -- ------------------------------------------------------------------
    -- 4) Permanent machines → stock.qty++
    -- ------------------------------------------------------------------
    INSERT INTO stock (user_id, item_id, qty)
    SELECT s.user_id, s.machine_item_id, count(*)::int
    FROM _slots s
    WHERE NOT s.is_timed
    GROUP BY s.user_id, s.machine_item_id
    ON CONFLICT (user_id, item_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty;

    GET DIAGNOSTICS v_perm_stock = ROW_COUNT;

    -- Clear machines on excess rack slots (before delete)
    UPDATE rack_slots rs
    SET machine_item_id = NULL, machine_lease_id = NULL
    WHERE rs.rack_id IN (SELECT rack_id FROM _excess_racks)
      AND (btrim(COALESCE(rs.machine_item_id, '')) <> '' OR rs.machine_lease_id IS NOT NULL);

    -- ------------------------------------------------------------------
    -- 5) Chassis / wiring / battery catalog / multipliers → stock
    -- ------------------------------------------------------------------
    CREATE TEMP TABLE _hw_credits (
      user_id int NOT NULL,
      item_id text NOT NULL,
      qty int NOT NULL,
      PRIMARY KEY (user_id, item_id)
    ) ON COMMIT DROP;

    INSERT INTO _hw_credits (user_id, item_id, qty)
    SELECT user_id, btrim(item_id), count(*)::int
    FROM _excess_racks
    WHERE btrim(COALESCE(item_id, '')) <> ''
    GROUP BY user_id, btrim(item_id)
    ON CONFLICT (user_id, item_id) DO UPDATE
      SET qty = _hw_credits.qty + EXCLUDED.qty;

    INSERT INTO _hw_credits (user_id, item_id, qty)
    SELECT user_id, btrim(wiring_id), count(*)::int
    FROM _excess_racks
    WHERE btrim(COALESCE(wiring_id, '')) <> ''
    GROUP BY user_id, btrim(wiring_id)
    ON CONFLICT (user_id, item_id) DO UPDATE
      SET qty = _hw_credits.qty + EXCLUDED.qty;

    INSERT INTO _hw_credits (user_id, item_id, qty)
    SELECT user_id, btrim(battery_catalog_item_id), count(*)::int
    FROM _excess_racks
    WHERE btrim(COALESCE(battery_catalog_item_id, '')) <> ''
    GROUP BY user_id, btrim(battery_catalog_item_id)
    ON CONFLICT (user_id, item_id) DO UPDATE
      SET qty = _hw_credits.qty + EXCLUDED.qty;

    INSERT INTO _hw_credits (user_id, item_id, qty)
    SELECT e.user_id, btrim(rms.multiplier_item_id), count(*)::int
    FROM rack_multiplier_slots rms
    INNER JOIN _excess_racks e ON e.rack_id = rms.rack_id
    WHERE btrim(COALESCE(rms.multiplier_item_id, '')) <> ''
    GROUP BY e.user_id, btrim(rms.multiplier_item_id)
    ON CONFLICT (user_id, item_id) DO UPDATE
      SET qty = _hw_credits.qty + EXCLUDED.qty;

    INSERT INTO stock (user_id, item_id, qty)
    SELECT user_id, item_id, qty FROM _hw_credits
    ON CONFLICT (user_id, item_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty;

    GET DIAGNOSTICS v_hw_stock = ROW_COUNT;

    -- ------------------------------------------------------------------
    -- 6) Delete excess installations
    -- ------------------------------------------------------------------
    DELETE FROM rack_slots WHERE rack_id IN (SELECT rack_id FROM _excess_racks);
    DELETE FROM rack_multiplier_slots WHERE rack_id IN (SELECT rack_id FROM _excess_racks);
    DELETE FROM placed_racks WHERE id IN (SELECT rack_id FROM _excess_racks);
  ELSE
    v_filled_slots := 0;
    v_timed_orphans := 0;
    v_minted := 0;
    v_leases_released := 0;
    v_pm_sync := 0;
    v_perm_stock := 0;
    v_hw_stock := 0;
  END IF;

  -- ------------------------------------------------------------------
  -- 7) Cap unlocked_slots so initial+unlocked <= max (typically → 0)
  -- ------------------------------------------------------------------
  CREATE TEMP TABLE _unlock_cap_users ON COMMIT DROP AS
  SELECT DISTINCT urr.user_id
  FROM user_rig_rooms urr
  JOIN rig_rooms rr ON rr.id = urr.room_id
  WHERE COALESCE(urr.unlocked_slots, 0) > GREATEST(rr.max_capacity - rr.initial_capacity, 0);

  UPDATE user_rig_rooms urr
  SET unlocked_slots = GREATEST(
    0,
    LEAST(
      COALESCE(urr.unlocked_slots, 0),
      GREATEST(rr.max_capacity - rr.initial_capacity, 0)
    )
  )
  FROM rig_rooms rr
  WHERE rr.id = urr.room_id
    AND COALESCE(urr.unlocked_slots, 0) > GREATEST(rr.max_capacity - rr.initial_capacity, 0);

  GET DIAGNOSTICS v_unlocks_capped = ROW_COUNT;

  -- Force client reload for anyone who lost excess racks and/or unlocks
  UPDATE game_states gs
  SET inventory_version = COALESCE(gs.inventory_version, 0) + 1,
      server_updated_at = c_now_ms,
      last_updated_at = c_now_ms
  WHERE gs.user_id IN (
    SELECT user_id FROM _excess_racks
    UNION
    SELECT user_id FROM _unlock_cap_users
  );

  GET DIAGNOSTICS v_users_bumped = ROW_COUNT;

  RAISE NOTICE
    'cap_overfill_done: excess_racks=% filled_slots=% timed_orphans=% minted=% leases_released=% pm_inv=% perm_stock_groups=% hw_stock_groups=% unlocks_capped=% users_bumped=%',
    v_excess_racks, v_filled_slots, v_timed_orphans, v_minted, v_leases_released, v_pm_sync, v_perm_stock, v_hw_stock, v_unlocks_capped, v_users_bumped;
END
$cap$;

COMMIT;

-- Post-checks
SELECT 'overfill_remaining' AS check, COUNT(*)::int AS n
FROM (
  SELECT pr.user_id, pr.room_id, COUNT(*)::int AS c, rr.max_capacity
  FROM placed_racks pr
  JOIN rig_rooms rr ON rr.id = pr.room_id
  GROUP BY pr.user_id, pr.room_id, rr.max_capacity
  HAVING COUNT(*) > rr.max_capacity
) t;

SELECT 'unlocks_over_purchasable' AS check, COUNT(*)::int AS n
FROM user_rig_rooms urr
JOIN rig_rooms rr ON rr.id = urr.room_id
WHERE COALESCE(urr.unlocked_slots, 0) > GREATEST(rr.max_capacity - rr.initial_capacity, 0);

SELECT 'placed_gt_18' AS check, COUNT(*)::int AS n
FROM (
  SELECT user_id, room_id FROM placed_racks GROUP BY user_id, room_id HAVING COUNT(*) > 18
) t;
