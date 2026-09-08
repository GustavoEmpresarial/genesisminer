-- Migra as moedas ativas para distribution_mode='usd_month', semeando
-- distribution_usd_month com a emissão USD real dos últimos 30 dias
-- (mining_block_history.amount_usd). Só toca moedas com emissão > 0.
--
-- Os knobs legados (block_reward/block_time/network_hashrate) NÃO são alterados,
-- então o rollback é exato:
--   UPDATE mining_coins SET distribution_mode='legacy' WHERE id = '<id>';
--
-- Migrar 1 moeda por vez: adicione  AND c.id = :'coin_id'  e rode com -v coin_id=...
--
-- ATENÇÃO: NÃO re-rodar scripts/ops/fix-gho-nft-network-floor-20260831.sql contra
-- moedas em 'usd_month' — a coluna network_hashrate não é usada nesse modo (inócuo,
-- mas enganoso).
--
--   psql ... -v ON_ERROR_STOP=1 -f scripts/ops/distribution-usd-month-seed-20260908.sql

\set ON_ERROR_STOP on

BEGIN;

DO $seed$
DECLARE
  v_updated int;
BEGIN
  WITH real30 AS (
    SELECT h.coin_id, COALESCE(SUM(h.amount_usd), 0)::double precision AS usd_30d
    FROM mining_block_history h
    WHERE h.created_at > (extract(epoch from now())*1000 - 2592000000)::bigint
    GROUP BY h.coin_id
  )
  UPDATE mining_coins c
     SET distribution_usd_month = r.usd_30d,
         distribution_mode = 'usd_month'
    FROM real30 r
   WHERE r.coin_id = c.id
     AND c.is_active = 1
     AND r.usd_30d > 0;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'distribution-usd-month-seed: % moedas migradas para usd_month', v_updated;
END
$seed$;

SELECT id, symbol, distribution_mode, round(distribution_usd_month::numeric, 4) AS usd_month,
       round(price_usd::numeric, 6) AS price_usd
FROM mining_coins
WHERE is_active = 1 AND distribution_mode = 'usd_month'
ORDER BY distribution_usd_month DESC;

COMMIT;
