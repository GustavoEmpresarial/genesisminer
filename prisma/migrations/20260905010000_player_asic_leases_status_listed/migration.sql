-- P2P list marks timed NFT/ASIC leases `listed` (same id as item_instances).
-- Prod CHECK was stock|equipped|expired only → publish failed with status_check.
-- Values = rust `ASIC_LEASE_STATUS_*` / Prisma comment on player_asic_leases.status.

ALTER TABLE "player_asic_leases" DROP CONSTRAINT IF EXISTS "player_asic_leases_status_check";

ALTER TABLE "player_asic_leases" ADD CONSTRAINT "player_asic_leases_status_check"
  CHECK (status = ANY (ARRAY['stock'::text, 'equipped'::text, 'expired'::text, 'listed'::text]));
