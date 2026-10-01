-- Migra USDT inativa → USDT_NFT ativa e remove a inativa.
-- from: e196d52a-124f-4baf-bae4-7b2ba292c074 (USDT, is_active=0)
-- to:   98d360fb-2431-4a51-8fe9-c2b32e448a11 (USDT_NFT, is_active=1)
-- Pedido 2026-09-10 (mesmo processo do DAI → DAI_NFT).
\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS mining_coins_bak_usdt_retire_20260910 AS
  SELECT * FROM mining_coins WHERE id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

CREATE TABLE IF NOT EXISTS coin_balances_bak_usdt_retire_20260910 AS
  SELECT user_id, coin_id, amount
    FROM coin_balances
   WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

-- 1) Saldos 1:1 → USDT_NFT
INSERT INTO coin_balances (user_id, coin_id, amount)
SELECT user_id, '98d360fb-2431-4a51-8fe9-c2b32e448a11', amount
  FROM coin_balances
 WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074'
   AND amount <> 0
ON CONFLICT (user_id, coin_id) DO UPDATE
  SET amount = coin_balances.amount + EXCLUDED.amount;

DELETE FROM coin_balances WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

-- 2) Refs sem unicidade conflitante
UPDATE placed_racks
   SET selected_coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
 WHERE selected_coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

UPDATE upgrades
   SET nft_mining_coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
 WHERE nft_mining_coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

UPDATE wallet_ledger_entries
   SET coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
 WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

UPDATE withdrawal_requests
   SET coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
 WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

UPDATE coin_withdrawals
   SET coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
 WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

UPDATE admin_upgrade_coins
   SET coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
 WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

UPDATE season_pass_rewards
   SET coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
 WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

UPDATE mining_eligibility_events
   SET coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
 WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

UPDATE account_manager_payout_ledger
   SET coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
 WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

-- 3) mining_block_history — UNIQUE(user_id, coin_id, window_start_ms, window_end_ms)
UPDATE mining_block_history dst
   SET amount_coins = dst.amount_coins + src.amount_coins,
       amount_usd = dst.amount_usd + src.amount_usd,
       credit_blocks = dst.credit_blocks + src.credit_blocks
  FROM mining_block_history src
 WHERE src.coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074'
   AND dst.coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
   AND dst.user_id = src.user_id
   AND dst.window_start_ms = src.window_start_ms
   AND dst.window_end_ms = src.window_end_ms;

DELETE FROM mining_block_history src
 WHERE src.coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074'
   AND EXISTS (
     SELECT 1 FROM mining_block_history dst
      WHERE dst.coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
        AND dst.user_id = src.user_id
        AND dst.window_start_ms = src.window_start_ms
        AND dst.window_end_ms = src.window_end_ms
   );

UPDATE mining_block_history
   SET coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
 WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

-- 4) mining_yield_history — UNIQUE(coin_id, effective_at): em conflito descarta a inativa
DELETE FROM mining_yield_history src
 WHERE src.coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074'
   AND EXISTS (
     SELECT 1 FROM mining_yield_history dst
      WHERE dst.coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
        AND dst.effective_at = src.effective_at
   );

UPDATE mining_yield_history
   SET coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
 WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

-- 5) mining_distribution_daily — PK(day_utc, coin_id): soma no destino
UPDATE mining_distribution_daily dst
   SET total_coins = dst.total_coins + src.total_coins,
       total_usd = dst.total_usd + src.total_usd,
       credit_rows = dst.credit_rows + src.credit_rows,
       unique_users = GREATEST(dst.unique_users, src.unique_users),
       updated_at = GREATEST(dst.updated_at, src.updated_at)
  FROM mining_distribution_daily src
 WHERE src.coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074'
   AND dst.coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
   AND dst.day_utc = src.day_utc;

DELETE FROM mining_distribution_daily
 WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074'
   AND day_utc IN (
     SELECT day_utc FROM mining_distribution_daily
      WHERE coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
   );

UPDATE mining_distribution_daily
   SET coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
 WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

-- 6) account_manager_mining_accrual — UNIQUE(contract_id, coin_id, week_start)
UPDATE account_manager_mining_accrual dst
   SET owner_mined_amount = dst.owner_mined_amount + src.owner_mined_amount,
       manager_share_amount = dst.manager_share_amount + src.manager_share_amount
  FROM account_manager_mining_accrual src
 WHERE src.coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074'
   AND dst.coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
   AND dst.contract_id = src.contract_id
   AND dst.week_start = src.week_start;

DELETE FROM account_manager_mining_accrual src
 WHERE src.coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074'
   AND EXISTS (
     SELECT 1 FROM account_manager_mining_accrual dst
      WHERE dst.coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
        AND dst.contract_id = src.contract_id
        AND dst.week_start = src.week_start
   );

UPDATE account_manager_mining_accrual
   SET coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
 WHERE coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'game_states' AND column_name = 'header_highlight_coin_id'
  ) THEN
    EXECUTE $q$UPDATE game_states SET header_highlight_coin_id = '98d360fb-2431-4a51-8fe9-c2b32e448a11'
              WHERE header_highlight_coin_id = 'e196d52a-124f-4baf-bae4-7b2ba292c074'$q$;
  END IF;
END $$;

-- 7) Remove moeda inativa
DELETE FROM mining_coins WHERE id = 'e196d52a-124f-4baf-bae4-7b2ba292c074';

COMMIT;
