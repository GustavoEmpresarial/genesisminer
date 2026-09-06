/**
 * Relatórios admin do programa de referral: resumo, histórico paginado de
 * comissões, vínculos indicador↔indicado, export CSV.
 *
 * Apenas leitura — a API admin não permite ajustar comissões (decisão
 * consciente do legado: se preciso, fluxo dedicado e auditado).
 *
 * Migrado de legacy/backend/controllers/adminReferralController.ts (parte de
 * relatório — rede/lookup fica em `./network.ts`).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../core/database/prisma.js';
import { REFERRAL_DEPOSIT_COMMISSION_PERCENT } from '../../../profile/services/referral-overview.js';
import { asNum, csvCell, toMs } from './format.js';

const TOP_REFERRERS_LIMIT = 10;
const EXPORT_ROWS_LIMIT = 50_000;
const PERCENT_TO_RATE_DIVISOR = 100;
const BASE_AMOUNT_DECIMALS = 8;
const COMMISSION_PERCENT_DECIMALS = 4;

export type ReferralSummary = {
  ok: true;
  commissionPercent: number;
  commissionRate: number;
  stats: {
    uniqueReferrers: number;
    totalLinks: number;
    referredDistinct: number;
    commissionsCount: number;
    totalReferredDepositsUsdc: number;
    totalCommissionPaidUsdc: number;
    pendingCommissionUsdc: number;
  };
  topReferrers: Array<{ id: number; username: string | null; email: string | null; invitedCount: number; commissionTotalUsdc: number }>;
};

export async function buildReferralSummary(): Promise<ReferralSummary> {
  const [overall, distinct, topReferrers] = await Promise.all([
    prisma.$queryRaw<Array<{ commission_count: bigint | number | string | null; base_total: number | string | null; commission_total: number | string | null }>>`
      SELECT
          COUNT(*)                                     AS commission_count,
          COALESCE(SUM(base_amount_usdc), 0)::float8   AS base_total,
          COALESCE(SUM(commission_usdc), 0)::float8    AS commission_total
        FROM referral_commission_ledger
    `,
    prisma.$queryRaw<Array<{ unique_referrers: bigint | number | string | null; total_links: bigint | number | string | null; referred_distinct: bigint | number | string | null }>>`
      SELECT
          COUNT(DISTINCT user_id)                       AS unique_referrers,
          COUNT(*)                                      AS total_links,
          COUNT(DISTINCT referred_username)             AS referred_distinct
        FROM referrals
    `,
    // ATENÇÃO: não fazer `LEFT JOIN referrals + LEFT JOIN referral_commission_ledger` no
    // mesmo SELECT — gera produto cartesiano e infla `SUM(commission_usdc)` por N (já
    // causou bug de produção onde um indicador com 800 vínculos parecia ter recebido
    // um total muito maior do que o real). Subqueries agregadas independentes por user_id.
    prisma.$queryRaw<Array<{ referrer_user_id: number; username: string | null; email: string | null; invited_count: bigint | number | string | null; commission_total: number | string | null }>>`
      SELECT
          u.id                                            AS referrer_user_id,
          u.username                                      AS username,
          u.email                                         AS email,
          COALESCE(inv.invited_count, 0)                  AS invited_count,
          COALESCE(cm.commission_total, 0)::float8        AS commission_total
        FROM users u
        JOIN (
          SELECT user_id, COUNT(DISTINCT referred_username) AS invited_count
          FROM referrals
          GROUP BY user_id
        ) inv ON inv.user_id = u.id
        LEFT JOIN (
          SELECT referrer_user_id, SUM(commission_usdc) AS commission_total
          FROM referral_commission_ledger
          GROUP BY referrer_user_id
        ) cm ON cm.referrer_user_id = u.id
        WHERE COALESCE(inv.invited_count, 0) > 0
        ORDER BY commission_total DESC NULLS LAST, invited_count DESC NULLS LAST
        LIMIT ${TOP_REFERRERS_LIMIT}
    `
  ]);

  const o = overall[0] || ({} as Record<string, unknown>);
  const d = distinct[0] || ({} as Record<string, unknown>);

  return {
    ok: true,
    commissionPercent: REFERRAL_DEPOSIT_COMMISSION_PERCENT,
    commissionRate: REFERRAL_DEPOSIT_COMMISSION_PERCENT / PERCENT_TO_RATE_DIVISOR,
    stats: {
      uniqueReferrers: asNum(d.unique_referrers),
      totalLinks: asNum(d.total_links),
      referredDistinct: asNum(d.referred_distinct),
      commissionsCount: asNum(o.commission_count),
      totalReferredDepositsUsdc: asNum(o.base_total),
      totalCommissionPaidUsdc: asNum(o.commission_total),
      pendingCommissionUsdc: 0
    },
    topReferrers: topReferrers.map((row) => ({
      id: Number(row.referrer_user_id),
      username: row.username ?? null,
      email: row.email ?? null,
      invitedCount: asNum(row.invited_count),
      commissionTotalUsdc: asNum(row.commission_total)
    }))
  };
}

export type CommissionsFilters = {
  page: number;
  limit: number;
  startMs: number | null;
  endMs: number | null;
  referrer: string;
  referred: string;
  minCommission: number;
  maxCommission: number;
  q: string;
};

function buildCommissionsWhere(f: CommissionsFilters): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  if (Number.isFinite(f.startMs)) clauses.push(Prisma.sql`l.created_at >= ${f.startMs}`);
  if (Number.isFinite(f.endMs)) clauses.push(Prisma.sql`l.created_at <= ${f.endMs}`);
  if (f.referrer) {
    const r = f.referrer.toLowerCase();
    clauses.push(Prisma.sql`(LOWER(ur.username) = ${r} OR LOWER(ur.email) = ${r} OR (CASE WHEN ur.id::text = ${r} THEN TRUE ELSE FALSE END))`);
  }
  if (f.referred) {
    const r = f.referred.toLowerCase();
    clauses.push(Prisma.sql`(LOWER(ud.username) = ${r} OR LOWER(ud.email) = ${r} OR (CASE WHEN ud.id::text = ${r} THEN TRUE ELSE FALSE END))`);
  }
  if (Number.isFinite(f.minCommission)) clauses.push(Prisma.sql`l.commission_usdc >= ${f.minCommission}`);
  if (Number.isFinite(f.maxCommission)) clauses.push(Prisma.sql`l.commission_usdc <= ${f.maxCommission}`);
  if (f.q) {
    const like = `%${f.q.toLowerCase()}%`;
    clauses.push(
      Prisma.sql`(LOWER(COALESCE(ur.username,'')) LIKE ${like} OR LOWER(COALESCE(ur.email,'')) LIKE ${like} OR LOWER(COALESCE(ud.username,'')) LIKE ${like} OR LOWER(COALESCE(ud.email,'')) LIKE ${like} OR LOWER(COALESCE(l.idempotency_key,'')) LIKE ${like})`
    );
  }
  return clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}` : Prisma.empty;
}

type CommissionRawRow = {
  id: string;
  created_at: number | string | bigint | null;
  idempotency_key: string;
  source_type: string | null;
  base_amount_usdc: number | string | null;
  commission_percent: number | string | null;
  commission_usdc: number | string | null;
  referrer_user_id: number;
  referrer_username: string | null;
  referrer_email: string | null;
  referred_user_id: number;
  referred_username: string | null;
  referred_email: string | null;
};

export type CommissionRow = {
  id: string;
  createdAt: number;
  sourceType: string;
  sourceTransactionId: string;
  depositAmountUsdc: number;
  commissionPercent: number;
  commissionRate: number;
  commissionAmountUsdc: number;
  referrer: { id: number; username: string | null; email: string | null };
  referred: { id: number; username: string | null; email: string | null };
  status: 'paid';
};

function mapCommissionRow(r: CommissionRawRow): CommissionRow {
  return {
    id: r.id,
    createdAt: toMs(r.created_at),
    sourceType: String(r.source_type ?? 'deposit'),
    sourceTransactionId: String(r.idempotency_key ?? ''),
    depositAmountUsdc: asNum(r.base_amount_usdc),
    commissionPercent: asNum(r.commission_percent),
    commissionRate: asNum(r.commission_percent) / PERCENT_TO_RATE_DIVISOR,
    commissionAmountUsdc: asNum(r.commission_usdc),
    referrer: { id: Number(r.referrer_user_id), username: r.referrer_username ?? null, email: r.referrer_email ?? null },
    referred: { id: Number(r.referred_user_id), username: r.referred_username ?? null, email: r.referred_email ?? null },
    status: 'paid'
  };
}

/**
 * Histórico paginado de comissões. Hoje todas as linhas do ledger estão pagas
 * (créditos ocorrem na mesma transação do depósito) — `status` fica na resposta
 * por compatibilidade futura.
 */
export async function listReferralCommissions(f: CommissionsFilters): Promise<{ ok: true; page: number; limit: number; total: number; rows: CommissionRow[] }> {
  const where = buildCommissionsWhere(f);
  const offset = (f.page - 1) * f.limit;

  const totalRows = await prisma.$queryRaw<Array<{ total: bigint | number | string | null }>>`
    SELECT COUNT(*)::bigint AS total
      FROM referral_commission_ledger l
      LEFT JOIN users ur ON ur.id = l.referrer_user_id
      LEFT JOIN users ud ON ud.id = l.referred_user_id
      ${where}
  `;
  const total = asNum(totalRows[0]?.total);

  const rows = await prisma.$queryRaw<CommissionRawRow[]>`
    SELECT
        l.id::text                 AS id,
        l.created_at               AS created_at,
        l.idempotency_key          AS idempotency_key,
        l.source_type              AS source_type,
        l.base_amount_usdc         AS base_amount_usdc,
        l.commission_percent       AS commission_percent,
        l.commission_usdc          AS commission_usdc,
        l.referrer_user_id         AS referrer_user_id,
        ur.username                AS referrer_username,
        ur.email                   AS referrer_email,
        l.referred_user_id         AS referred_user_id,
        ud.username                AS referred_username,
        ud.email                   AS referred_email
      FROM referral_commission_ledger l
      LEFT JOIN users ur ON ur.id = l.referrer_user_id
      LEFT JOIN users ud ON ud.id = l.referred_user_id
      ${where}
      ORDER BY l.created_at DESC
      LIMIT ${f.limit} OFFSET ${offset}
  `;

  return { ok: true, page: f.page, limit: f.limit, total, rows: rows.map(mapCommissionRow) };
}

export type LinksFilters = { page: number; limit: number; q: string };

type LinkRawRow = {
  link_id: number;
  referrer_user_id: number;
  referrer_username: string | null;
  referrer_email: string | null;
  referred_username_raw: string | null;
  referred_user_id: number | null;
  referred_email: string | null;
  first_commission_at: number | string | bigint | null;
  total_deposit_usdc: number | string | null;
  total_commission_usdc: number | string | null;
};

export type LinkRow = {
  linkId: number;
  referrer: { id: number; username: string | null; email: string | null };
  referred: { id: number | null; username: string | null; email: string | null };
  firstCommissionAt: number;
  totalDepositedUsdc: number;
  totalCommissionUsdc: number;
};

/** Vínculos indicador↔indicado, com totais agregados (depósito, comissão). */
export async function listReferralLinks(f: LinksFilters): Promise<{ ok: true; page: number; limit: number; total: number; rows: LinkRow[] }> {
  const like = f.q ? `%${f.q.toLowerCase()}%` : null;
  const where = like
    ? Prisma.sql`WHERE (LOWER(COALESCE(ur.username,'')) LIKE ${like} OR LOWER(COALESCE(ur.email,'')) LIKE ${like} OR LOWER(COALESCE(ud.username,'')) LIKE ${like} OR LOWER(COALESCE(ud.email,'')) LIKE ${like})`
    : Prisma.empty;
  const offset = (f.page - 1) * f.limit;

  const totalRows = await prisma.$queryRaw<Array<{ total: bigint | number | string | null }>>`
    SELECT COUNT(*)::bigint AS total
      FROM referrals r
      JOIN users ur ON ur.id = r.user_id
      LEFT JOIN users ud ON ud.username = r.referred_username
      ${where}
  `;
  const total = asNum(totalRows[0]?.total);

  const rows = await prisma.$queryRaw<LinkRawRow[]>`
    SELECT
        r.id                                            AS link_id,
        r.user_id                                       AS referrer_user_id,
        ur.username                                     AS referrer_username,
        ur.email                                        AS referrer_email,
        r.referred_username                             AS referred_username_raw,
        ud.id                                           AS referred_user_id,
        ud.email                                        AS referred_email,
        MIN(l.created_at)                               AS first_commission_at,
        COALESCE(SUM(l.base_amount_usdc), 0)::float8    AS total_deposit_usdc,
        COALESCE(SUM(l.commission_usdc), 0)::float8     AS total_commission_usdc
      FROM referrals r
      JOIN users ur ON ur.id = r.user_id
      LEFT JOIN users ud ON ud.username = r.referred_username
      LEFT JOIN referral_commission_ledger l
        ON l.referrer_user_id = r.user_id AND l.referred_user_id = ud.id
      ${where}
      GROUP BY r.id, r.user_id, ur.username, ur.email, r.referred_username, ud.id, ud.email
      ORDER BY r.id DESC
      LIMIT ${f.limit} OFFSET ${offset}
  `;

  return {
    ok: true,
    page: f.page,
    limit: f.limit,
    total,
    rows: rows.map((r) => ({
      linkId: Number(r.link_id),
      referrer: { id: Number(r.referrer_user_id), username: r.referrer_username ?? null, email: r.referrer_email ?? null },
      referred: { id: r.referred_user_id != null ? Number(r.referred_user_id) : null, username: r.referred_username_raw ?? null, email: r.referred_email ?? null },
      firstCommissionAt: toMs(r.first_commission_at),
      totalDepositedUsdc: asNum(r.total_deposit_usdc),
      totalCommissionUsdc: asNum(r.total_commission_usdc)
    }))
  };
}

export type ExportFilters = { startMs: number | null; endMs: number | null; referrer: string; referred: string; q: string };

/** Exporta o histórico de comissões filtrado para CSV — tecto duro de 50k linhas (proteger memória). */
export async function buildReferralCommissionsCsv(f: ExportFilters): Promise<string> {
  const clauses: Prisma.Sql[] = [];
  if (Number.isFinite(f.startMs)) clauses.push(Prisma.sql`l.created_at >= ${f.startMs}`);
  if (Number.isFinite(f.endMs)) clauses.push(Prisma.sql`l.created_at <= ${f.endMs}`);
  if (f.referrer) {
    const r = f.referrer.toLowerCase();
    clauses.push(Prisma.sql`(LOWER(ur.username) = ${r} OR LOWER(ur.email) = ${r})`);
  }
  if (f.referred) {
    const r = f.referred.toLowerCase();
    clauses.push(Prisma.sql`(LOWER(ud.username) = ${r} OR LOWER(ud.email) = ${r})`);
  }
  if (f.q) {
    const like = `%${f.q.toLowerCase()}%`;
    clauses.push(Prisma.sql`(LOWER(COALESCE(ur.username,'')) LIKE ${like} OR LOWER(COALESCE(ud.username,'')) LIKE ${like} OR LOWER(COALESCE(l.idempotency_key,'')) LIKE ${like})`);
  }
  const where = clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}` : Prisma.empty;

  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      created_at: number | string | bigint | null;
      idempotency_key: string;
      source_type: string | null;
      base_amount_usdc: number | string | null;
      commission_percent: number | string | null;
      commission_usdc: number | string | null;
      referrer_username: string | null;
      referrer_email: string | null;
      referred_username: string | null;
      referred_email: string | null;
    }>
  >`
    SELECT
        l.id::text                 AS id,
        l.created_at               AS created_at,
        l.idempotency_key          AS idempotency_key,
        l.source_type              AS source_type,
        l.base_amount_usdc         AS base_amount_usdc,
        l.commission_percent       AS commission_percent,
        l.commission_usdc          AS commission_usdc,
        ur.username                AS referrer_username,
        ur.email                   AS referrer_email,
        ud.username                AS referred_username,
        ud.email                   AS referred_email
      FROM referral_commission_ledger l
      LEFT JOIN users ur ON ur.id = l.referrer_user_id
      LEFT JOIN users ud ON ud.id = l.referred_user_id
      ${where}
      ORDER BY l.created_at DESC
      LIMIT ${EXPORT_ROWS_LIMIT}
  `;

  const header = [
    'id',
    'created_at_iso',
    'created_at_ms',
    'source_type',
    'source_transaction_id',
    'referrer_username',
    'referrer_email',
    'referred_username',
    'referred_email',
    'deposit_usdc',
    'commission_percent',
    'commission_usdc',
    'status'
  ];
  const lines: string[] = [header.join(',')];
  for (const r of rows) {
    const ms = toMs(r.created_at);
    lines.push(
      [
        csvCell(r.id),
        csvCell(ms ? new Date(ms).toISOString() : ''),
        csvCell(ms),
        csvCell(r.source_type ?? 'deposit'),
        csvCell(r.idempotency_key ?? ''),
        csvCell(r.referrer_username ?? ''),
        csvCell(r.referrer_email ?? ''),
        csvCell(r.referred_username ?? ''),
        csvCell(r.referred_email ?? ''),
        csvCell(asNum(r.base_amount_usdc).toFixed(BASE_AMOUNT_DECIMALS)),
        csvCell(asNum(r.commission_percent).toFixed(COMMISSION_PERCENT_DECIMALS)),
        csvCell(asNum(r.commission_usdc).toFixed(BASE_AMOUNT_DECIMALS)),
        csvCell('paid')
      ].join(',')
    );
  }
  return lines.join('\n');
}
