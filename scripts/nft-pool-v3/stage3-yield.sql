-- NFT Pool V3 — Estagio 3: dobrar o rendimento da GHO_nft.
-- Decisao do usuario: fica GHO_nft (nao DAI). Alvo ~4-5%/mes (descricao do item: "200% em 4 anos").
--
-- k = fator. Default k=2 (block_reward 0.1 -> 0.2). Ajuste -v k=<n> pelo M medido no survey [8]:
--   M ~ 2%/mes  -> k=2      (0.20)
--   M ~ 3.4%/mes-> k=1.3    (0.13)  <- valor empirico medido em 2026-09-08
--   regra geral:   k = 4.5 / M
--
--   ./run.sh stage3-yield.sql              (k=2)
--   ./run.sh stage3-yield.sql -v k=1.3
\set ON_ERROR_STOP on
\if :{?k}
\else
  \set k 2
\endif
\echo 'aplicando k =' :k ' -> GHO_nft.block_reward = 0.1 * k'

UPDATE mining_coins
SET block_reward = round((0.1 * :k)::numeric, 6)
WHERE id = '6529d347-d3dd-4dc8-b15f-3a4d318a301f'
RETURNING id, symbol, block_reward, block_time, network_hashrate;

-- NAO mexer em network_hashrate. NAO re-rodar scripts/ops/fix-gho-nft-network-floor-*.sql (ver README).
