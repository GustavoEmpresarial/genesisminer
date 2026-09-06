-- Harden mining_yield_history idempotency: at most one snapshot per (coin_id, effective_at).
-- Provider: PostgreSQL (see prisma/migrations/migration_lock.toml).
--
-- Dedupe strategy (deterministic, structural — NOT based on yield values):
-- keep the row with the smallest `id` (earliest insert) for each (coin_id, effective_at);
-- delete all other duplicates.
--
-- Diagnostic (run before apply in prod if desired):
--   SELECT coin_id, effective_at, COUNT(*) AS total
--   FROM mining_yield_history
--   GROUP BY coin_id, effective_at
--   HAVING COUNT(*) > 1;

DELETE FROM mining_yield_history AS d
WHERE d.id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY coin_id, effective_at
        ORDER BY id ASC
      ) AS rn
    FROM mining_yield_history
  ) ranked
  WHERE ranked.rn > 1
);

-- Replace non-unique composite index with UNIQUE (same columns).
DROP INDEX IF EXISTS "mining_yield_history_coin_effective_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "mining_yield_history_coin_effective_uidx"
  ON "mining_yield_history" ("coin_id", "effective_at");
