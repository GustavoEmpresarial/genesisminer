-- NFT Pool V3 consolidation — VERIFICACAO pos-migracao (read-only). Roda depois do apply.
-- Compara vivo x *_bak_nftv3. Tudo PASS = ok.
\pset pager off
\echo ''
\echo '==== V0 marcador aplicado ===='
SELECT key, applied_at, meta FROM nft_pool_v3_migrations WHERE key='nft_pool_v3_consolidation_v1';

\echo ''
\echo '==== V1 catalogo: 4 tiers retired/inativos, comum + mitico intactos ===='
SELECT id, status, is_active, sell_in_hardware_market AS sell_hw, sell_in_black_market AS sell_bm,
       base_cost, base_production AS hps, nft_mining_coin_id
FROM upgrades WHERE id LIKE 'nft_pool_v3_%' ORDER BY base_cost, id;
SELECT CASE WHEN count(*)=4 THEN 'PASS' ELSE 'FAIL' END AS four_tiers_retired
FROM upgrades
WHERE id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
  AND status='retired' AND is_active=0 AND sell_in_hardware_market=0 AND sell_in_black_market=0;

\echo ''
\echo '==== V2 nenhuma linha VIVA dos 4 tiers (tudo 0 = PASS) ===='
SELECT 'leases_vivas' AS o, count(*) AS n FROM player_asic_leases
  WHERE item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
    AND status IN ('stock','equipped')
UNION ALL SELECT 'instances_nao_consumed', count(*) FROM item_instances
  WHERE catalog_item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
    AND status <> 'consumed'
UNION ALL SELECT 'stock_rows', count(*) FROM stock
  WHERE item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
UNION ALL SELECT 'rack_slots', count(*) FROM rack_slots
  WHERE machine_item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
UNION ALL SELECT 'player_machines_nao_destroyed', count(*) FROM player_machines
  WHERE catalog_item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
    AND location <> 'DESTROYED';

\echo ''
\echo '==== V3 por usuario: delta comum == esperado (bak x vivo) ===='
WITH ids(id,mult) AS (VALUES
  ('nft_pool_v3_incomum',1),('nft_pool_v3_raro',2),('nft_pool_v3_epico',4),('nft_pool_v3_lendario',10)),
esperado AS (
  SELECT b.user_id, sum((SELECT mult FROM ids WHERE id=b.item_id))::int AS d
  FROM player_asic_leases_bak_nftv3 b
  WHERE b.item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
    AND b.status IN ('stock','equipped')
  GROUP BY b.user_id),
antes AS (SELECT user_id, count(*) FILTER (WHERE status IN ('stock','equipped')) n
          FROM player_asic_leases_bak_nftv3 WHERE item_id='nft_pool_v3_comum' GROUP BY user_id),
depois AS (SELECT user_id, count(*) FILTER (WHERE status IN ('stock','equipped')) n
           FROM player_asic_leases WHERE item_id='nft_pool_v3_comum' GROUP BY user_id)
SELECT e.user_id, COALESCE(a.n,0) AS antes, COALESCE(d.n,0) AS depois,
       COALESCE(d.n,0)-COALESCE(a.n,0) AS delta, e.d AS esperado,
       CASE WHEN COALESCE(d.n,0)-COALESCE(a.n,0)=e.d THEN 'PASS' ELSE 'FAIL' END AS ok
FROM esperado e LEFT JOIN antes a ON a.user_id=e.user_id LEFT JOIN depois d ON d.user_id=e.user_id
ORDER BY e.user_id;

SELECT CASE WHEN bool_and(match) THEN 'PASS — todos os usuarios batem' ELSE 'FAIL — ha usuario fora' END AS v3_geral
FROM (
  WITH ids(id,mult) AS (VALUES ('nft_pool_v3_incomum',1),('nft_pool_v3_raro',2),('nft_pool_v3_epico',4),('nft_pool_v3_lendario',10)),
  esperado AS (SELECT b.user_id, sum((SELECT mult FROM ids WHERE id=b.item_id))::int AS d
               FROM player_asic_leases_bak_nftv3 b
               WHERE b.item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
                 AND b.status IN ('stock','equipped') GROUP BY b.user_id),
  antes AS (SELECT user_id, count(*) FILTER (WHERE status IN ('stock','equipped')) n FROM player_asic_leases_bak_nftv3 WHERE item_id='nft_pool_v3_comum' GROUP BY user_id),
  depois AS (SELECT user_id, count(*) FILTER (WHERE status IN ('stock','equipped')) n FROM player_asic_leases WHERE item_id='nft_pool_v3_comum' GROUP BY user_id)
  SELECT (COALESCE(d.n,0)-COALESCE(a.n,0)) = e.d AS match
  FROM esperado e LEFT JOIN antes a ON a.user_id=e.user_id LEFT JOIN depois d ON d.user_id=e.user_id
) q;

\echo ''
\echo '==== V4 consistencia comum: stock.qty == leases(stock) == instances(stock) por usuario ===='
SELECT CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL (' || count(*) || ' usuarios divergem)' END AS v4
FROM (
  SELECT u.user_id
  FROM (SELECT DISTINCT user_id FROM player_asic_leases WHERE item_id='nft_pool_v3_comum') u
  LEFT JOIN LATERAL (SELECT coalesce(sum(qty),0) q FROM stock WHERE user_id=u.user_id AND item_id='nft_pool_v3_comum') s ON true
  LEFT JOIN LATERAL (SELECT count(*) c FROM player_asic_leases WHERE user_id=u.user_id AND item_id='nft_pool_v3_comum' AND status='stock') l ON true
  LEFT JOIN LATERAL (SELECT count(*) c FROM item_instances WHERE user_id=u.user_id AND catalog_item_id='nft_pool_v3_comum' AND status='stock') i ON true
  WHERE s.q <> l.c OR l.c <> i.c
) bad;

\echo ''
\echo '==== V5 total global ===='
SELECT
  (SELECT count(*) FROM player_asic_leases WHERE item_id='nft_pool_v3_comum' AND status IN ('stock','equipped')) AS comum_leases_vivas,
  (SELECT count(*) FROM player_asic_leases_bak_nftv3 WHERE item_id='nft_pool_v3_comum' AND status IN ('stock','equipped')) AS comum_leases_antes,
  (SELECT count(*) FROM nft_pool_v3_mint_map) AS unidades_cunhadas,
  (SELECT coalesce(sum(qty),0) FROM stock WHERE item_id='nft_pool_v3_comum') AS comum_stock_total;

\echo ''
\echo '==== V6 GHO_nft block_reward (esperado 0.2 apos Estagio 3) ===='
SELECT id, symbol, block_reward, block_time, network_hashrate FROM mining_coins
WHERE id='6529d347-d3dd-4dc8-b15f-3a4d318a301f';
