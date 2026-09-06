/**
 * Agregados do Admin Dashboard — SQL alinhado ao legado
 * `computeAdminDashboardStatsUncached` (server.ts).
 */
import db from '../../../../core/database/pool.js';
import { MS_PER_MINUTE } from '../../../../shared/utils/time.js';

/**
 * Minutos de stale `last_seen` para «online» (legado dashboard: `4 * 60 * 1000`;
 * UI aproxima a «5 min»).
 */
const ADMIN_DASHBOARD_ONLINE_STALE_MINUTES = 4;

/**
 * Janela «online» do dashboard. Partilhada com site-metrics para o mesmo critério.
 */
export const ADMIN_DASHBOARD_ONLINE_STALE_MS =
  ADMIN_DASHBOARD_ONLINE_STALE_MINUTES * MS_PER_MINUTE;

/** Top-N do dashboard (last10 / top deposits / top miners / saques por moeda). */
const DASHBOARD_TOP_LIST_LIMIT = 10;

export type AdminDashboardStatsPayload = {
  totalUsers: number;
  deactivatedUsers: number;
  onlineUsers: number;
  totalDeposited: number;
  totalWithdrawn: number;
  last10: Array<{ username: string; email: string }>;
  topDeposits: Array<{ username: string; email: string; amount: number }>;
  topWithdrawalsByCoin: Array<{
    coinId: string;
    coinName: string;
    top: Array<{ username: string; email: string; total: number }>;
  }>;
  globalPower: number;
  topMiners: Array<{ username: string; email: string; amount: number }>;
  rankingExcluded: Array<{ id: number; username: string; email: string; is_admin: number }>;
  miningCoins: Array<{ id: string; name: string }>;
};

let cache: AdminDashboardStatsPayload | null = null;
let lastFetch = 0;
const CACHE_TTL_MS = 10_000;

export function invalidateAdminDashboardStatsCache(): void {
  cache = null;
  lastFetch = 0;
}

export async function computeAdminDashboardStatsUncached(): Promise<AdminDashboardStatsPayload> {
  const totalUsersRes = await db.query(
    'SELECT COUNT(*) FROM users WHERE is_admin = 0 AND COALESCE(is_blocked, 0) = 0'
  );
  const deactivatedUsersRes = await db.query(
    'SELECT COUNT(*) FROM users WHERE is_admin = 0 AND COALESCE(is_blocked, 0) <> 0'
  );
  const nowMs = Date.now();
  const onlineCutoff = nowMs - ADMIN_DASHBOARD_ONLINE_STALE_MS;
  const onlineUsersRes = await db.query(
    `
      SELECT COUNT(DISTINCT s.user_id) AS count
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE u.is_admin = 0
        AND s.expires_at > $1
        AND COALESCE(NULLIF(s.last_seen_at, 0), s.created_at) > $2
    `,
    [nowMs, onlineCutoff]
  );

  const depositsRes = await db.query(`
      SELECT SUM(gs.total_usdc_deposited) as total
      FROM game_states gs
      JOIN users u ON gs.user_id = u.id
      WHERE u.is_admin = 0
    `);
  const withdrawnRes = await db.query(`
      SELECT SUM(amount_usdc) as total
      FROM withdrawal_requests
      WHERE status = 'completed'
    `);

  const last10Res = await db.query(
    'SELECT username, email FROM users WHERE is_admin = 0 ORDER BY id DESC LIMIT 10'
  );

  const topDepositsRes = await db.query(`
      SELECT u.username, u.email, gs.total_usdc_deposited as amount
      FROM users u
      JOIN game_states gs ON u.id = gs.user_id
      WHERE u.is_admin = 0 AND gs.total_usdc_deposited > 0
      ORDER BY gs.total_usdc_deposited DESC LIMIT 10
    `);

  const powerRes = await db.query(`
      WITH rack_base AS (
        SELECT
          r.id as rack_id,
          r.user_id,
          SUM(COALESCE(u.base_production, 0)) as base_prod
        FROM placed_racks r
        JOIN rack_slots rs ON r.id = rs.rack_id
        LEFT JOIN upgrades u ON rs.machine_item_id = u.id
        WHERE r.is_on = 1
          AND r.wiring_id IS NOT NULL
          AND r.battery_id IS NOT NULL
        GROUP BY r.id, r.user_id
      ),
      rack_mult AS (
        SELECT
          rms.rack_id,
          1 + SUM(COALESCE(u.multiplier, 0)) as total_mult
        FROM rack_multiplier_slots rms
        JOIN upgrades u ON rms.multiplier_item_id = u.id
        GROUP BY rms.rack_id
      ),
      user_power AS (
        SELECT
          rb.user_id,
          SUM(rb.base_prod * COALESCE(rm.total_mult, 1)) as power
        FROM rack_base rb
        LEFT JOIN rack_mult rm ON rb.rack_id = rm.rack_id
        GROUP BY rb.user_id
      )
      SELECT
        up.power,
        u.username,
        u.email,
        u.ranking_excluded
      FROM user_power up
      JOIN users u ON up.user_id = u.id
      WHERE COALESCE(u.ranking_excluded, 0) = 0
      ORDER BY up.power DESC
    `);

  const topMinersList = powerRes.rows.slice(0, DASHBOARD_TOP_LIST_LIMIT).map((r: { username: string; email: string; power: unknown }) => ({
    username: r.username,
    email: r.email,
    amount: Number(r.power)
  }));

  const globalPower = powerRes.rows.reduce(
    (acc: number, r: { power: unknown }) => acc + Number(r.power),
    0
  );

  const rankingExcludedRes = await db.query(`
      SELECT id, username, email, COALESCE(is_admin, 0) AS is_admin
      FROM users
      WHERE COALESCE(ranking_excluded, 0) = 1
      ORDER BY LOWER(username)
      LIMIT 500
    `);

  const coinsRes = await db.query('SELECT id, name FROM mining_coins ORDER BY name ASC');
  /** Uma query com window (em vez de N+1 por moeda). */
  const topWRes = await db.query(`
      WITH ranked AS (
        SELECT
          w.coin_id,
          u.username,
          u.email,
          SUM(w.amount_crypto) AS total,
          ROW_NUMBER() OVER (
            PARTITION BY w.coin_id
            ORDER BY SUM(w.amount_crypto) DESC
          ) AS rn
        FROM withdrawal_requests w
        JOIN users u ON u.id = w.user_id
        WHERE w.status = 'completed'
        GROUP BY w.coin_id, u.id, u.username, u.email
      )
      SELECT
        r.coin_id,
        mc.name AS coin_name,
        r.username,
        r.email,
        r.total
      FROM ranked r
      JOIN mining_coins mc ON mc.id = r.coin_id
      WHERE r.rn <= 10
      ORDER BY LOWER(mc.name) ASC, r.total DESC
    `);

  const withdrawalsByCoinMap = new Map<
    string,
    AdminDashboardStatsPayload['topWithdrawalsByCoin'][number]
  >();
  for (const r of topWRes.rows as Array<{
    coin_id: string;
    coin_name: string;
    username: string;
    email: string;
    total: unknown;
  }>) {
    const coinId = String(r.coin_id);
    let bucket = withdrawalsByCoinMap.get(coinId);
    if (!bucket) {
      bucket = { coinId, coinName: String(r.coin_name || coinId), top: [] };
      withdrawalsByCoinMap.set(coinId, bucket);
    }
    bucket.top.push({
      username: r.username,
      email: r.email,
      total: Number(r.total)
    });
  }
  const withdrawalsByCoin = Array.from(withdrawalsByCoinMap.values());

  return {
    totalUsers: parseInt(String(totalUsersRes.rows[0]?.count ?? 0), 10) || 0,
    deactivatedUsers: parseInt(String(deactivatedUsersRes.rows[0]?.count ?? 0), 10) || 0,
    onlineUsers: parseInt(String(onlineUsersRes.rows[0]?.count ?? 0), 10) || 0,
    totalDeposited: Number(depositsRes.rows[0]?.total) || 0,
    totalWithdrawn: Number(withdrawnRes.rows[0]?.total) || 0,
    last10: last10Res.rows as Array<{ username: string; email: string }>,
    topDeposits: (topDepositsRes.rows as Array<{ username: string; email: string; amount: unknown }>).map((r) => ({
      username: r.username,
      email: r.email,
      amount: Number(r.amount)
    })),
    topWithdrawalsByCoin: withdrawalsByCoin,
    globalPower,
    topMiners: topMinersList,
    rankingExcluded: rankingExcludedRes.rows as Array<{
      id: number;
      username: string;
      email: string;
      is_admin: number;
    }>,
    miningCoins: (coinsRes.rows as Array<{ id: string; name: string }>).map((c) => ({
      id: String(c.id),
      name: String(c.name || c.id)
    }))
  };
}

export async function getAdminDashboardStatsCached(): Promise<AdminDashboardStatsPayload> {
  const now = Date.now();
  if (cache && now - lastFetch < CACHE_TTL_MS) return cache;
  cache = await computeAdminDashboardStatsUncached();
  lastFetch = Date.now();
  return cache;
}
