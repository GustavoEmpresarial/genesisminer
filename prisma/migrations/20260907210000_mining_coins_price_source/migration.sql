-- mining_coins price provenance (prod already carries these on some dumps;
-- IF NOT EXISTS keeps it safe to re-run and aligns fresh/dev DBs).
ALTER TABLE "mining_coins"
  ADD COLUMN IF NOT EXISTS "price_source" varchar(16) NOT NULL DEFAULT 'market',
  ADD COLUMN IF NOT EXISTS "price_updated_at" bigint,
  ADD COLUMN IF NOT EXISTS "spot_asset_id" varchar(64);
