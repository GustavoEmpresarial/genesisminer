-- Reativa usdc_interno (+ POL) no desk de exchange.
-- Causa: show_in_exchange=0 em prod após o script all-active de 2026-09-09
-- (bak tinha 1; alguém voltou a desligar). Sem isto a UI some o par USDC
-- interno e liquidate API rejeita com "not available on the exchange desk".
-- GEMT (id UUID, symbol GEMT) já estava show_in_exchange=1 — sem GENT na BD.
\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS mining_coins_bak_usdc_interno_sx_20260909 AS
  SELECT id, symbol, show_in_exchange FROM mining_coins
   WHERE id IN ('usdc_interno', 'coin_1765301021089');
UPDATE mining_coins
   SET show_in_exchange = 1
 WHERE id IN ('usdc_interno', 'coin_1765301021089')
   AND is_active = 1
   AND COALESCE(show_in_exchange, 0) <> 1
 RETURNING id, symbol, show_in_exchange;
COMMIT;
-- rollback:
-- UPDATE mining_coins m SET show_in_exchange = b.show_in_exchange
--   FROM mining_coins_bak_usdc_interno_sx_20260909 b WHERE b.id = m.id;
