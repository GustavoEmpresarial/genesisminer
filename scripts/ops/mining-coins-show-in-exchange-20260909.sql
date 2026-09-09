-- Todas as moedas ativas passam a aparecer na carteira (Exchange filtra por
-- show_in_exchange). Report: BNB/GEMT/WBTC/XRP sumindo da carteira; o split
-- estava inconsistente (USDT off / USDT_nft on, DAI on / DAI-nft off).
-- APLICADO em prod 2026-09-09.
\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS mining_coins_bak_showx_20260909 AS
  SELECT id, symbol, show_in_exchange FROM mining_coins;
UPDATE mining_coins SET show_in_exchange = 1
 WHERE is_active = 1 AND COALESCE(show_in_exchange,0) <> 1
 RETURNING id, symbol;
COMMIT;
-- rollback: UPDATE mining_coins m SET show_in_exchange = b.show_in_exchange
--             FROM mining_coins_bak_showx_20260909 b WHERE b.id = m.id;
