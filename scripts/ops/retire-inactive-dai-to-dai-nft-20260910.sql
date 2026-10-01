-- Migra DAI inativa → DAI_NFT ativa e remove a inativa.
-- from: b9115321-d66d-4819-8fb0-6e6e15b9e6b6 (DAI, is_active=0)
-- to:   62224072-4f9e-44e1-8f4a-73e541944aef (DAI_NFT, is_active=1)
-- Pedido 2026-09-10 (mesmo processo do usdc → usdc_interno).
\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS mining_coins_bak_dai_retire_20260910 AS
  SELECT * FROM mining_coins WHERE id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

CREATE TABLE IF NOT EXISTS coin_balances_bak_dai_retire_20260910 AS
  SELECT user_id, coin_id, amount
    FROM coin_balances
   WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

-- 1) Saldos 1:1 → DAI_NFT
INSERT INTO coin_balances (user_id, coin_id, amount)
SELECT user_id, '62224072-4f9e-44e1-8f4a-73e541944aef', amount
  FROM coin_balances
 WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6'
   AND amount <> 0
ON CONFLICT (user_id, coin_id) DO UPDATE
  SET amount = coin_balances.amount + EXCLUDED.amount;

DELETE FROM coin_balances WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

-- 2) Refs sem unicidade conflitante
UPDATE placed_racks
   SET selected_coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
 WHERE selected_coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

UPDATE upgrades
   SET nft_mining_coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
 WHERE nft_mining_coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

UPDATE wallet_ledger_entries
   SET coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
 WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

UPDATE withdrawal_requests
   SET coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
 WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

UPDATE coin_withdrawals
   SET coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
 WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

UPDATE admin_upgrade_coins
   SET coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
 WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

UPDATE season_pass_rewards
   SET coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
 WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

UPDATE mining_eligibility_events
   SET coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
 WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

UPDATE account_manager_payout_ledger
   SET coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
 WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

-- 3) mining_block_history — UNIQUE(user_id, coin_id, window_start_ms, window_end_ms)
-- Soma no destino quando há conflito; senão remapeia.
UPDATE mining_block_history dst
   SET amount_coins = dst.amount_coins + src.amount_coins,
       amount_usd = dst.amount_usd + src.amount_usd,
       credit_blocks = dst.credit_blocks + src.credit_blocks
  FROM mining_block_history src
 WHERE src.coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6'
   AND dst.coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
   AND dst.user_id = src.user_id
   AND dst.window_start_ms = src.window_start_ms
   AND dst.window_end_ms = src.window_end_ms;

DELETE FROM mining_block_history src
 WHERE src.coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6'
   AND EXISTS (
     SELECT 1 FROM mining_block_history dst
      WHERE dst.coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
        AND dst.user_id = src.user_id
        AND dst.window_start_ms = src.window_start_ms
        AND dst.window_end_ms = src.window_end_ms
   );

UPDATE mining_block_history
   SET coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
 WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

-- 4) mining_yield_history — UNIQUE(coin_id, effective_at): em conflito descarta a inativa
DELETE FROM mining_yield_history src
 WHERE src.coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6'
   AND EXISTS (
     SELECT 1 FROM mining_yield_history dst
      WHERE dst.coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
        AND dst.effective_at = src.effective_at
   );

UPDATE mining_yield_history
   SET coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
 WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

-- 5) mining_distribution_daily — PK(day_utc, coin_id): soma no destino
UPDATE mining_distribution_daily dst
   SET total_coins = dst.total_coins + src.total_coins,
       total_usd = dst.total_usd + src.total_usd,
       credit_rows = dst.credit_rows + src.credit_rows,
       unique_users = GREATEST(dst.unique_users, src.unique_users),
       updated_at = GREATEST(dst.updated_at, src.updated_at)
  FROM mining_distribution_daily src
 WHERE src.coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6'
   AND dst.coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
   AND dst.day_utc = src.day_utc;

DELETE FROM mining_distribution_daily
 WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6'
   AND day_utc IN (
     SELECT day_utc FROM mining_distribution_daily
      WHERE coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
   );

UPDATE mining_distribution_daily
   SET coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
 WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

-- 6) account_manager_mining_accrual — UNIQUE(contract_id, coin_id, week_start)
UPDATE account_manager_mining_accrual dst
   SET owner_mined_amount = dst.owner_mined_amount + src.owner_mined_amount,
       manager_share_amount = dst.manager_share_amount + src.manager_share_amount
  FROM account_manager_mining_accrual src
 WHERE src.coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6'
   AND dst.coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
   AND dst.contract_id = src.contract_id
   AND dst.week_start = src.week_start;

DELETE FROM account_manager_mining_accrual src
 WHERE src.coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6'
   AND EXISTS (
     SELECT 1 FROM account_manager_mining_accrual dst
      WHERE dst.coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
        AND dst.contract_id = src.contract_id
        AND dst.week_start = src.week_start
   );

UPDATE account_manager_mining_accrual
   SET coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
 WHERE coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'game_states' AND column_name = 'header_highlight_coin_id'
  ) THEN
    EXECUTE $q$UPDATE game_states SET header_highlight_coin_id = '62224072-4f9e-44e1-8f4a-73e541944aef'
              WHERE header_highlight_coin_id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6'$q$;
  END IF;
END $$;

-- 7) Remove moeda inativa
DELETE FROM mining_coins WHERE id = 'b9115321-d66d-4819-8fb0-6e6e15b9e6b6';

COMMIT;
