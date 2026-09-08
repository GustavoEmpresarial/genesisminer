-- Per-coin USD monthly distribution mode.
-- distribution_mode: 'legacy' (block_reward/block_time/network_hashrate) or
-- 'usd_month' (perpetual monthly USD budget split by real active hashrate every
-- 10-min boundary). distribution_usd_month is the $/month rate, not a pot.
-- IF NOT EXISTS keeps this safe to re-run and aligns fresh/dev DBs.
ALTER TABLE "mining_coins"
  ADD COLUMN IF NOT EXISTS "distribution_mode" varchar(16) NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS "distribution_usd_month" double precision NOT NULL DEFAULT 0;
