/**
 * Lista paginada de contas para o AdminPanel — SQL alinhado ao legado `GET /api/users`.
 */
import db from '../../../../core/database/pool.js';
import { resolveIsSuperAdminFromUserRow } from '../../../auth/services/super-admin.js';
import {
  buildUsersListWhere,
  orderByClause,
  parseAdminPermissionsJson,
  parseAdminUsersListQuery,
  type AdminUsersListQuery
} from './list-query.js';

export type AdminListedUser = {
  id: number;
  username: string;
  email: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  polygonWallet?: string;
  isBlocked: boolean;
  accessLevelId?: string;
  referralCode?: string;
  referredBy?: string;
  referrals: string[];
  accessLevelIds: string[];
  lastActiveAt?: number;
  totalUsdcDeposited: number;
  totalCryptoWithdrawn: number;
  adminPermissions: string[];
};

export type AdminUsersListPayload = {
  users: AdminListedUser[];
  total: number;
  pages: number;
  levels: Array<{ id: string; name: string }>;
  rooms: Array<{ id: string; name: string }>;
};

type GsRow = {
  lastUpdatedAt: unknown;
  totalUsdcDeposited: number;
  totalCryptoWithdrawn: number;
};

function numOrUndef(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function mapUserRow(
  r: Record<string, unknown>,
  refMap: Record<number, string[]>,
  gsMap: Record<number, GsRow>,
  userLvlsMap: Record<number, string[]>
): AdminListedUser {
  const id = Number(r.id);
  const isAdmin = Number(r.is_admin) !== 0;
  const gs = gsMap[id];
  const lastFromUser = numOrUndef(r.last_active_at);
  const lastFromGs = numOrUndef(gs?.lastUpdatedAt);
  const accessLevelId = r.access_level_id != null ? String(r.access_level_id) : undefined;
  return {
    id,
    username: String(r.username ?? ''),
    email: String(r.email ?? ''),
    isAdmin,
    isSuperAdmin: resolveIsSuperAdminFromUserRow({ is_super_admin: r.is_super_admin }),
    polygonWallet: r.polygon_wallet != null ? String(r.polygon_wallet) : undefined,
    isBlocked: Number(r.is_blocked) !== 0,
    accessLevelId,
    referralCode: r.referral_code != null ? String(r.referral_code) : undefined,
    referredBy: r.referred_by != null ? String(r.referred_by) : undefined,
    referrals: refMap[id] || [],
    accessLevelIds: Array.from(new Set([...(userLvlsMap[id] || []), ...(accessLevelId ? [accessLevelId] : [])])),
    lastActiveAt: lastFromUser ?? lastFromGs,
    totalUsdcDeposited: gs?.totalUsdcDeposited ?? 0,
    totalCryptoWithdrawn: gs?.totalCryptoWithdrawn ?? 0,
    adminPermissions: parseAdminPermissionsJson(r.admin_permissions)
  };
}

export async function listAdminUsers(
  rawQuery: Record<string, unknown> | undefined,
  nowMs: number = Date.now()
): Promise<AdminUsersListPayload> {
  const q: AdminUsersListQuery = parseAdminUsersListQuery(rawQuery);
  const { whereSql, params, nextIdx } = buildUsersListWhere(q, nowMs);
  const orderSql = orderByClause(q);

  const countQuery = `
      SELECT COUNT(*)
      FROM users u
      LEFT JOIN game_states gs ON u.id = gs.user_id
      ${whereSql}
    `;
  const totalRes = await db.query(countQuery, params);
  const total = parseInt(String(totalRes.rows[0]?.count ?? '0'), 10) || 0;
  const pages = q.limit > 0 ? Math.ceil(total / q.limit) : 0;

  const query = `
      SELECT u.*
      FROM users u
      LEFT JOIN game_states gs ON u.id = gs.user_id
      ${whereSql}
      ${orderSql}
      LIMIT $${nextIdx} OFFSET $${nextIdx + 1}
    `;
  const uRes = await db.query(query, [...params, q.limit, q.offset]);

  const lvRes = await db.query('SELECT id,name FROM access_levels');
  const roomsRes = await db.query(`
      SELECT id, name
      FROM rig_rooms
      WHERE COALESCE(is_active, 1) = 1
      ORDER BY sort_order ASC, name ASC
    `);

  const levels = (lvRes.rows || []) as Array<{ id: string; name: string }>;
  const rooms = (roomsRes.rows || []) as Array<{ id: string; name: string }>;
  const rows = uRes.rows as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return { users: [], total, pages, levels, rooms };
  }

  const userIds = rows.map((u) => Number(u.id));
  const refRes = await db.query('SELECT user_id, referred_username FROM referrals WHERE user_id = ANY($1)', [userIds]);
  const gsRes = await db.query(
    'SELECT user_id, last_updated_at, total_usdc_deposited, total_crypto_withdrawn, black_market_balance FROM game_states WHERE user_id = ANY($1)',
    [userIds]
  );
  const userLvlsRes = await db.query(
    'SELECT user_id, access_level_id FROM user_access_levels WHERE user_id = ANY($1)',
    [userIds]
  );

  const refMap: Record<number, string[]> = {};
  for (const r of refRes.rows as Array<{ user_id: number; referred_username: string }>) {
    const uid = Number(r.user_id);
    refMap[uid] = refMap[uid] || [];
    refMap[uid].push(r.referred_username);
  }

  const gsMap: Record<number, GsRow> = {};
  for (const r of gsRes.rows as Array<{
    user_id: number;
    last_updated_at: unknown;
    total_usdc_deposited: unknown;
    total_crypto_withdrawn: unknown;
  }>) {
    gsMap[Number(r.user_id)] = {
      lastUpdatedAt: r.last_updated_at,
      totalUsdcDeposited: Number(r.total_usdc_deposited) || 0,
      totalCryptoWithdrawn: Number(r.total_crypto_withdrawn) || 0
    };
  }

  const userLvlsMap: Record<number, string[]> = {};
  for (const l of userLvlsRes.rows as Array<{ user_id: number; access_level_id: string }>) {
    const uid = Number(l.user_id);
    userLvlsMap[uid] = userLvlsMap[uid] || [];
    userLvlsMap[uid].push(l.access_level_id);
  }

  return {
    users: rows.map((r) => mapUserRow(r, refMap, gsMap, userLvlsMap)),
    total,
    pages,
    levels,
    rooms
  };
}
