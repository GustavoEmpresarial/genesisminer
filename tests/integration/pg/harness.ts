/**
 * Harness mínimo para testes de concorrência contra PostgreSQL real.
 * Cria utilizadores/itens prefixados e limpa no finally — não altera schema.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';

export type PgFixtureCtx = {
  pool: Pool;
  tag: string;
  userIds: number[];
  upgradeIds: string[];
  roomIds: string[];
  listingIds: string[];
  usernames: string[];
};

export function makeTag(): string {
  return `pgit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function createUser(
  pool: Pool,
  opts: { username: string; email: string; usdc: number; polygonWallet?: string | null; referredBy?: string | null }
): Promise<number> {
  const now = Date.now();
  const u = await pool.query<{ id: number }>(
    `INSERT INTO users (username, email, password, is_blocked, is_admin, is_super_admin, polygon_wallet, referred_by, email_verified)
     VALUES ($1, $2, 'x', 0, 0, 0, $3, $4, 1)
     RETURNING id`,
    [opts.username, opts.email, opts.polygonWallet ?? null, opts.referredBy ?? null]
  );
  const userId = u.rows[0]!.id;
  await pool.query(
    `INSERT INTO game_states (
       user_id, usdc, start_time, claimed_referrals, referral_bonus_claimed,
       last_updated_at, server_updated_at, black_market_balance
     ) VALUES ($1, $2, $3, 0, 0, $3, $3, 0)`,
    [userId, opts.usdc, now]
  );
  return userId;
}

export async function createHardwareUpgrade(
  pool: Pool,
  opts: { id: string; name: string; baseCost: number; sellInBlackMarket?: number }
): Promise<void> {
  await pool.query(
    `INSERT INTO upgrades (
       id, name, category, type, base_cost, base_production, description, icon, status,
       is_nft, sell_in_hardware_market, sell_in_black_market, is_active, rarity, total_sold
     ) VALUES (
       $1, $2, 'gpu', 'machine', $3, 0, 'itest', 'x', 'active',
       0, 1, $4, 1, 'common', 0
     )
     ON CONFLICT (id) DO UPDATE SET
       base_cost = EXCLUDED.base_cost,
       sell_in_hardware_market = 1,
       sell_in_black_market = EXCLUDED.sell_in_black_market,
       is_active = 1,
       status = 'active'`,
    [opts.id, opts.name, opts.baseCost, opts.sellInBlackMarket ?? 1]
  );
}

export async function ensureHardwareMarketOpen(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('hardware_market_enabled', '1')
     ON CONFLICT (key) DO UPDATE SET value = '1'`
  );
}

export async function seedShopCart(pool: Pool, userId: number, productId: string, qty: number): Promise<string> {
  const now = Date.now();
  const cart = await pool.query<{ id: string }>(
    `INSERT INTO shop_carts (user_id, updated_at) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [userId, now]
  );
  const cartId = cart.rows[0]!.id;
  await pool.query(`DELETE FROM shop_cart_lines WHERE cart_id = $1::uuid`, [cartId]);
  await pool.query(
    `INSERT INTO shop_cart_lines (cart_id, product_id, qty, updated_at) VALUES ($1::uuid, $2, $3, $4)`,
    [cartId, productId, qty, now]
  );
  return cartId;
}

export async function createOpenRigRoom(
  pool: Pool,
  opts: { id: string; baseSlotPrice: number; initialCapacity?: number; maxCapacity?: number }
): Promise<void> {
  await pool.query(
    `INSERT INTO rig_rooms (
       id, name, initial_capacity, max_capacity, base_slot_price, slot_price_increase_percent,
       allowed_levels, allowed_season_pass_ids, is_active, sort_order
     ) VALUES ($1, $2, $3, $4, $5, 0, NULL, NULL, 1, 0)
     ON CONFLICT (id) DO UPDATE SET
       base_slot_price = EXCLUDED.base_slot_price,
       initial_capacity = EXCLUDED.initial_capacity,
       max_capacity = EXCLUDED.max_capacity,
       allowed_levels = NULL,
       is_active = 1`,
    [opts.id, `itest ${opts.id}`, opts.initialCapacity ?? 0, opts.maxCapacity ?? 10, opts.baseSlotPrice]
  );
}

export async function getUsdc(pool: Pool, userId: number): Promise<number> {
  const r = await pool.query<{ usdc: string | number }>(`SELECT usdc FROM game_states WHERE user_id = $1`, [userId]);
  return Number(r.rows[0]?.usdc ?? 0);
}

export async function getStockQty(pool: Pool, userId: number, itemId: string): Promise<number> {
  const r = await pool.query<{ qty: number }>(`SELECT qty FROM stock WHERE user_id = $1 AND item_id = $2`, [userId, itemId]);
  return Number(r.rows[0]?.qty ?? 0);
}

export async function getClaimedReferrals(pool: Pool, userId: number): Promise<number> {
  const r = await pool.query<{ claimed_referrals: number }>(
    `SELECT claimed_referrals FROM game_states WHERE user_id = $1`,
    [userId]
  );
  return Number(r.rows[0]?.claimed_referrals ?? 0);
}

/** Contrato: rust/genesis-hardware/src/instances.rs */
const ITEM_INSTANCE_STATUS_STOCK = 'stock';
const ITEM_INSTANCE_STATUS_LISTED = 'listed';
const ITEM_INSTANCE_CODE_SEP = ':';

async function mintItemInstances(
  pool: Pool,
  userId: number,
  catalogItemId: string,
  qty: number,
  status: typeof ITEM_INSTANCE_STATUS_STOCK | typeof ITEM_INSTANCE_STATUS_LISTED
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < qty; i++) {
    const id = crypto.randomUUID();
    const code = `${catalogItemId}${ITEM_INSTANCE_CODE_SEP}${id}`;
    await pool.query(
      `INSERT INTO item_instances (id, code, catalog_item_id, user_id, status)
       VALUES ($1::uuid, $2, $3, $4, $5)`,
      [id, code, catalogItemId, userId, status]
    );
    ids.push(id);
  }
  return ids;
}

export async function seedStockInstances(
  pool: Pool,
  userId: number,
  catalogItemId: string,
  qty: number
): Promise<string[]> {
  return mintItemInstances(pool, userId, catalogItemId, qty, ITEM_INSTANCE_STATUS_STOCK);
}

export async function seedListedListingInstances(
  pool: Pool,
  listingId: string,
  sellerId: number,
  catalogItemId: string,
  qty: number
): Promise<string[]> {
  const ids = await mintItemInstances(pool, sellerId, catalogItemId, qty, ITEM_INSTANCE_STATUS_LISTED);
  for (const instanceId of ids) {
    await pool.query(
      `INSERT INTO player_listing_instances (listing_id, instance_id) VALUES ($1, $2::uuid)`,
      [listingId, instanceId]
    );
  }
  return ids;
}

export async function countReferrals(pool: Pool, referrerId: number, referredUsername: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM referrals WHERE user_id = $1 AND referred_username = $2`,
    [referrerId, referredUsername]
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function cleanupFixture(
  pool: Pool,
  ctx: Omit<PgFixtureCtx, 'pool' | 'tag'>
): Promise<void> {
  const userIds = ctx.userIds;
  if (userIds.length > 0) {
    await pool.query(
      `DELETE FROM rack_slots WHERE rack_id IN (SELECT id FROM placed_racks WHERE user_id = ANY($1::int[]))`,
      [userIds]
    );
    await pool.query(
      `DELETE FROM rack_multiplier_slots WHERE rack_id IN (SELECT id FROM placed_racks WHERE user_id = ANY($1::int[]))`,
      [userIds]
    );
    await pool.query(`DELETE FROM placed_racks WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM stored_batteries WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM inventory_movements WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM player_asic_leases WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(
      `DELETE FROM player_listing_instances WHERE listing_id IN (
         SELECT id FROM player_listings WHERE user_id = ANY($1::int[]) OR reserved_by = ANY($1::int[])
       )`,
      [userIds]
    );
    if (ctx.listingIds.length > 0) {
      await pool.query(`DELETE FROM player_listing_instances WHERE listing_id = ANY($1::text[])`, [ctx.listingIds]);
    }
    await pool.query(`DELETE FROM item_instances WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM game_servers_intent_idempotency WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM mining_eligibility_events WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM shop_cart_lines WHERE cart_id IN (SELECT id FROM shop_carts WHERE user_id = ANY($1::int[]))`, [
      userIds
    ]);
    await pool.query(`DELETE FROM shop_carts WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM shop_checkout_idempotency WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM room_slot_purchase_idempotency WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM lucky_box_idempotency WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM lucky_box_openings WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM unopened_boxes WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM stock WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM user_rig_rooms WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM daily_actions WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM user_deposit_history WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM p2p_market_buy_idempotency WHERE buyer_id = ANY($1::int[])`, [userIds]);
    await pool.query(
      `DELETE FROM p2p_market_trade_history WHERE buyer_id = ANY($1::int[]) OR seller_id = ANY($1::int[])`,
      [userIds]
    );
    await pool.query(
      `DELETE FROM player_listing_instances WHERE listing_id IN (
         SELECT id FROM player_listings WHERE user_id = ANY($1::int[]) OR reserved_by = ANY($1::int[])
       )`,
      [userIds]
    );
    await pool.query(
      `DELETE FROM player_listings WHERE user_id = ANY($1::int[]) OR reserved_by = ANY($1::int[])`,
      [userIds]
    );
    if (ctx.usernames.length > 0) {
      await pool.query(`DELETE FROM referrals WHERE user_id = ANY($1::int[]) OR referred_username = ANY($2::text[])`, [
        userIds,
        ctx.usernames
      ]);
    } else {
      await pool.query(`DELETE FROM referrals WHERE user_id = ANY($1::int[])`, [userIds]);
    }
    await pool.query(`DELETE FROM game_states WHERE user_id = ANY($1::int[])`, [userIds]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
  }
  if (ctx.listingIds.length > 0) {
    await pool.query(`DELETE FROM player_listing_instances WHERE listing_id = ANY($1::text[])`, [ctx.listingIds]);
    await pool.query(`DELETE FROM player_listings WHERE id = ANY($1::text[])`, [ctx.listingIds]);
  }
  if (ctx.upgradeIds.length > 0) {
    await pool.query(`DELETE FROM upgrades WHERE id = ANY($1::text[])`, [ctx.upgradeIds]);
  }
  if (ctx.roomIds.length > 0) {
    await pool.query(`DELETE FROM rig_rooms WHERE id = ANY($1::text[])`, [ctx.roomIds]);
  }
}

/**
 * beforeAll/afterAll por ficheiro. NÃO fecha o pool singleton — vários ficheiros
 * de integração partilham `server/core/database/pool.js`.
 */
export function registerPgIntegrationLifecycle(getCtx: () => PgFixtureCtx | null, setCtx: (c: PgFixtureCtx) => void): void {
  beforeAll(async () => {
    const { default: pool } = await import('../../../server/core/database/pool.js');
    await pool.query('SELECT 1');
    setCtx({
      pool,
      tag: makeTag(),
      userIds: [],
      upgradeIds: [],
      roomIds: [],
      listingIds: [],
      usernames: []
    });
  }, 30_000);

  afterAll(async () => {
    const ctx = getCtx();
    if (!ctx) return;
    await cleanupFixture(ctx.pool, ctx);
  }, 30_000);
}

export function expectOneSuccess<T>(results: PromiseSettledResult<T>[]): { fulfilled: T[]; rejected: unknown[] } {
  const fulfilled = results.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled').map((r) => r.value);
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
  expect(fulfilled.length + rejected.length).toBe(results.length);
  return { fulfilled, rejected };
}
