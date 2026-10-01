-- Check-in premium: unlock vitalício por gasto USDC (loja/merge/passe/…), não depósito.
-- Flag persistida: uma vez elegível, fica para sempre (admin também pode conceder).

ALTER TABLE "game_states"
  ADD COLUMN IF NOT EXISTS "checkin_premium_unlocked" integer NOT NULL DEFAULT 0;

-- Backfill: quem já gastou ≥ min (settings ou 100) desbloqueia.
WITH min_row AS (
  SELECT COALESCE(
    NULLIF((SELECT value FROM settings WHERE key = 'checkin_premium_min_usdc'), '')::double precision,
    100::double precision
  ) AS min_usdc
),
spend AS (
  SELECT user_id, SUM(amt)::double precision AS spent
  FROM (
    SELECT user_id, total_cost AS amt FROM shop_checkout_idempotency
    UNION ALL
    SELECT buyer_id, buyer_paid_usdc FROM p2p_market_trade_history
    UNION ALL
    SELECT user_id, charged_usdc FROM wheel_spins WHERE COALESCE(charged_usdc, 0) > 0
    UNION ALL
    SELECT user_id, fee_usdc FROM merge_history WHERE COALESCE(fee_usdc, 0) > 0
    UNION ALL
    SELECT p.user_id, COALESCE(u.price_usdc, 0)
    FROM admin_upgrade_purchases p
    JOIN admin_upgrades u ON u.id = p.upgrade_id
    UNION ALL
    SELECT sp.user_id, COALESCE(pass.price_usdc, 0)
    FROM season_purchases sp
    JOIN season_passes pass ON pass.id = sp.pass_id
  ) s
  GROUP BY user_id
)
UPDATE game_states gs
SET checkin_premium_unlocked = 1
FROM spend, min_row
WHERE gs.user_id = spend.user_id
  AND spend.spent >= min_row.min_usdc
  AND COALESCE(gs.checkin_premium_unlocked, 0) = 0;
