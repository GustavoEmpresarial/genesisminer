-- Performance indexes for hot paths (yield, ranking, P2P, wallet withdrawals).
-- Additive only; CONCURRENTLY not used so migrate deploy stays transactional.

CREATE INDEX IF NOT EXISTS "users_blocked_ranking_excluded_idx"
  ON "users" ("is_blocked", "ranking_excluded");

CREATE INDEX IF NOT EXISTS "placed_racks_is_on_user_idx"
  ON "placed_racks" ("is_on", "user_id");

CREATE INDEX IF NOT EXISTS "placed_racks_user_id_idx"
  ON "placed_racks" ("user_id");

CREATE INDEX IF NOT EXISTS "player_listings_status_expires_idx"
  ON "player_listings" ("status", "expires_at");

CREATE INDEX IF NOT EXISTS "player_listings_user_status_idx"
  ON "player_listings" ("user_id", "status");

CREATE INDEX IF NOT EXISTS "player_listings_status_reserved_until_idx"
  ON "player_listings" ("status", "reserved_until");

CREATE INDEX IF NOT EXISTS "p2p_trade_history_buyer_created_idx"
  ON "p2p_market_trade_history" ("buyer_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "p2p_trade_history_seller_created_idx"
  ON "p2p_market_trade_history" ("seller_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "mining_yield_history_effective_at_idx"
  ON "mining_yield_history" ("effective_at");

CREATE INDEX IF NOT EXISTS "mining_yield_history_coin_effective_idx"
  ON "mining_yield_history" ("coin_id", "effective_at");

CREATE INDEX IF NOT EXISTS "withdrawal_requests_user_created_idx"
  ON "withdrawal_requests" ("user_id", "created_at" DESC);
