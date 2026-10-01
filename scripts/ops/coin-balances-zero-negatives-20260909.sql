-- Zera saldos negativos em coin_balances (desk mostrava WBTC −7 ≈ −$556k).
-- 2026-09-09: user 11915 WBTC=-7; user 8179 POL≈-5.45.
-- Causa provável: admin absolute SET / save-game sem floor a 0.
\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS coin_balances_bak_neg_fix_20260909 AS
  SELECT user_id, coin_id, amount
    FROM coin_balances
   WHERE amount < 0;
UPDATE coin_balances
   SET amount = 0
 WHERE amount < 0
 RETURNING user_id, coin_id, amount;
COMMIT;
-- rollback:
-- UPDATE coin_balances c SET amount = b.amount
--   FROM coin_balances_bak_neg_fix_20260909 b
--  WHERE c.user_id = b.user_id AND c.coin_id = b.coin_id;
