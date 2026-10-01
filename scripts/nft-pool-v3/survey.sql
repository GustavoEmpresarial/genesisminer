-- NFT Pool V3 consolidation — LEVANTAMENTO (read-only).
--   ./run.sh survey.sql -v phase=initial   (ou phase=final)
-- Nada aqui escreve. Compare out/survey-initial.txt x out/survey-final.txt.

\pset pager off
-- exige: -v phase=initial  (ou final). Sem isso o psql aborta abaixo.
\if :{?phase}
\else
  \echo 'ERRO: rode com  -v phase=initial  (ou  -v phase=final)'
  \q
\endif

\echo ''
\echo '################################################################'
\echo '#  NFT POOL V3 — LEVANTAMENTO   phase =' :phase
\echo '################################################################'
SELECT now() AS run_at, current_database() AS db;

\echo ''
\echo '==== [1] CATALOGO (upgrades LIKE nft_pool_v3_%) ===================='
SELECT id, name, base_cost, base_production AS hps, (base_cost/10)::int AS mult,
       max_global_stock, total_sold, status, is_active,
       sell_in_hardware_market AS sell_hw, sell_in_black_market AS sell_bm,
       nft_mining_coin_id, rarity, rack_room_affinity, merge_enabled
FROM upgrades WHERE id LIKE 'nft_pool_v3_%' ORDER BY base_cost, id;

SELECT revision AS catalog_revision FROM upgrades_catalog_meta;

\echo ''
\echo '==== [2] TIERS APOSENTADOS — contagem por tabela autoritativa ======'
\echo '     (incomum x1, raro x2, epico x4, lendario x10)'
WITH ids(id,mult) AS (VALUES
  ('nft_pool_v3_incomum',1),('nft_pool_v3_raro',2),('nft_pool_v3_epico',4),('nft_pool_v3_lendario',10))
SELECT i.id, i.mult,
 (SELECT count(*) FROM player_asic_leases l WHERE l.item_id=i.id AND l.status='stock')     AS lease_stock,
 (SELECT count(*) FROM player_asic_leases l WHERE l.item_id=i.id AND l.status='equipped')  AS lease_equip,
 (SELECT count(*) FROM player_asic_leases l WHERE l.item_id=i.id AND l.status NOT IN ('stock','equipped')) AS lease_term,
 (SELECT count(*) FROM item_instances ii WHERE ii.catalog_item_id=i.id AND ii.status='stock')    AS ii_stock,
 (SELECT count(*) FROM item_instances ii WHERE ii.catalog_item_id=i.id AND ii.status='equipped') AS ii_equip,
 (SELECT count(*) FROM item_instances ii WHERE ii.catalog_item_id=i.id AND ii.status NOT IN ('stock','equipped')) AS ii_term,
 (SELECT coalesce(sum(qty),0) FROM stock s WHERE s.item_id=i.id)                            AS stock_qty,
 (SELECT count(*) FROM rack_slots rs WHERE rs.machine_item_id=i.id)                         AS rack_slots,
 (SELECT count(*) FROM player_listings pl WHERE pl.item_id=i.id)                            AS p2p_listings,
 (SELECT count(*) FROM player_machines pm WHERE pm.catalog_item_id=i.id AND pm.location<>'DESTROYED') AS pm_alive
FROM ids i ORDER BY i.mult;

\echo ''
\echo '==== [3] SOBREVIVENTE nft_pool_v3_comum — contagem por tabela ======'
SELECT
 (SELECT count(*) FROM player_asic_leases WHERE item_id='nft_pool_v3_comum' AND status='stock')    AS lease_stock,
 (SELECT count(*) FROM player_asic_leases WHERE item_id='nft_pool_v3_comum' AND status='equipped') AS lease_equip,
 (SELECT count(*) FROM item_instances WHERE catalog_item_id='nft_pool_v3_comum' AND status='stock')    AS ii_stock,
 (SELECT count(*) FROM item_instances WHERE catalog_item_id='nft_pool_v3_comum' AND status='equipped') AS ii_equip,
 (SELECT coalesce(sum(qty),0) FROM stock WHERE item_id='nft_pool_v3_comum')                        AS stock_qty,
 (SELECT count(*) FROM rack_slots WHERE machine_item_id='nft_pool_v3_comum')                       AS rack_slots,
 (SELECT count(DISTINCT user_id) FROM player_asic_leases WHERE item_id='nft_pool_v3_comum')        AS holders;

\echo ''
\echo '==== [4] RECONCILIACAO (PASS/FAIL) ================================'
\echo '     R-eq : leases(equipped) == rack_slots == item_instances(equipped)   [por tier]'
\echo '     R-loose : leases(stock)  == item_instances(stock) == SUM(stock.qty)  [por tier]'
WITH ids(id) AS (VALUES ('nft_pool_v3_incomum'),('nft_pool_v3_raro'),('nft_pool_v3_epico'),
                        ('nft_pool_v3_lendario'),('nft_pool_v3_comum'))
SELECT i.id,
  (SELECT count(*) FROM player_asic_leases WHERE item_id=i.id AND status='equipped') AS le,
  (SELECT count(*) FROM rack_slots WHERE machine_item_id=i.id)                        AS rs,
  (SELECT count(*) FROM item_instances WHERE catalog_item_id=i.id AND status='equipped') AS iie,
  CASE WHEN (SELECT count(*) FROM player_asic_leases WHERE item_id=i.id AND status='equipped')
          = (SELECT count(*) FROM rack_slots WHERE machine_item_id=i.id)
       AND (SELECT count(*) FROM player_asic_leases WHERE item_id=i.id AND status='equipped')
          = (SELECT count(*) FROM item_instances WHERE catalog_item_id=i.id AND status='equipped')
       THEN 'PASS' ELSE 'FAIL' END AS r_eq,
  (SELECT count(*) FROM player_asic_leases WHERE item_id=i.id AND status='stock')     AS ls,
  (SELECT count(*) FROM item_instances WHERE catalog_item_id=i.id AND status='stock') AS iis,
  (SELECT coalesce(sum(qty),0) FROM stock WHERE item_id=i.id)                          AS sq,
  CASE WHEN (SELECT count(*) FROM player_asic_leases WHERE item_id=i.id AND status='stock')
          = (SELECT count(*) FROM item_instances WHERE catalog_item_id=i.id AND status='stock')
       AND (SELECT count(*) FROM player_asic_leases WHERE item_id=i.id AND status='stock')
          = (SELECT coalesce(sum(qty),0) FROM stock WHERE item_id=i.id)
       THEN 'PASS' ELSE 'FAIL' END AS r_loose
FROM ids i ORDER BY i.id;

\echo ''
\echo '     R-room : todo rack_slots dos 4 tiers na sala NFT room_1777158991085 (0 linhas = PASS)'
SELECT rs.machine_item_id, pr.room_id, count(*)
FROM rack_slots rs JOIN placed_racks pr ON pr.id=rs.rack_id
WHERE rs.machine_item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
  AND pr.room_id IS DISTINCT FROM 'room_1777158991085'
GROUP BY 1,2;

\echo ''
\echo '     R-p2p : zero listagem P2P dos 4 tiers (0 linhas = PASS)'
SELECT item_id, count(*) FROM player_listings
WHERE item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
GROUP BY 1;

\echo ''
\echo '==== [5] POR USUARIO — leases (stock+equipped) por tier + esperado comum +N ='
WITH ids(id,mult) AS (VALUES
  ('nft_pool_v3_incomum',1),('nft_pool_v3_raro',2),('nft_pool_v3_epico',4),('nft_pool_v3_lendario',10)),
per AS (
  SELECT l.user_id, i.id, i.mult, count(*) AS n
  FROM player_asic_leases l JOIN ids i ON i.id=l.item_id
  WHERE l.status IN ('stock','equipped') GROUP BY 1,2,3)
SELECT user_id,
  sum(CASE WHEN id='nft_pool_v3_incomum'  THEN n END) AS incomum,
  sum(CASE WHEN id='nft_pool_v3_raro'     THEN n END) AS raro,
  sum(CASE WHEN id='nft_pool_v3_epico'    THEN n END) AS epico,
  sum(CASE WHEN id='nft_pool_v3_lendario' THEN n END) AS lendario,
  sum(n*mult) AS comum_esperado_delta,
  (SELECT coalesce(sum(qty),0) FROM stock s WHERE s.user_id=per.user_id AND s.item_id='nft_pool_v3_comum')
    + (SELECT count(*) FROM player_asic_leases l2 WHERE l2.user_id=per.user_id AND l2.item_id='nft_pool_v3_comum' AND l2.status='equipped')
    AS comum_atual_total
FROM per GROUP BY user_id ORDER BY user_id;

WITH ids(id,mult) AS (VALUES
  ('nft_pool_v3_incomum',1),('nft_pool_v3_raro',2),('nft_pool_v3_epico',4),('nft_pool_v3_lendario',10))
SELECT count(DISTINCT l.user_id) AS usuarios_afetados,
       sum((SELECT mult FROM ids WHERE id=l.item_id)) AS comum_total_a_cunhar
FROM player_asic_leases l
WHERE l.item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
  AND l.status IN ('stock','equipped');

\echo ''
\echo '==== [6] MOEDAS GHO_nft + DAI ===================================='
SELECT id, symbol, round(price_usd::numeric,6) AS price, block_reward, block_time, network_hashrate,
       nft_room_only, is_active
FROM mining_coins WHERE id IN ('6529d347-d3dd-4dc8-b15f-3a4d318a301f','62224072-4f9e-44e1-8f4a-73e541944aef');

\echo ''
\echo '==== [7] Quem paga GHO_nft (deve seguir nft_room_only pos-mudanca) ='
SELECT id, name, is_active, base_production AS hps FROM upgrades
WHERE nft_mining_coin_id='6529d347-d3dd-4dc8-b15f-3a4d318a301f' ORDER BY id;

\echo ''
\echo '==== [8] M MEDIDO — rendimento GHO_nft ==========================='
\echo '     (a) fluxo pela formula: 1 unidade comum (10 H/s)'
SELECT c.block_reward, c.block_time, c.network_hashrate, round(c.price_usd::numeric,6) AS price,
       round((10 * (c.block_reward / c.block_time) / GREATEST(c.network_hashrate,1))::numeric, 12) AS gho_por_seg,
       round((10 * (c.block_reward / c.block_time) / GREATEST(c.network_hashrate,1) * 2592000 * c.price_usd)::numeric, 4) AS usd_por_mes_formula,
       round((10 * (c.block_reward / c.block_time) / GREATEST(c.network_hashrate,1) * 2592000 * c.price_usd / 10 * 100)::numeric, 2) AS pct_mes_formula
FROM mining_coins c WHERE c.id='6529d347-d3dd-4dc8-b15f-3a4d318a301f';

\echo '     (b) empirico: emissao GHO_nft nos ultimos 30d (mining_block_history) e por unidade equipada'
SELECT
  round(sum(h.amount_coins)::numeric,4)                 AS gho_emitido_30d,
  round(sum(h.amount_usd)::numeric,4)                   AS usd_emitido_30d,
  count(DISTINCT h.user_id)                             AS usuarios,
  (SELECT count(*) FROM rack_slots WHERE machine_item_id LIKE 'nft_pool_v3%')  AS unidades_equipadas_poolv3,
  round((sum(h.amount_usd) / NULLIF((SELECT sum(u.base_production) FROM rack_slots rs
        JOIN upgrades u ON u.id=rs.machine_item_id WHERE u.nft_mining_coin_id='6529d347-d3dd-4dc8-b15f-3a4d318a301f'),0))::numeric, 6)
        AS usd_30d_por_Hps_equipado
FROM mining_block_history h
WHERE h.coin_id='6529d347-d3dd-4dc8-b15f-3a4d318a301f'
  AND h.created_at > (extract(epoch from now())*1000 - 2592000000);

\echo '     >> M (%/mes de um item $10/10H/s) ~= usd_30d_por_Hps_equipado * 10 / 10 * 100'
\echo '     >> se M ~ 2 -> block_reward 0.1->0.2 (k=2). Senao k = alvo(4.17)/M.'

\echo ''
\echo '==== [9] MARCADOR de migracao ==================================='
SELECT to_regclass('public.nft_pool_v3_migrations') AS marker_table;
DO $m$
BEGIN
  IF to_regclass('public.nft_pool_v3_migrations') IS NULL THEN
    RAISE NOTICE 'sem tabela de marcador -> migracao NAO aplicada';
  ELSE
    PERFORM 1;
    RAISE NOTICE 'marcadores: %', (SELECT string_agg(key || ' @ ' || applied_at, ', ') FROM nft_pool_v3_migrations);
  END IF;
END $m$;

\echo ''
\echo '==== FIM ================================================'
