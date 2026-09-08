-- Rótulo interna/externa por moeda (admin). Não altera mecânica de mineração.
-- Seed: usdc_interno = interna (é a única moeda de saldo F2P/Gênesis conhecida).
ALTER TABLE "mining_coins"
  ADD COLUMN IF NOT EXISTS "is_internal" integer NOT NULL DEFAULT 0;

UPDATE "mining_coins" SET "is_internal" = 1
 WHERE id = 'usdc_interno' OR upper(btrim(symbol)) = 'USDC_INT';
