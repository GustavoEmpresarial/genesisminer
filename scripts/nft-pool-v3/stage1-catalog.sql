-- NFT Pool V3 — Estagio 1: aposentar os 4 tiers no catalogo.
-- Espelha exatamente o soft_retire_upgrade de rust/genesis-hardware/src/catalog/replace.rs
-- (status='retired', is_active=0, sell_in_hardware_market=0, sell_in_black_market=0) + bump da
-- revision (invalida cache do cliente). NAO mexe em base_cost/base_production/nft_mining_coin_id.
--
-- nft_pool_v3_comum e nft_pool_v3_mitico NAO sao tocados.
-- sync_nft_room_only_flags do replace.rs so SETA =1; GHO_nft continua referenciada por
-- comum + mitico + only_miner -> nft_room_only permanece 1, nada a fazer.
--
--   ./run.sh stage1-catalog.sql
\set ON_ERROR_STOP on
\timing on
BEGIN;

UPDATE upgrades
SET status='retired', is_active=0, sell_in_hardware_market=0, sell_in_black_market=0
WHERE id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
RETURNING id, status, is_active, sell_in_hardware_market, sell_in_black_market;

UPDATE upgrades_catalog_meta SET revision = revision + 1 WHERE id=1
RETURNING revision AS nova_revision;

\echo ''
\echo 'confira: comum + mitico intactos, ativos:'
SELECT id, name, status, is_active, base_cost, base_production AS hps, nft_mining_coin_id
FROM upgrades WHERE id IN ('nft_pool_v3_comum','nft_pool_v3_mitico') ORDER BY id;

COMMIT;
