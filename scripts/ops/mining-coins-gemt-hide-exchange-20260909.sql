-- Tira GEMT do desk de câmbio (show_in_exchange=0).
-- Pedido 2026-09-09: "tira o token gent" — na BD só existe symbol GEMT
-- (id 37f540dc-c29a-496a-a043-056677220cf3). Sem moeda GENT.
-- Liquidate API também rejeita pares com show_in_exchange=0.
\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS mining_coins_bak_gemt_hide_exchange_20260909 AS
  SELECT id, symbol, show_in_exchange FROM mining_coins
   WHERE id = '37f540dc-c29a-496a-a043-056677220cf3'
      OR UPPER(TRIM(symbol)) IN ('GEMT', 'GENT');
UPDATE mining_coins
   SET show_in_exchange = 0
 WHERE (id = '37f540dc-c29a-496a-a043-056677220cf3'
     OR UPPER(TRIM(symbol)) IN ('GEMT', 'GENT'))
   AND COALESCE(show_in_exchange, 0) <> 0
 RETURNING id, symbol, show_in_exchange;
COMMIT;
-- rollback:
-- UPDATE mining_coins m SET show_in_exchange = b.show_in_exchange
--   FROM mining_coins_bak_gemt_hide_exchange_20260909 b WHERE b.id = m.id;
