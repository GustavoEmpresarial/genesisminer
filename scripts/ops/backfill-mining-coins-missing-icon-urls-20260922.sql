-- Backfill mining_coins.icon_url for coins missing icons (BTC, USDC_INTERNO, etc.)
-- Fixes coin images disappearing across the site when coins are renamed or icon_url was omitted.
\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS mining_coins_bak_icon_url_20260922 AS
  SELECT id, symbol, name, icon_url FROM mining_coins;

-- BTC
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/btc.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('BTC', 'BTC_GPU', 'BTC_NFT')
     OR UPPER(TRIM(name)) LIKE 'BITCOIN%');

-- USDC / USDC_INTERNO / USDC_INT
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/usdc.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('USDC', 'USDC_INTERNO', 'USDC_INT', 'USDC_GPU', 'USDC_NFT')
     OR UPPER(TRIM(name)) LIKE 'USD COIN%'
     OR UPPER(TRIM(name)) LIKE 'USDC%');

-- ETH
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/eth.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('ETH', 'WETH', 'ETH_GPU', 'ETH_NFT')
     OR UPPER(TRIM(name)) LIKE 'ETHEREUM%');

-- BNB
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/bnb.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('BNB', 'BNB_GPU', 'BNB_NFT')
     OR UPPER(TRIM(name)) LIKE 'BINANCE%');

-- SOL
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/sol.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('SOL', 'SOL_GPU', 'SOL_NFT')
     OR UPPER(TRIM(name)) LIKE 'SOLANA%');

-- DOGE
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/doge.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('DOGE', 'DOGE_GPU', 'DOGE_NFT')
     OR UPPER(TRIM(name)) LIKE 'DOGECOIN%');

-- TRX
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/trx.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('TRX', 'TRX_GPU', 'TRX_NFT')
     OR UPPER(TRIM(name)) LIKE 'TRON%');

-- XRP
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/xrp.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('XRP', 'XRP_GPU', 'XRP_NFT')
     OR UPPER(TRIM(name)) LIKE 'RIPPLE%');

-- SHIB
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/shib.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('SHIB', 'SHIBA')
     OR UPPER(TRIM(name)) LIKE 'SHIBA%');

-- USDT
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/usdt.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('USDT', 'USDT_NFT', 'USDT_GPU')
     OR UPPER(TRIM(name)) LIKE 'TETHER%');

-- DAI
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/dai.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('DAI', 'DAI_NFT', 'DAI_GPU')
     OR UPPER(TRIM(name)) LIKE 'DAI%');

-- POL / MATIC
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/pol.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('POL', 'MATIC', 'POL_NFT')
     OR UPPER(TRIM(name)) LIKE 'POLYGON%');

-- GEMT
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/gemt.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('GEMT', 'GENT')
     OR UPPER(TRIM(name)) LIKE 'GENESIS%');

-- GHO
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/gho.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('GHO', 'GHO_NFT')
     OR UPPER(TRIM(name)) LIKE 'GHO%');

-- WBTC
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/wbtc.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('WBTC', 'WBTC_NFT')
     OR UPPER(TRIM(name)) LIKE 'WRAPPED BITCOIN%');

-- CBBTC
UPDATE mining_coins
   SET icon_url = '/img/coin-logos/cbbtc.png'
 WHERE (icon_url IS NULL OR TRIM(icon_url) = '')
   AND (UPPER(TRIM(symbol)) IN ('CBBTC', 'CBBTC_NFT')
     OR UPPER(TRIM(name)) LIKE 'COINBASE BTC%');

COMMIT;

-- Rollback:
-- UPDATE mining_coins m SET icon_url = b.icon_url
--   FROM mining_coins_bak_icon_url_20260922 b WHERE b.id = m.id;
