-- PREVIEW (read-only): propõe migrar cada moeda ativa para distribution_mode='usd_month'
-- semeando distribution_usd_month com a emissão real dos últimos 30 dias.
-- Mostra o drift entre o $/mês real e o $/mês implícito pela fórmula legada
-- (yield_per_hash * price_usd * 2_592_000 * network_hashrate da última linha de history).
--
--   psql ... -f scripts/ops/distribution-usd-month-seed-20260908-preview.sql
\pset pager off

WITH real30 AS (
  SELECT h.coin_id, COALESCE(SUM(h.amount_usd), 0)::numeric AS usd_30d, COUNT(*) AS credit_rows
  FROM mining_block_history h
  WHERE h.created_at > (extract(epoch from now())*1000 - 2592000000)::bigint
  GROUP BY h.coin_id
),
last_hist AS (
  SELECT DISTINCT ON (coin_id) coin_id, yield_per_hash, network_hashrate
  FROM mining_yield_history
  ORDER BY coin_id, effective_at DESC
)
SELECT c.id, c.symbol, c.is_active,
       c.distribution_mode AS mode_atual,
       round(c.price_usd::numeric, 6)                         AS price_usd,
       round(COALESCE(r.usd_30d, 0), 4)                       AS real_usd_30d,
       COALESCE(r.credit_rows, 0)                             AS credit_rows_30d,
       round((lh.yield_per_hash * c.price_usd * 2592000 * lh.network_hashrate)::numeric, 4)
                                                              AS formula_usd_mo_implicito,
       CASE WHEN COALESCE(r.usd_30d, 0) > 0
            THEN 'usd_month  <- seed ' || round(COALESCE(r.usd_30d, 0), 2)
            ELSE 'MANTER legacy (sem emissao 30d)' END        AS proposto
FROM mining_coins c
LEFT JOIN real30 r ON r.coin_id = c.id
LEFT JOIN last_hist lh ON lh.coin_id = c.id
WHERE c.is_active = 1
ORDER BY real_usd_30d DESC NULLS LAST, c.symbol;
