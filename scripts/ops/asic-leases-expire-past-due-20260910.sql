-- Expira leases ASIC já vencidas que ainda estão status=equipped (e stock/listed).
-- Espelha soft-expire de rust/genesis-hardware/src/leases.rs: limpa rack_slots +
-- marca expired + zera rack_id/slot_index. Pedido 2026-09-10.
\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS player_asic_leases_bak_expire_past_20260910 AS
  SELECT id, user_id, item_id, status, rack_id, slot_index, expires_at, acquired_at
    FROM player_asic_leases
   WHERE expires_at <= (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
     AND status IN ('stock', 'equipped', 'listed');

-- Limpa slots que ainda apontam para essas leases
UPDATE rack_slots rs
   SET machine_item_id = NULL,
       machine_lease_id = NULL
 WHERE rs.machine_lease_id IN (
   SELECT id FROM player_asic_leases_bak_expire_past_20260910
 );

-- Marca leases como expired e desequipa
UPDATE player_asic_leases l
   SET status = 'expired',
       rack_id = NULL,
       slot_index = NULL
 WHERE l.id IN (SELECT id FROM player_asic_leases_bak_expire_past_20260910)
   AND l.status IN ('stock', 'equipped', 'listed');

-- Alinha item_instances se existir linha com o mesmo UUID
UPDATE item_instances ii
   SET status = 'expired',
       rack_id = NULL,
       slot_index = NULL
 WHERE ii.id IN (SELECT id FROM player_asic_leases_bak_expire_past_20260910);

COMMIT;
-- rollback (parcial — repor status/rack das leases; slots precisam re-equip manual):
-- UPDATE player_asic_leases l SET status=b.status, rack_id=b.rack_id, slot_index=b.slot_index
--   FROM player_asic_leases_bak_expire_past_20260910 b WHERE b.id = l.id;
