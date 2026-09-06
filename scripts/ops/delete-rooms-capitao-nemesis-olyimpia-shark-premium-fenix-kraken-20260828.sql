-- Empty + delete rooms (2026-08-28):
--   CAPITÃO, NÊMESIS, OLYIMPÍA, SHARK-TANK, PREMIUM, FÊNIX, KRAKEN
-- Sequence: lease-aware unequip → stock → delete racks → delete unlocks → delete catalog.
-- Idempotent after success (0 racks / rooms gone).
--
-- Apply on prod:
--   psql ... -v ON_ERROR_STOP=1 -f scripts/ops/delete-rooms-...sql

\set ON_ERROR_STOP on

BEGIN;

DO $del$
DECLARE
  c_ms_per_day constant bigint := 86400000;
  c_days_per_week constant int := 7;
  c_days_per_month_approx constant int := 30;
  c_days_per_year_approx constant int := 365;
  c_now_ms bigint;

  v_racks int;
  v_filled_slots int;
  v_timed_orphans int;
  v_minted int;
  v_leases_released int;
  v_pm_sync int;
  v_perm_stock int;
  v_hw_stock int;
  v_batteries_deleted int;
  v_unlocks int;
  v_rooms_deleted int;
BEGIN
  c_now_ms := (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint;

  CREATE TEMP TABLE _target_rooms ON COMMIT DROP AS
  SELECT unnest(ARRAY[
    'room_1770357231035', -- SALA DO CAPITÃO
    'room_1769496395562', -- SALA NÊMESIS
    'room_1777793913794', -- SALA OLYIMPÍA
    'room_1769540313738', -- SALA SHARK-TANK
    'room_1776448849400', -- SALA PREMIUM
    'room_1765936323521', -- SALA FÊNIX
    'room_1769540315156'  -- SALA KRAKEN
  ]) AS room_id;

  IF EXISTS (
    SELECT 1 FROM _target_rooms t
    WHERE NOT EXISTS (SELECT 1 FROM rig_rooms rr WHERE rr.id = t.room_id)
  ) THEN
    -- Allow partial re-run if some rooms already deleted; only fail if NONE left and racks remain orphaned.
    NULL;
  END IF;

  -- Guard: never touch ASIC / NFT rooms
  IF EXISTS (
    SELECT 1 FROM _target_rooms
    WHERE room_id IN ('room_1775484506874', 'room_1777158991085')
  ) THEN
    RAISE EXCEPTION 'delete_rooms: refused — ASIC/NFT room in target set';
  END IF;

  CREATE TEMP TABLE _racks ON COMMIT DROP AS
  SELECT
    pr.id AS rack_id,
    pr.user_id,
    NULLIF(btrim(pr.item_id), '') AS chassis_id,
    NULLIF(btrim(pr.wiring_id), '') AS wiring_id,
    NULLIF(btrim(pr.battery_id), '') AS battery_id,
    NULLIF(btrim(pr.battery_catalog_item_id), '') AS battery_catalog_item_id
  FROM placed_racks pr
  WHERE pr.room_id IN (SELECT room_id FROM _target_rooms);

  SELECT count(*)::int INTO v_racks FROM _racks;

  IF v_racks > 0 THEN
    -- ------------------------------------------------------------------
    -- Slots (lease-aware)
    -- ------------------------------------------------------------------
    CREATE TEMP TABLE _slots ON COMMIT DROP AS
    SELECT
      r.user_id,
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
    INNER JOIN _racks r ON r.rack_id = rs.rack_id
    LEFT JOIN upgrades u ON u.id = btrim(rs.machine_item_id)
    WHERE btrim(COALESCE(rs.machine_item_id, '')) <> '';

    SELECT count(*)::int INTO v_filled_slots FROM _slots;

    SELECT count(*)::int INTO v_timed_orphans
    FROM _slots WHERE is_timed AND machine_lease_id IS NULL;

    IF EXISTS (
      SELECT 1 FROM _slots
      WHERE is_timed AND machine_lease_id IS NULL AND (duration_ms IS NULL OR duration_ms <= 0)
    ) THEN
      RAISE EXCEPTION 'delete_rooms: timed orphan slot(s) with invalid catalog duration';
    END IF;

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

    UPDATE player_asic_leases pal
    SET status = 'stock', rack_id = NULL, slot_index = NULL
    WHERE pal.status = 'equipped'
      AND (
        pal.id IN (SELECT machine_lease_id FROM _slots WHERE machine_lease_id IS NOT NULL)
        OR pal.rack_id IN (SELECT rack_id FROM _racks)
      );

    GET DIAGNOSTICS v_leases_released = ROW_COUNT;

    UPDATE player_machines pm
    SET location = 'INVENTORY',
        rack_id = NULL,
        slot_index = NULL,
        version = pm.version + 1
    WHERE pm.location = 'EQUIPPED'
      AND pm.rack_id IN (SELECT rack_id FROM _racks);

    GET DIAGNOSTICS v_pm_sync = ROW_COUNT;

    INSERT INTO stock (user_id, item_id, qty)
    SELECT s.user_id, s.machine_item_id, count(*)::int
    FROM _slots s
    WHERE NOT s.is_timed
    GROUP BY s.user_id, s.machine_item_id
    ON CONFLICT (user_id, item_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty;

    GET DIAGNOSTICS v_perm_stock = ROW_COUNT;

    -- ------------------------------------------------------------------
    -- Hardware → stock
    -- ------------------------------------------------------------------
    CREATE TEMP TABLE _hw_credits (
      user_id int NOT NULL,
      item_id text NOT NULL,
      qty int NOT NULL,
      PRIMARY KEY (user_id, item_id)
    ) ON COMMIT DROP;

    INSERT INTO _hw_credits (user_id, item_id, qty)
    SELECT user_id, chassis_id, count(*)::int
    FROM _racks
    WHERE chassis_id IS NOT NULL
    GROUP BY user_id, chassis_id
    ON CONFLICT (user_id, item_id) DO UPDATE
      SET qty = _hw_credits.qty + EXCLUDED.qty;

    INSERT INTO _hw_credits (user_id, item_id, qty)
    SELECT user_id, wiring_id, count(*)::int
    FROM _racks
    WHERE wiring_id IS NOT NULL
    GROUP BY user_id, wiring_id
    ON CONFLICT (user_id, item_id) DO UPDATE
      SET qty = _hw_credits.qty + EXCLUDED.qty;

    INSERT INTO _hw_credits (user_id, item_id, qty)
    SELECT
      r.user_id,
      COALESCE(r.battery_catalog_item_id, NULLIF(btrim(sb.item_id), '')),
      count(*)::int
    FROM _racks r
    LEFT JOIN stored_batteries sb
      ON sb.id = r.battery_id AND sb.user_id = r.user_id
    WHERE COALESCE(r.battery_catalog_item_id, NULLIF(btrim(sb.item_id), '')) IS NOT NULL
    GROUP BY r.user_id, COALESCE(r.battery_catalog_item_id, NULLIF(btrim(sb.item_id), ''))
    ON CONFLICT (user_id, item_id) DO UPDATE
      SET qty = _hw_credits.qty + EXCLUDED.qty;

    INSERT INTO _hw_credits (user_id, item_id, qty)
    SELECT r.user_id, NULLIF(btrim(ms.multiplier_item_id), ''), count(*)::int
    FROM rack_multiplier_slots ms
    JOIN _racks r ON r.rack_id = ms.rack_id
    WHERE ms.multiplier_item_id IS NOT NULL
      AND btrim(ms.multiplier_item_id) <> ''
    GROUP BY r.user_id, NULLIF(btrim(ms.multiplier_item_id), '')
    ON CONFLICT (user_id, item_id) DO UPDATE
      SET qty = _hw_credits.qty + EXCLUDED.qty;

    DELETE FROM stored_batteries sb
    USING _racks r
    WHERE sb.id = r.battery_id
      AND sb.user_id = r.user_id
      AND r.battery_id IS NOT NULL;

    GET DIAGNOSTICS v_batteries_deleted = ROW_COUNT;

    INSERT INTO stock (user_id, item_id, qty)
    SELECT user_id, item_id, qty FROM _hw_credits
    ON CONFLICT (user_id, item_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty;

    GET DIAGNOSTICS v_hw_stock = ROW_COUNT;

    DELETE FROM rack_multiplier_slots WHERE rack_id IN (SELECT rack_id FROM _racks);
    DELETE FROM rack_slots WHERE rack_id IN (SELECT rack_id FROM _racks);
    DELETE FROM placed_racks WHERE id IN (SELECT rack_id FROM _racks);
  ELSE
    v_filled_slots := 0;
    v_timed_orphans := 0;
    v_minted := 0;
    v_leases_released := 0;
    v_pm_sync := 0;
    v_perm_stock := 0;
    v_hw_stock := 0;
    v_batteries_deleted := 0;
  END IF;

  -- ------------------------------------------------------------------
  -- Unlocks + catalog
  -- ------------------------------------------------------------------
  DELETE FROM user_rig_rooms
  WHERE room_id IN (SELECT room_id FROM _target_rooms);

  GET DIAGNOSTICS v_unlocks = ROW_COUNT;

  IF EXISTS (
    SELECT 1 FROM placed_racks
    WHERE room_id IN (SELECT room_id FROM _target_rooms)
  ) THEN
    RAISE EXCEPTION 'delete_rooms: placed_racks still reference target rooms';
  END IF;

  IF EXISTS (
    SELECT 1 FROM user_rig_rooms
    WHERE room_id IN (SELECT room_id FROM _target_rooms)
  ) THEN
    RAISE EXCEPTION 'delete_rooms: user_rig_rooms still reference target rooms';
  END IF;

  DELETE FROM rig_rooms
  WHERE id IN (SELECT room_id FROM _target_rooms);

  GET DIAGNOSTICS v_rooms_deleted = ROW_COUNT;

  RAISE NOTICE
    'delete_rooms: racks=% slots=% timed_orphans=% minted=% leases=% pm=% perm_stock_groups=% hw_stock_groups=% batteries_del=% unlocks=% rooms_deleted=%',
    v_racks, v_filled_slots, v_timed_orphans, v_minted, v_leases_released, v_pm_sync,
    v_perm_stock, v_hw_stock, v_batteries_deleted, v_unlocks, v_rooms_deleted;
END
$del$;

COMMIT;
