-- NFT: H/s da máquina = preço em USD.
-- Para todo item com id `nft_*`, base_production := base_cost.
-- Não toca no motor de mineração (ele continua lendo base_production).
-- Ativas alteradas: nft_hodl_bitcoin (1→100), nft_baleuidos (0,17→150),
-- nft_pool_v3_mitico (2→200). nft_pool_v3_comum e nft_only_miner já batem.
-- 4 Pool V3 aposentados (sem dono) também são alinhados por higiene.
--
-- Rollback:
--   UPDATE upgrades u SET base_production = b.base_production
--   FROM upgrades_bak_nfths_20260908 b WHERE b.id = u.id;
--
--   psql ... -v ON_ERROR_STOP=1 -f scripts/ops/nft-hs-equals-price-20260908.sql
\set ON_ERROR_STOP on
\timing on
BEGIN;

DROP TABLE IF EXISTS upgrades_bak_nfths_20260908;
CREATE TABLE upgrades_bak_nfths_20260908 AS
  SELECT id, base_production, base_cost FROM upgrades WHERE id LIKE 'nft_%';

UPDATE upgrades u
   SET base_production = u.base_cost
  FROM upgrades_bak_nfths_20260908 b
 WHERE b.id = u.id
   AND u.base_production IS DISTINCT FROM u.base_cost
RETURNING u.id, b.base_production AS hs_antigo, u.base_production AS hs_novo, u.is_active;

-- invalida o cache de catálogo do cliente
UPDATE upgrades_catalog_meta SET revision = revision + 1 WHERE id = 1
RETURNING revision AS nova_revision;

\echo ''
\echo 'conferencia final (todos nft_* devem ter base_production = base_cost):'
SELECT id, base_cost, base_production, (base_cost = base_production) AS ok
FROM upgrades WHERE id LIKE 'nft_%' ORDER BY base_cost, id;

COMMIT;
