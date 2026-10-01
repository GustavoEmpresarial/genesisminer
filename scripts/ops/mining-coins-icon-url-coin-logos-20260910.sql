-- Seed mining_coins.icon_url → logos locais `/img/coin-logos/<slug>.png` (IMG_DIR=media-seed).
-- Pedido 2026-09-10: wallet/GameTopNav deixarem de cair em badge letra quando CDN falha.
\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS mining_coins_bak_icon_url_20260910 AS
  SELECT id, symbol, name, icon_url FROM mining_coins;

-- BNB
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/bnb.png'
 WHERE UPPER(TRIM(symbol)) = 'BNB'
 RETURNING id, symbol, icon_url;

-- DAI_NFT
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/dai.png'
 WHERE UPPER(TRIM(symbol)) = 'DAI_NFT'
 RETURNING id, symbol, icon_url;

-- DOGE
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/doge.png'
 WHERE UPPER(TRIM(symbol)) = 'DOGE'
 RETURNING id, symbol, icon_url;

-- ETH
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/eth.png'
 WHERE UPPER(TRIM(symbol)) = 'ETH'
 RETURNING id, symbol, icon_url;

-- GEMT
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/gemt.png'
 WHERE UPPER(TRIM(symbol)) = 'GEMT'
 RETURNING id, symbol, icon_url;

-- GHO_NFT
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/gho.png'
 WHERE UPPER(TRIM(symbol)) = 'GHO_NFT'
 RETURNING id, symbol, icon_url;

-- POL
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/pol.png'
 WHERE UPPER(TRIM(symbol)) = 'POL'
 RETURNING id, symbol, icon_url;

-- SHIB (name SHIBAINU)
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/shib.png'
 WHERE UPPER(TRIM(symbol)) = 'SHIB'
    OR UPPER(TRIM(name)) = 'SHIBAINU'
 RETURNING id, symbol, name, icon_url;

-- SOL
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/sol.png'
 WHERE UPPER(TRIM(symbol)) = 'SOL'
 RETURNING id, symbol, icon_url;

-- TRX
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/trx.png'
 WHERE UPPER(TRIM(symbol)) = 'TRX'
 RETURNING id, symbol, icon_url;

-- USDC
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/usdc.png'
 WHERE UPPER(TRIM(symbol)) = 'USDC'
 RETURNING id, symbol, icon_url;

-- USDT_NFT
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/usdt.png'
 WHERE UPPER(TRIM(symbol)) = 'USDT_NFT'
 RETURNING id, symbol, icon_url;

-- WBTC
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/wbtc.png'
 WHERE UPPER(TRIM(symbol)) = 'WBTC'
 RETURNING id, symbol, icon_url;

-- XRP
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/xrp.png'
 WHERE UPPER(TRIM(symbol)) = 'XRP'
 RETURNING id, symbol, icon_url;

-- CBBTC
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/cbbtc.png'
 WHERE UPPER(TRIM(symbol)) = 'CBBTC'
 RETURNING id, symbol, icon_url;

COMMIT;

-- rollback:
-- UPDATE mining_coins m SET icon_url = b.icon_url
--   FROM mining_coins_bak_icon_url_20260910 b WHERE b.id = m.id;
