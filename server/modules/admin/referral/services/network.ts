/**
 * Resolução de utilizador/rede de referral (indicador ↔ indicados) — lookup,
 * cadeia de uplines, estatísticas da rede indicada, bloqueio em massa.
 *
 * Migrado de legacy/backend/controllers/adminReferralController.ts (funções de
 * rede — a parte de relatório/comissões fica em `./report.ts`).
 */
import { prisma } from '../../../../core/database/prisma.js';
import { asNum } from './format.js';

const LOOKUP_QUERIES_MAX = 50;
const REFERRER_CHAIN_MAX_DEPTH = 10;
const NETWORK_ROWS_PREVIEW_MAX = 100;

export type ReferralUserRow = {
  id: number;
  username: string | null;
  email: string | null;
  referral_code: string | null;
  referred_by: string | null;
};

export type ReferralUserBrief = { id: number; username: string | null; email: string | null; referralCode: string | null };

export function parseLookupQueries(raw: unknown): string[] {
  if (raw == null) return [];
  const s = String(raw).trim();
  if (!s) return [];
  return [
    ...new Set(
      s
        .split(/[\n,;]+/)
        .map((x) => x.trim())
        .filter(Boolean)
    )
  ].slice(0, LOOKUP_QUERIES_MAX);
}

export function toReferralUserBrief(row: ReferralUserRow | null | undefined): ReferralUserBrief | null {
  if (!row) return null;
  return { id: Number(row.id), username: row.username ?? null, email: row.email ?? null, referralCode: row.referral_code ?? null };
}

export async function findUserByLookupToken(token: string): Promise<ReferralUserRow | null> {
  const t = token.trim();
  if (!t) return null;
  const byId = /^\d+$/.test(t) ? Number(t) : null;
  const rows = await prisma.$queryRaw<ReferralUserRow[]>`
    SELECT id, username, email, referral_code, referred_by
      FROM users
     WHERE (${byId}::int IS NOT NULL AND id = ${byId})
        OR LOWER(username) = LOWER(${t})
        OR LOWER(email) = LOWER(${t})
     ORDER BY id ASC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function resolveReferrerUser(referredBy: string | null): Promise<ReferralUserRow | null> {
  const key = referredBy?.trim();
  if (!key) return null;
  const rows = await prisma.$queryRaw<ReferralUserRow[]>`
    SELECT id, username, email, referral_code, referred_by
      FROM users
     WHERE username = ${key} OR referral_code = ${key}
     ORDER BY id ASC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function buildReferrerChain(user: ReferralUserRow, maxDepth: number = REFERRER_CHAIN_MAX_DEPTH): Promise<ReferralUserBrief[]> {
  const chain: ReferralUserBrief[] = [];
  const seen = new Set<number>([Number(user.id)]);
  let cursor: ReferralUserRow | null = user;
  for (let depth = 0; depth < maxDepth; depth++) {
    const refKey = cursor?.referred_by?.trim();
    if (!refKey) break;
    const referrer = await resolveReferrerUser(refKey);
    if (!referrer || seen.has(Number(referrer.id))) break;
    const brief = toReferralUserBrief(referrer);
    if (brief) chain.push(brief);
    seen.add(Number(referrer.id));
    cursor = referrer;
  }
  return chain;
}

export async function resolveNetworkTarget(body: { userId?: unknown; email?: unknown; username?: unknown }): Promise<ReferralUserRow | null> {
  const userId = body.userId != null ? String(body.userId).trim() : '';
  if (userId) {
    const u = await findUserByLookupToken(userId);
    if (u) return u;
  }
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (email) {
    const u = await findUserByLookupToken(email);
    if (u) return u;
  }
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (username) {
    const u = await findUserByLookupToken(username);
    if (u) return u;
  }
  return null;
}

export type ReferredNetworkStats = { rows: ReferralUserRow[]; linkCount: number; resolvableCount: number; orphanLinkCount: number };

export async function getReferredNetworkStats(referrerUserId: number): Promise<ReferredNetworkStats> {
  const rows = await prisma.$queryRaw<ReferralUserRow[]>`
    WITH from_links AS (
      SELECT DISTINCT u.id, u.username, u.email, u.referral_code, u.referred_by
      FROM referrals r
      JOIN users u ON LOWER(TRIM(u.username)) = LOWER(TRIM(r.referred_username))
      WHERE r.user_id = ${referrerUserId}
    ),
    from_email AS (
      SELECT DISTINCT u.id, u.username, u.email, u.referral_code, u.referred_by
      FROM referrals r
      JOIN users u ON u.email IS NOT NULL AND LOWER(TRIM(u.email)) = LOWER(TRIM(r.referred_username))
      WHERE r.user_id = ${referrerUserId}
    ),
    from_referred_by AS (
      SELECT DISTINCT u.id, u.username, u.email, u.referral_code, u.referred_by
      FROM users u
      JOIN users ref ON ref.id = ${referrerUserId}
      WHERE u.referred_by = ref.referral_code OR u.referred_by = ref.username
    ),
    merged AS (
      SELECT * FROM from_links
      UNION
      SELECT * FROM from_email
      UNION
      SELECT * FROM from_referred_by
    )
    SELECT id, username, email, referral_code, referred_by
    FROM merged
    ORDER BY id ASC
  `;

  const countRows = await prisma.$queryRaw<Array<{ link_count: number | string | bigint | null; orphan_links: number | string | bigint | null }>>`
    SELECT
      (SELECT COUNT(*)::int FROM referrals WHERE user_id = ${referrerUserId}) AS link_count,
      (SELECT COUNT(*)::int
         FROM referrals r
        WHERE r.user_id = ${referrerUserId}
          AND NOT EXISTS (
            SELECT 1 FROM users u
             WHERE LOWER(TRIM(u.username)) = LOWER(TRIM(r.referred_username))
                OR (u.email IS NOT NULL AND LOWER(TRIM(u.email)) = LOWER(TRIM(r.referred_username)))
          )) AS orphan_links
  `;

  const c = countRows[0] || {};
  return { rows, linkCount: asNum(c.link_count), resolvableCount: rows.length, orphanLinkCount: asNum(c.orphan_links) };
}

export async function listAllReferredUsers(referrerUserId: number): Promise<ReferralUserRow[]> {
  const stats = await getReferredNetworkStats(referrerUserId);
  return stats.rows;
}

export type BlockReferralNetworkResult = {
  ok: true;
  blockedCount: number;
  referredLinkCount: number;
  resolvableCount: number;
  orphanLinkCount: number;
  referrer: ReferralUserBrief | null;
  referred: ReferralUserBrief[];
} | { ok: false; error: string };

/** Bloqueia o indicador e todos os indicados directos (só `is_blocked = 1`, não apaga nada). */
export async function blockReferralNetwork(targetLookup: { userId?: unknown; email?: unknown; username?: unknown }): Promise<BlockReferralNetworkResult> {
  const target = await resolveNetworkTarget(targetLookup);
  if (!target) {
    return { ok: false, error: 'Utilizador não encontrado.' };
  }

  const referred = await listAllReferredUsers(Number(target.id));
  const network = await getReferredNetworkStats(Number(target.id));
  const ids = [Number(target.id), ...referred.map((r) => Number(r.id))];

  await prisma.users.updateMany({ where: { id: { in: ids } }, data: { is_blocked: 1 } });

  return {
    ok: true,
    blockedCount: ids.length,
    referredLinkCount: network.linkCount,
    resolvableCount: network.resolvableCount,
    orphanLinkCount: network.orphanLinkCount,
    referrer: toReferralUserBrief(target),
    referred: referred.map((r) => toReferralUserBrief(r)).filter((x): x is ReferralUserBrief => x != null)
  };
}

export { NETWORK_ROWS_PREVIEW_MAX };
