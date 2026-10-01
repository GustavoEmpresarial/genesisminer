-- Reabre o desk de câmbio para todas as moedas ativas, exceto GEMT/GENT.
-- Pedido 2026-09-10: só o token GEMT (chamado "GENT") fica fora do exchange.
\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS mining_coins_bak_desk_except_gemt_20260910 AS
  SELECT id, symbol, show_in_exchange FROM mining_coins;

-- Liga desk em tudo ativo que não seja GEMT/GENT
UPDATE mining_coins
   SET show_in_exchange = 1
 WHERE is_active = 1
   AND UPPER(TRIM(symbol)) NOT IN ('GEMT', 'GENT')
   AND id <> '37f540dc-c29a-496a-a043-056677220cf3'
   AND COALESCE(show_in_exchange, 0) <> 1
 RETURNING id, symbol, show_in_exchange;

-- Garante GEMT/GENT fora do desk
UPDATE mining_coins
   SET show_in_exchange = 0
 WHERE (
     id = '37f540dc-c29a-496a-a043-056677220cf3'
     OR UPPER(TRIM(symbol)) IN ('GEMT', 'GENT')
   )
   AND COALESCE(show_in_exchange, 0) <> 0
 RETURNING id, symbol, show_in_exchange;

COMMIT;
-- rollback:
-- UPDATE mining_coins m SET show_in_exchange = b.show_in_exchange
--   FROM mining_coins_bak_desk_except_gemt_20260910 b WHERE b.id = m.id;
