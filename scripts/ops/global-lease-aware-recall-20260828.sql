-- Global lease-aware recall: ALL placed rigs → inventory / lease stock.
-- NOT naive recall-all (never stock++ timed units that still have a lease row).
--
-- Semantics per slot machine:
--   • timed + lease_id  → lease status stock (no stock.qty++)
--   • timed + null lease → mint stock lease from catalog duration (no stock.qty++)
--   • permanent         → stock.qty += 1
-- Then: chassis / wiring / battery catalog / multipliers → stock; DELETE all placed_racks.
--
-- Idempotent only BEFORE run (empty placed_racks). Do not re-run after success.
--
-- Preview:
--   psql ... -f scripts/ops/global-lease-aware-recall-20260828-preview.sql
-- Apply:
--   psql ... -v ON_ERROR_STOP=1 -f scripts/ops/global-lease-aware-recall-20260828.sql

\set ON_ERROR_STOP on

BEGIN;

DO $recall$
DECLARE
  c_ms_per_day constant bigint := 86400000;
  c_days_per_week constant int := 7;
  c_days_per_month_approx constant int := 30;
  c_days_per_year_approx constant int := 365;
  c_now_ms bigint;

  v_filled_slots int;
  v_timed_orphans int;
  v_minted int;
  v_leases_released int;
  v_perm_stock int;
  v_pm_sync int;
  v_racks int;
  v_hw_stock int;
BEGIN
  c_now_ms := (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint;

  -- ------------------------------------------------------------------
  -- 1) All filled machine slots
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
  INNER JOIN placed_racks pr ON pr.id = rs.rack_id
  LEFT JOIN upgrades u ON u.id = btrim(rs.machine_item_id)
  WHERE btrim(COALESCE(rs.machine_item_id, '')) <> '';

  SELECT count(*)::int INTO v_filled_slots FROM _slots;

  SELECT count(*)::int INTO v_timed_orphans
  FROM _slots WHERE is_timed AND machine_lease_id IS NULL;

  IF EXISTS (SELECT 1 FROM _slots WHERE is_timed AND machine_lease_id IS NULL AND (duration_ms IS NULL OR duration_ms <= 0)) THEN
    RAISE EXCEPTION 'global_recall: timed orphan slot(s) with invalid catalog duration';
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
  WHERE rs.rack_id = m.rack_id
    AND rs.slot_index = m.slot_index;

  UPDATE _slots s
  SET machine_lease_id = m.lease_id
  FROM _minted m
  WHERE s.rack_id = m.rack_id AND s.slot_index = m.slot_index;

  -- ------------------------------------------------------------------
  -- 3) Release ALL equipped leases (slot-bound or listed on _slots)
  -- ------------------------------------------------------------------
  UPDATE player_asic_leases pal
  SET status = 'stock', rack_id = NULL, slot_index = NULL
  WHERE pal.status = 'equipped'
    AND (
      pal.id IN (SELECT machine_lease_id FROM _slots WHERE machine_lease_id IS NOT NULL)
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
  WHERE pm.location = 'EQUIPPED';

  GET DIAGNOSTICS v_pm_sync = ROW_COUNT;

  -- ------------------------------------------------------------------
  -- 4) Permanent machines (no timed catalog) → stock.qty++
  -- ------------------------------------------------------------------
  INSERT INTO stock (user_id, item_id, qty)
  SELECT s.user_id, s.machine_item_id, count(*)::int
  FROM _slots s
  WHERE NOT s.is_timed
  GROUP BY s.user_id, s.machine_item_id
  ON CONFLICT (user_id, item_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty;

  GET DIAGNOSTICS v_perm_stock = ROW_COUNT;

  -- ------------------------------------------------------------------
  -- 5) Clear all slot machines
  -- ------------------------------------------------------------------
  UPDATE rack_slots
  SET machine_item_id = NULL, machine_lease_id = NULL
  WHERE btrim(COALESCE(machine_item_id, '')) <> ''
     OR machine_lease_id IS NOT NULL;

  -- ------------------------------------------------------------------
  -- 6) Rack hardware → stock (chassis, wiring, battery catalog, multipliers)
  -- ------------------------------------------------------------------
  CREATE TEMP TABLE _hw_credits (
    user_id int NOT NULL,
    item_id text NOT NULL,
    qty int NOT NULL,
    PRIMARY KEY (user_id, item_id)
  ) ON COMMIT DROP;

  INSERT INTO _hw_credits (user_id, item_id, qty)
  SELECT user_id, btrim(item_id), count(*)::int
  FROM placed_racks
  WHERE btrim(COALESCE(item_id, '')) <> ''
  GROUP BY user_id, btrim(item_id)
  ON CONFLICT (user_id, item_id) DO UPDATE
    SET qty = _hw_credits.qty + EXCLUDED.qty;

  INSERT INTO _hw_credits (user_id, item_id, qty)
  SELECT user_id, btrim(wiring_id), count(*)::int
  FROM placed_racks
  WHERE btrim(COALESCE(wiring_id, '')) <> ''
  GROUP BY user_id, btrim(wiring_id)
  ON CONFLICT (user_id, item_id) DO UPDATE
    SET qty = _hw_credits.qty + EXCLUDED.qty;

  INSERT INTO _hw_credits (user_id, item_id, qty)
  SELECT user_id, btrim(battery_catalog_item_id), count(*)::int
  FROM placed_racks
  WHERE btrim(COALESCE(battery_catalog_item_id, '')) <> ''
  GROUP BY user_id, btrim(battery_catalog_item_id)
  ON CONFLICT (user_id, item_id) DO UPDATE
    SET qty = _hw_credits.qty + EXCLUDED.qty;

  INSERT INTO _hw_credits (user_id, item_id, qty)
  SELECT pr.user_id, btrim(rms.multiplier_item_id), count(*)::int
  FROM rack_multiplier_slots rms
  INNER JOIN placed_racks pr ON pr.id = rms.rack_id
  WHERE btrim(COALESCE(rms.multiplier_item_id, '')) <> ''
  GROUP BY pr.user_id, btrim(rms.multiplier_item_id)
  ON CONFLICT (user_id, item_id) DO UPDATE
    SET qty = _hw_credits.qty + EXCLUDED.qty;

  INSERT INTO stock (user_id, item_id, qty)
  SELECT user_id, item_id, qty FROM _hw_credits
  ON CONFLICT (user_id, item_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty;

  GET DIAGNOSTICS v_hw_stock = ROW_COUNT;

  SELECT count(*)::int INTO v_racks FROM placed_racks;

  -- ------------------------------------------------------------------
  -- 7) Remove all installations
  -- ------------------------------------------------------------------
  DELETE FROM rack_slots WHERE rack_id IN (SELECT id FROM placed_racks);
  DELETE FROM rack_multiplier_slots WHERE rack_id IN (SELECT id FROM placed_racks);
  DELETE FROM placed_racks;

  RAISE NOTICE
    'global_lease_aware_recall: filled_slots=% timed_orphans=% minted=% leases_released=% pm_inv=% perm_stock_groups=% hw_stock_groups=% racks_removed=%',
    v_filled_slots, v_timed_orphans, v_minted, v_leases_released, v_pm_sync, v_perm_stock, v_hw_stock, v_racks;
END
$recall$;

COMMIT;
