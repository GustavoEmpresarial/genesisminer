-- Migra moeda inativa `usdc` → `usdc_interno` e remove `usdc` do catálogo.
-- Pedido 2026-09-10: converter saldos de todos; depois apagar a inativa.
-- Nota: em prod na altura do script, coin_balances para `usdc` já estava vazio;
-- o merge fica defensivo. NÃO mexe em game_states.usdc (fiat da carteira).
\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS mining_coins_bak_usdc_retire_20260910 AS
  SELECT * FROM mining_coins WHERE id = 'usdc';

CREATE TABLE IF NOT EXISTS coin_balances_bak_usdc_retire_20260910 AS
  SELECT user_id, coin_id, amount FROM coin_balances WHERE coin_id = 'usdc';

-- 1) Merge saldos usdc → usdc_interno (1:1)
INSERT INTO coin_balances (user_id, coin_id, amount)
SELECT user_id, 'usdc_interno', amount
  FROM coin_balances
 WHERE coin_id = 'usdc'
   AND amount <> 0
ON CONFLICT (user_id, coin_id) DO UPDATE
  SET amount = coin_balances.amount + EXCLUDED.amount;

DELETE FROM coin_balances WHERE coin_id = 'usdc';

-- 2) Remap refs soft (histórico / config) usdc → usdc_interno
UPDATE placed_racks SET selected_coin_id = 'usdc_interno' WHERE selected_coin_id = 'usdc';
UPDATE upgrades SET nft_mining_coin_id = 'usdc_interno' WHERE nft_mining_coin_id = 'usdc';
UPDATE mining_block_history SET coin_id = 'usdc_interno' WHERE coin_id = 'usdc';
UPDATE mining_yield_history SET coin_id = 'usdc_interno' WHERE coin_id = 'usdc';
UPDATE wallet_ledger_entries SET coin_id = 'usdc_interno' WHERE coin_id = 'usdc';
UPDATE withdrawal_requests SET coin_id = 'usdc_interno' WHERE coin_id = 'usdc';
UPDATE coin_withdrawals SET coin_id = 'usdc_interno' WHERE coin_id = 'usdc';
UPDATE admin_upgrade_coins SET coin_id = 'usdc_interno' WHERE coin_id = 'usdc';
UPDATE season_pass_rewards SET coin_id = 'usdc_interno' WHERE coin_id = 'usdc';
UPDATE mining_eligibility_events SET coin_id = 'usdc_interno' WHERE coin_id = 'usdc';
UPDATE mining_distribution_daily SET coin_id = 'usdc_interno' WHERE coin_id = 'usdc';
UPDATE account_manager_mining_accrual SET coin_id = 'usdc_interno' WHERE coin_id = 'usdc';
UPDATE account_manager_payout_ledger SET coin_id = 'usdc_interno' WHERE coin_id = 'usdc';

-- header highlight se existir a coluna
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'game_states' AND column_name = 'header_highlight_coin_id'
  ) THEN
    EXECUTE $q$UPDATE game_states SET header_highlight_coin_id = 'usdc_interno'
              WHERE header_highlight_coin_id = 'usdc'$q$;
  END IF;
END $$;

-- 3) Remove a moeda inativa do catálogo
DELETE FROM mining_coins WHERE id = 'usdc';

COMMIT;
-- rollback catálogo: INSERT INTO mining_coins SELECT * FROM mining_coins_bak_usdc_retire_20260910;
-- rollback saldos: ver coin_balances_bak_usdc_retire_20260910 (só linhas usdc originais)
