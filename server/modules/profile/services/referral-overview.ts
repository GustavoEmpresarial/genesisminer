/**
 * Visão completa do programa de indicações para o utilizador autenticado — só leitura
 * (`users`, `referrals`, `referral_commission_ledger`), sem escrita.
 *
 * Migrado de legacy/backend/modules/profile/profileReferralOverview.service.ts (sem
 * mudança de comportamento — é read-only, não tem a questão de economia dos outros
 * services deste módulo).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../../core/database/prisma.js';

/** Comissão fixa sobre depósitos USDC validados (indicador recebe % do valor creditado ao indicado). */
export const REFERRAL_DEPOSIT_COMMISSION_PERCENT = 5;
const PERCENT_TO_RATE = 100;
const SOURCE_TRANSACTION_ID_MAX_CHARS = 240;

type CommissionRow = {
  id: string;
  created_at: string | number | bigint | null;
  referred_user_id: number;
  base_amount_usdc: number | string | null;
  commission_percent: number | string | null;
  commission_usdc: number | string | null;
  source_type: string | null;
  idempotency_key: string;
  referred_username: string | null;
  referred_email: string | null;
};

type ReferredRow = {
  referred_user_id: number;
  username: string | null;
  email: string | null;
  link_id: number | string | bigint | null;
  first_commission_at: number | string | bigint | null;
  total_deposit_usdc: number | string | null;
  total_commission_usdc: number | string | null;
  commissions_count: number | string | bigint | null;
};

function toNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toMs(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const EMAIL_MASK_VISIBLE_CHARS = 2;

function maskEmail(email: string | null | undefined): string | null {
  const t = String(email ?? '').trim().toLowerCase();
  if (!t || !t.includes('@')) return null;
  const [local, domain] = t.split('@');
  if (!local || !domain) return null;
  const visible = local.slice(0, Math.min(EMAIL_MASK_VISIBLE_CHARS, local.length));
  return `${visible}${'*'.repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

export type ReferralOverview = {
  ok: true;
  referralCode: string | null;
  inviteUrl: string | null;
  referredBy: string | null;
  stats: {
    invitedCount: number;
    totalReferredDepositsUsdc: number;
    totalCommissionUsdc: number;
    paidCommissionUsdc: number;
    pendingCommissionUsdc: number;
    commissionRate: number;
    commissionPercent: number;
    commissionsCount: number;
  };
  referredUsers: Array<{
    id: number;
    username: string | null;
    emailMasked: string | null;
    createdAt: number;
    linkId: number;
    totalDepositedUsdc: number;
    totalCommissionUsdc: number;
    commissionsCount: number;
  }>;
  commissions: Array<{
    id: string;
    createdAt: number;
    referredUser: { id: number; username: string | null; emailMasked: string | null };
    depositAmountUsdc: number;
    commissionRate: number;
    commissionAmountUsdc: number;
    sourceType: string;
    sourceTransactionId: string;
    status: 'paid';
  }>;
};

const OVERVIEW_HISTORY_LIMIT_MIN = 10;
const OVERVIEW_HISTORY_LIMIT_MAX = 200;
const OVERVIEW_HISTORY_LIMIT_DEFAULT = 50;

/**
 * Toda comissão no ledger é creditada na mesma transação que o depósito (ver
 * `creditDepositReferralCommissionPg`, ainda não migrado), então cada linha conta
 * como `paid`. `pendingCommissionUsdc=0` por contrato.
 */
export async function buildReferralOverview(input: {
  userId: number;
  inviteBaseUrl: string;
  historyLimit?: number;
}): Promise<ReferralOverview> {
  const uid = Number(input.userId);
  if (!Number.isFinite(uid) || uid <= 0) {
    throw new Error('uid inválido em buildReferralOverview');
  }
  const limit = Math.min(OVERVIEW_HISTORY_LIMIT_MAX, Math.max(OVERVIEW_HISTORY_LIMIT_MIN, Number(input.historyLimit) || OVERVIEW_HISTORY_LIMIT_DEFAULT));

  const userRow = await prisma.users.findUnique({
    where: { id: uid },
    select: { id: true, username: true, referral_code: true, referred_by: true }
  });

  const referralCode = userRow?.referral_code ?? null;
  const base = String(input.inviteBaseUrl || '').replace(/\/+$/, '');
  const inviteUrl =
    referralCode && base
      ? `${base}/registro?ref=${encodeURIComponent(referralCode)}`
      : referralCode
        ? `/registro?ref=${encodeURIComponent(referralCode)}`
        : null;

  const [referredRows, commissionRows] = await Promise.all([
    // Subqueries independentes evitam duplicação se houver >1 linha em `referrals`
    // pro mesmo (user_id, referred_username) — senão o JOIN multiplica os SUM().
    prisma.$queryRaw<ReferredRow[]>(Prisma.sql`
      SELECT
        u.id                                AS referred_user_id,
        u.username                          AS username,
        u.email                             AS email,
        rl.link_id                          AS link_id,
        cm.first_commission_at              AS first_commission_at,
        COALESCE(cm.total_deposit, 0)::float8    AS total_deposit_usdc,
        COALESCE(cm.total_commission, 0)::float8 AS total_commission_usdc,
        COALESCE(cm.commissions_count, 0)        AS commissions_count
      FROM users u
      JOIN (
        SELECT referred_username, MIN(id) AS link_id
        FROM referrals
        WHERE user_id = ${uid}
        GROUP BY referred_username
      ) rl ON rl.referred_username = u.username
      LEFT JOIN (
        SELECT
          referred_user_id,
          MIN(created_at)                         AS first_commission_at,
          SUM(base_amount_usdc)                   AS total_deposit,
          SUM(commission_usdc)                    AS total_commission,
          COUNT(id)                               AS commissions_count
        FROM referral_commission_ledger
        WHERE referrer_user_id = ${uid}
        GROUP BY referred_user_id
      ) cm ON cm.referred_user_id = u.id
      ORDER BY rl.link_id DESC
    `),
    prisma.$queryRaw<CommissionRow[]>(Prisma.sql`
      SELECT
        l.id::text                AS id,
        l.created_at              AS created_at,
        l.referred_user_id        AS referred_user_id,
        l.base_amount_usdc        AS base_amount_usdc,
        l.commission_percent      AS commission_percent,
        l.commission_usdc         AS commission_usdc,
        l.source_type             AS source_type,
        l.idempotency_key         AS idempotency_key,
        u.username                AS referred_username,
        u.email                   AS referred_email
      FROM referral_commission_ledger l
      LEFT JOIN users u ON u.id = l.referred_user_id
      WHERE l.referrer_user_id = ${uid}
      ORDER BY l.created_at DESC
      LIMIT ${limit}
    `)
  ]);

  const referredUsers = referredRows.map((row) => ({
    id: Number(row.referred_user_id),
    username: row.username ?? null,
    emailMasked: maskEmail(row.email),
    createdAt: toMs(row.first_commission_at),
    linkId: Number(row.link_id ?? 0),
    totalDepositedUsdc: toNum(row.total_deposit_usdc),
    totalCommissionUsdc: toNum(row.total_commission_usdc),
    commissionsCount: toNum(row.commissions_count)
  }));

  const commissions = commissionRows.map((row) => ({
    id: row.id,
    createdAt: toMs(row.created_at),
    referredUser: {
      id: Number(row.referred_user_id),
      username: row.referred_username ?? null,
      emailMasked: maskEmail(row.referred_email)
    },
    depositAmountUsdc: toNum(row.base_amount_usdc),
    commissionRate: toNum(row.commission_percent) / PERCENT_TO_RATE,
    commissionAmountUsdc: toNum(row.commission_usdc),
    sourceType: String(row.source_type ?? 'deposit'),
    sourceTransactionId: String(row.idempotency_key ?? '').slice(0, SOURCE_TRANSACTION_ID_MAX_CHARS),
    status: 'paid' as const
  }));

  const totalReferredDepositsUsdc = referredUsers.reduce((acc, u) => acc + u.totalDepositedUsdc, 0);
  const totalCommissionUsdc = referredUsers.reduce((acc, u) => acc + u.totalCommissionUsdc, 0);
  const commissionsCount = referredUsers.reduce((acc, u) => acc + u.commissionsCount, 0);

  return {
    ok: true,
    referralCode,
    inviteUrl,
    referredBy: userRow?.referred_by ?? null,
    stats: {
      invitedCount: referredUsers.length,
      totalReferredDepositsUsdc,
      totalCommissionUsdc,
      paidCommissionUsdc: totalCommissionUsdc,
      pendingCommissionUsdc: 0,
      commissionRate: REFERRAL_DEPOSIT_COMMISSION_PERCENT / PERCENT_TO_RATE,
      commissionPercent: REFERRAL_DEPOSIT_COMMISSION_PERCENT,
      commissionsCount
    },
    referredUsers,
    commissions
  };
}
