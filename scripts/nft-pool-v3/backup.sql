-- NFT Pool V3 consolidation — snapshot de rollback. Rodar ANTES do Estagio 1 (catalogo).
-- Cria tabelas *_bak_nftv3 com o estado atual das 4 tabelas autoritativas + catalogo + moedas.
-- Idempotente: dropa e recria.
\set ON_ERROR_STOP on
\timing on

DROP TABLE IF EXISTS player_asic_leases_bak_nftv3;
DROP TABLE IF EXISTS item_instances_bak_nftv3;
DROP TABLE IF EXISTS stock_bak_nftv3;
DROP TABLE IF EXISTS rack_slots_bak_nftv3;
DROP TABLE IF EXISTS player_machines_bak_nftv3;
DROP TABLE IF EXISTS player_listings_bak_nftv3;
DROP TABLE IF EXISTS upgrades_bak_nftv3;
DROP TABLE IF EXISTS mining_coins_bak_nftv3;

CREATE TABLE player_asic_leases_bak_nftv3 AS
  SELECT * FROM player_asic_leases WHERE item_id LIKE 'nft_pool_v3_%';
CREATE TABLE item_instances_bak_nftv3 AS
  SELECT * FROM item_instances WHERE catalog_item_id LIKE 'nft_pool_v3_%';
CREATE TABLE stock_bak_nftv3 AS
  SELECT * FROM stock WHERE item_id LIKE 'nft_pool_v3_%';
-- rack_slots: guardamos os que apontam p/ QUALQUER pool_v3 (equipados) por rack/slot
CREATE TABLE rack_slots_bak_nftv3 AS
  SELECT rs.* FROM rack_slots rs WHERE rs.machine_item_id LIKE 'nft_pool_v3_%';
CREATE TABLE player_machines_bak_nftv3 AS
  SELECT * FROM player_machines WHERE catalog_item_id LIKE 'nft_pool_v3_%';
CREATE TABLE player_listings_bak_nftv3 AS
  SELECT * FROM player_listings WHERE item_id LIKE 'nft_pool_v3_%';
CREATE TABLE upgrades_bak_nftv3 AS
  SELECT * FROM upgrades WHERE id LIKE 'nft_pool_v3_%';
CREATE TABLE mining_coins_bak_nftv3 AS
  SELECT * FROM mining_coins
   WHERE id IN ('6529d347-d3dd-4dc8-b15f-3a4d318a301f','62224072-4f9e-44e1-8f4a-73e541944aef');

SELECT 'player_asic_leases' AS tbl, count(*) FROM player_asic_leases_bak_nftv3
UNION ALL SELECT 'item_instances', count(*) FROM item_instances_bak_nftv3
UNION ALL SELECT 'stock', count(*) FROM stock_bak_nftv3
UNION ALL SELECT 'rack_slots', count(*) FROM rack_slots_bak_nftv3
UNION ALL SELECT 'player_machines', count(*) FROM player_machines_bak_nftv3
UNION ALL SELECT 'player_listings', count(*) FROM player_listings_bak_nftv3
UNION ALL SELECT 'upgrades', count(*) FROM upgrades_bak_nftv3
UNION ALL SELECT 'mining_coins', count(*) FROM mining_coins_bak_nftv3
ORDER BY 1;
