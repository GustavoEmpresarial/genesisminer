/**
 * GET /api/admin/security/stats + blacklist add/remove.
 * Semântica do legado (`legacy/backend/server.ts`). Não altera saldos.
 */
import type { Pool, PoolClient } from 'pg';
import { prisma } from '../../../../core/database/prisma.js';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import { isUsefulSecurityScanIp } from './scan-ip.js';

const HTTP_BAD_REQUEST = 400;
const IP_MAX = 64;
const REASON_MAX = 500;
const ACCESS_LOGS_LIMIT = 100;
const DEFAULT_REASON = 'Banned by Admin';

export const SECURITY_STATS_SECTIONS = [
  'multiAccounts',
  'historyMultiAccounts',
  'sharedRegistrationIps',
  'sharedDeviceIps',
  'sharedFingerprints',
  'suspectedAutoReferrals',
  'accessLogs',
  'blacklist'
] as const;

export type SecurityStatsSection = (typeof SECURITY_STATS_SECTIONS)[number];

export type SecurityStatsDto = {
  multiAccounts: unknown[];
  historyMultiAccounts: unknown[];
  sharedRegistrationIps: unknown[];
  sharedDeviceIps: unknown[];
  sharedFingerprints: unknown[];
  suspectedAutoReferrals: unknown[];
  accessLogs: unknown[];
  blacklist: unknown[];
  blockedUsers: unknown[];
};

function emptyStats(): SecurityStatsDto {
  return {
    multiAccounts: [],
    historyMultiAccounts: [],
    sharedRegistrationIps: [],
    sharedDeviceIps: [],
    sharedFingerprints: [],
    suspectedAutoReferrals: [],
    accessLogs: [],
    blacklist: [],
    blockedUsers: []
  };
}

function parseSection(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function wants(sectionRaw: string, name: string): boolean {
  const loadAll = sectionRaw.length === 0 || sectionRaw === 'all';
  return loadAll || sectionRaw === name;
}

function mapAccessLogRow(r: {
  id: number;
  ip: string;
  attempted_url: string;
  user_agent: string | null;
  details: string | null;
  created_at: bigint | number;
}): Record<string, unknown> {
  return {
    id: r.id,
    ip: r.ip,
    attempted_url: r.attempted_url,
    user_agent: r.user_agent ?? undefined,
    details: r.details ?? undefined,
    created_at: Number(r.created_at)
  };
}

export function parseBlacklistIp(raw: unknown): string {
  if (raw == null || raw === false) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'IP requerido' });
  }
  const ip = String(raw).trim();
  if (!ip || ip.length > IP_MAX) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'IP requerido' });
  }
  return ip;
}

function parseReason(raw: unknown): string {
  if (raw == null || raw === '') return DEFAULT_REASON;
  const s = String(raw).trim();
  if (!s) return DEFAULT_REASON;
  return s.length > REASON_MAX ? s.slice(0, REASON_MAX) : s;
}

export async function addIpToBlacklist(input: { ip: unknown; reason?: unknown }): Promise<{ ok: true }> {
  const ipStr = parseBlacklistIp(input.ip);
  const reason = parseReason(input.reason);
  const at = BigInt(Date.now());
  await prisma.ip_blacklist.upsert({
    where: { ip: ipStr },
    create: { ip: ipStr, reason, added_at: at },
    update: { reason }
  });
  return { ok: true };
}

export async function removeIpFromBlacklist(ipRaw: unknown): Promise<{ ok: true }> {
  const ipStr = parseBlacklistIp(ipRaw);
  await prisma.ip_blacklist.deleteMany({ where: { ip: ipStr } });
  return { ok: true };
}

type LinkedUser = { id: number; username: string; email: string; vias: string[] };

async function loadBlacklistPayload(client: PoolClient): Promise<{ blacklist: unknown[]; blockedUsers: unknown[] }> {
  const blockedUsersRes = await client.query(`
      SELECT
        u.id,
        u.username,
        u.email,
        u.registration_ip AS "registrationIp",
        NULL::bigint AS "blockedAt"
      FROM users u
      WHERE COALESCE(u.is_blocked, 0) <> 0
      ORDER BY u.id DESC
    `);
  const blockedUsers = blockedUsersRes.rows.map((row: Record<string, unknown>) => ({
    id: Number(row.id) || 0,
    username: String(row.username || ''),
    email: String(row.email || ''),
    registrationIp: row.registrationIp != null ? String(row.registrationIp) : null,
    blockedAt: row.blockedAt != null ? Number(row.blockedAt) : null
  }));

  const blPrisma = await prisma.ip_blacklist.findMany({ orderBy: { added_at: 'desc' } });
  const blRows = blPrisma.map((r) => ({
    ip: r.ip,
    reason: r.reason,
    added_at: Number(r.added_at)
  }));
  const ipKeys = [...new Set(blRows.map((r) => String(r.ip ?? '').trim()).filter((x) => x.length > 0))];
  const linkedByIpNorm = new Map<string, LinkedUser[]>();
  if (ipKeys.length > 0) {
    const linkRes = await client.query(
      `WITH ips AS (SELECT DISTINCT unnest($1::text[]) AS raw_ip)
           SELECT lower(trim(ips.raw_ip::text)) AS ip_norm, u.id, u.username::text AS username, u.email::text AS email, 'registro'::text AS via
           FROM ips
           INNER JOIN users u ON u.registration_ip IS NOT NULL
             AND lower(trim(u.registration_ip::text)) = lower(trim(ips.raw_ip::text))
           UNION ALL
           SELECT lower(trim(ips.raw_ip::text)), u.id, u.username::text, u.email::text, 'hist_login'::text
           FROM ips
           INNER JOIN user_history_ips h ON lower(trim(h.ip::text)) = lower(trim(ips.raw_ip::text))
           INNER JOIN users u ON u.id = h.user_id`,
      [ipKeys]
    );
    for (const row of linkRes.rows as Array<{ ip_norm?: string; id?: unknown; username?: string; email?: string; via?: string }>) {
      const k = String(row.ip_norm || '')
        .trim()
        .toLowerCase();
      if (!k) continue;
      if (!linkedByIpNorm.has(k)) linkedByIpNorm.set(k, []);
      const arr = linkedByIpNorm.get(k)!;
      const idNum = Number(row.id);
      let ex = arr.find((x) => x.id === idNum);
      if (!ex) {
        ex = { id: idNum, username: String(row.username || ''), email: String(row.email || ''), vias: [] };
        arr.push(ex);
      }
      const via = String(row.via || '');
      if (via && !ex.vias.includes(via)) ex.vias.push(via);
    }
  }
  const blacklist = blRows.map((row) => {
    const ipStr = String(row.ip ?? '').trim();
    const norm = ipStr.toLowerCase();
    return { ...row, linkedUsers: linkedByIpNorm.get(norm) || [] };
  });
  return { blacklist, blockedUsers };
}

export async function loadSecurityStats(pool: Pool, sectionRawUnknown: unknown): Promise<SecurityStatsDto> {
  const sectionRaw = parseSection(sectionRawUnknown);
  const out = emptyStats();
  const client = await pool.connect();
  try {
    if (wants(sectionRaw, 'multiAccounts')) {
      const multiAccountsRes = await client.query(`
      SELECT registration_ip, COUNT(*) as account_count, 
             array_agg(username) as usernames, 
             array_agg(email) as emails,
             array_agg(id) as ids
      FROM users 
      WHERE registration_ip IS NOT NULL
      GROUP BY registration_ip
      HAVING COUNT(*) > 1
      ORDER BY account_count DESC
    `);
      out.multiAccounts = multiAccountsRes.rows.filter((row) =>
        isUsefulSecurityScanIp(String((row as { registration_ip?: unknown }).registration_ip ?? ''))
      );
    }

    if (wants(sectionRaw, 'historyMultiAccounts')) {
      const historyMultiAccountsRes = await client.query(`
      SELECT ip, COUNT(DISTINCT user_id) as user_count,
             array_agg(DISTINCT u.username) as usernames,
             array_agg(DISTINCT u.email) as emails
      FROM user_history_ips h
      JOIN users u ON h.user_id = u.id
      GROUP BY ip
      HAVING COUNT(DISTINCT user_id) > 1
      ORDER BY user_count DESC
    `);
      out.historyMultiAccounts = historyMultiAccountsRes.rows.filter((row) =>
        isUsefulSecurityScanIp(String((row as { ip?: unknown }).ip ?? ''))
      );
    }

    if (wants(sectionRaw, 'sharedRegistrationIps')) {
      const sharedRegistrationIpsRes = await client.query(`
      SELECT
        registration_ip AS ip,
        COUNT(*)::int AS user_count,
        json_agg(
          json_build_object(
            'id', id,
            'username', username,
            'email', email,
            'registrationIp', registration_ip,
            'lastUsedAt', NULL,
            'isBlocked', COALESCE(is_blocked, 0) <> 0
          )
          ORDER BY id
        ) AS users
      FROM users
      WHERE registration_ip IS NOT NULL
        AND length(trim(registration_ip)) > 0
      GROUP BY registration_ip
      HAVING COUNT(*) > 1
      ORDER BY user_count DESC, registration_ip ASC
    `);
      out.sharedRegistrationIps = sharedRegistrationIpsRes.rows
        .map((row: Record<string, unknown>) => ({
          ip: String(row.ip || ''),
          userCount: Number(row.user_count) || 0,
          users: Array.isArray(row.users) ? row.users : []
        }))
        .filter((row) => isUsefulSecurityScanIp(row.ip));
    }

    if (wants(sectionRaw, 'sharedDeviceIps')) {
      const sharedDeviceIpsRes = await client.query(`
      SELECT
        h.ip,
        COUNT(DISTINCT h.user_id)::int AS user_count,
        MAX(h.last_used_at) AS last_seen_at,
        json_agg(
          DISTINCT jsonb_build_object(
            'id', u.id,
            'username', u.username,
            'email', u.email,
            'registrationIp', u.registration_ip,
            'lastUsedAt', h.last_used_at,
            'isBlocked', COALESCE(u.is_blocked, 0) <> 0
          )
        ) AS users
      FROM user_history_ips h
      JOIN users u ON u.id = h.user_id
      WHERE h.ip IS NOT NULL
        AND length(trim(h.ip)) > 0
      GROUP BY h.ip
      HAVING COUNT(DISTINCT h.user_id) > 1
      ORDER BY user_count DESC, MAX(h.last_used_at) DESC NULLS LAST, h.ip ASC
    `);
      out.sharedDeviceIps = sharedDeviceIpsRes.rows
        .map((row: Record<string, unknown>) => ({
          ip: String(row.ip || ''),
          userCount: Number(row.user_count) || 0,
          lastSeenAt: row.last_seen_at != null ? Number(row.last_seen_at) : null,
          users: Array.isArray(row.users) ? row.users : []
        }))
        .filter((row) => isUsefulSecurityScanIp(row.ip));
    }

    if (wants(sectionRaw, 'sharedFingerprints')) {
      const sharedFingerprintsRes = await client.query(`
      SELECT
        d.fingerprint_hash,
        COUNT(DISTINCT d.user_id)::int AS user_count,
        MAX(d.created_at) AS last_seen_at,
        json_agg(
          DISTINCT jsonb_build_object(
            'id', u.id,
            'username', u.username,
            'email', u.email,
            'lastIp', d.ip,
            'lastSeenAt', d.created_at
          )
        ) AS users
      FROM device_fingerprint_logs d
      JOIN users u ON u.id = d.user_id
      WHERE d.fingerprint_hash IS NOT NULL
        AND length(trim(d.fingerprint_hash)) > 0
      GROUP BY d.fingerprint_hash
      HAVING COUNT(DISTINCT d.user_id) > 1
      ORDER BY user_count DESC, MAX(d.created_at) DESC NULLS LAST
    `);
      out.sharedFingerprints = sharedFingerprintsRes.rows.map((row: Record<string, unknown>) => ({
        fingerprintHash: String(row.fingerprint_hash || ''),
        userCount: Number(row.user_count) || 0,
        lastSeenAt: row.last_seen_at != null ? Number(row.last_seen_at) : null,
        users: Array.isArray(row.users) ? row.users : []
      }));
    }

    if (wants(sectionRaw, 'suspectedAutoReferrals')) {
      const suspectedAutoRefsRes = await client.query(`
      SELECT 
        u1.id as referrer_id, u1.username as referrer_username, u1.registration_ip as referrer_ip,
        u2.id as referred_id, u2.username as referred_username, u2.registration_ip as referred_ip
      FROM referrals r
      JOIN users u1 ON r.user_id = u1.id
      JOIN users u2 ON r.referred_username = u2.username
      WHERE u1.registration_ip = u2.registration_ip
      OR EXISTS (
        SELECT 1 FROM user_history_ips h1 
        JOIN user_history_ips h2 ON h1.ip = h2.ip
        WHERE h1.user_id = u1.id AND h2.user_id = u2.id
      )
    `);
      out.suspectedAutoReferrals = suspectedAutoRefsRes.rows;
    }

    if (wants(sectionRaw, 'accessLogs')) {
      const logs = await prisma.admin_access_logs.findMany({
        orderBy: { created_at: 'desc' },
        take: ACCESS_LOGS_LIMIT
      });
      out.accessLogs = logs.map(mapAccessLogRow);
    }

    if (wants(sectionRaw, 'blacklist')) {
      const packed = await loadBlacklistPayload(client);
      out.blacklist = packed.blacklist;
      out.blockedUsers = packed.blockedUsers;
    }

    return out;
  } finally {
    client.release();
  }
}
