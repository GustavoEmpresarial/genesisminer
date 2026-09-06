/**
 * Relatório admin de emails/contas suspeitas — heurística de formato/domínio de email
 * + sinais de actividade real (mineração, saldo, wallet, depósito, check-in).
 *
 * Migrado de legacy/backend/modules/admin/suspiciousEmails/suspiciousEmailsAdmin.service.ts
 * (verbatim na lógica). `db: Pool` deixou de vir por parâmetro — importa o singleton
 * `core/database/pool.js` directamente (mesmo padrão de `modules/shop`/`modules/servers`).
 */
import db from '../../../../core/database/pool.js';
import { computePlayerGameHeaderSnapshot } from '../../../mining-engine/services/player-game-header-snapshot.js';
import { MS_PER_DAY } from '../../../../shared/utils/time.js';
import { callAuthSessionDeleteByUser } from '../../../auth/services/auth-worker-client.js';
import { DISPOSABLE_EMAIL_DOMAINS } from './domains.js';
import { detectSuspiciousEmail, getEmailDomain, FAKE_EXACT_EMAILS_LIST, TRUSTED_EMAIL_DOMAINS, type SuspiciousEmailReasonCode } from './detect.js';
import { calculateUserSuspicionScore, type RiskLevel } from './score.js';
import { mergeEmailAndActivityReasons, type UserActivitySignals } from './signals.js';

export type SuspiciousEmailsListQuery = {
  q?: string;
  reason?: string;
  status?: string;
  domain?: string;
  /** Filtro de actividade: all | never_mined | no_wallet | no_deposit | no_recent_login | referral_entry */
  activity?: string;
  page?: number;
  limit?: number;
  sort?: string;
};

export type SuspiciousEmailReferrer = { id: number | null; username: string | null; email: string | null };

export type SuspiciousEmailUserRow = {
  id: number;
  username: string;
  email: string;
  emailDomain: string | null;
  status: 'active' | 'blocked';
  accessLevel: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  emailVerified: boolean | null;
  walletAddress: string | null;
  totalHash: number;
  /** Soma dos saldos em `coin_balances` (unidades de moeda na BD; não é USD oráculo). */
  totalMinedUsd: number;
  totalDepositedUsdc: number;
  hasMinedFlag: boolean;
  referrer: SuspiciousEmailReferrer | null;
  riskScore: number;
  riskLevel: RiskLevel;
  reasons: SuspiciousEmailReasonCode[];
};

export type SuspiciousEmailsReport = {
  ok: true;
  summary: {
    totalSuspicious: number;
    domainNotTrusted: number;
    invalidFormat: number;
    temporaryDomains: number;
    fakePatterns: number;
    duplicates: number;
    unverified: number;
    suspiciousDomain: number;
    deadAccounts: number;
    referralOnly: number;
    highRisk: number;
    /** Contas activas (não bloqueadas) no conjunto filtrado — alvo do botão desactivar em massa. */
    totalActiveFiltered: number;
  };
  trustedDomains: readonly string[];
  domainStats: Array<{ domain: string; count: number; reason: SuspiciousEmailReasonCode | 'high_volume' }>;
  users: SuspiciousEmailUserRow[];
  pagination: { page: number; limit: number; total: number };
  meta?: { note?: string; unverifiedEmailSupported?: boolean };
};

const MAX_LIMIT = 100;
const MAX_EXPORT = 5000;
const Q_MAX_LEN = 200;
const DEFAULT_LIMIT = 50;
const MAX_PAGE = 1_000_000;
const HIGH_VOLUME_DOMAIN_THRESHOLD = 8;
const NO_RECENT_LOGIN_DAYS = 30;
const NO_RECENT_LOGIN_MS = NO_RECENT_LOGIN_DAYS * MS_PER_DAY;
const SNAPSHOT_CONCURRENCY = 8;
const MIN_DOMAIN_STAT_COUNT = 3;
const MAX_DOMAIN_STATS = 80;
const MINED_HASH_EPS = 1e-10;
const MINED_COIN_EPS = 1e-8;

const REASON_FILTERS = new Set<string>([
  'all',
  'domain_not_trusted',
  'invalid_format',
  'temporary_domain',
  'fake_pattern',
  'duplicate_email',
  'unverified_email',
  'suspicious_domain',
  'specific_domain',
  'dead_account',
  'referral_only',
  'never_mined',
  'no_wallet',
  'no_deposit',
  'no_recent_login',
  'high_risk'
]);

const ACTIVITY_FILTERS = new Set(['all', 'never_mined', 'no_wallet', 'no_deposit', 'no_recent_login', 'referral_entry']);

function clampInt(n: unknown, def: number, min: number, max: number): number {
  const x = parseInt(String(n ?? ''), 10);
  if (!Number.isFinite(x)) return def;
  return Math.min(max, Math.max(min, x));
}

function sanitizeQ(raw: unknown): string {
  const s = String(raw ?? '').trim().slice(0, Q_MAX_LEN);
  if (!s) return '';
  return s.replace(/\0/g, '');
}

type DbUserRow = {
  id: number;
  username: string;
  email: string;
  referred_by: string | null;
  is_blocked: number | null;
  last_active_at: string | number | null;
  polygon_wallet: string | null;
  access_level_id: string | null;
  access_level_name: string | null;
  gs_last_updated: string | number | null;
  gs_start_time: string | number | null;
  referrer_id: number | null;
  referrer_username: string | null;
  referrer_email: string | null;
  coin_balance_sum: string | number | null;
  rack_count: string | number | null;
  racks_mining_on: string | number | null;
  has_stock: boolean | null;
  total_usdc_deposited: string | number | null;
  last_checkin_at_ms: string | number | null;
};

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

function lastLoginMs(r: DbUserRow): number | null {
  const la = r.last_active_at != null ? Number(r.last_active_at) : NaN;
  const gs = r.gs_last_updated != null ? Number(r.gs_last_updated) : NaN;
  const candidates = [la, gs].filter((x) => Number.isFinite(x) && x > 0);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function createdAtIso(r: DbUserRow): string | null {
  const st = r.gs_start_time != null ? Number(r.gs_start_time) : NaN;
  if (Number.isFinite(st) && st > 0) return new Date(st).toISOString();
  return null;
}

function sortCreatedMs(r: DbUserRow): number {
  const st = r.gs_start_time != null ? Number(r.gs_start_time) : NaN;
  if (Number.isFinite(st) && st > 0) return st;
  return r.id;
}

function rowToSignals(r: DbUserRow): UserActivitySignals {
  const st = r.gs_start_time != null ? Number(r.gs_start_time) : NaN;
  return {
    coinBalanceSum: num(r.coin_balance_sum),
    racksMiningOn: Math.floor(num(r.racks_mining_on)),
    rackCount: Math.floor(num(r.rack_count)),
    hasStock: !!r.has_stock,
    totalUsdcDeposited: num(r.total_usdc_deposited),
    hasWallet: !!(r.polygon_wallet && String(r.polygon_wallet).trim()),
    referredBy: r.referred_by,
    lastLoginMs: lastLoginMs(r),
    accountStartMs: Number.isFinite(st) && st > 0 ? st : null,
    lastCheckinMs: r.last_checkin_at_ms != null ? Number(r.last_checkin_at_ms) : null
  };
}

const userSelectSql = `
      u.id,
      u.username,
      u.email,
      u.referred_by,
      u.is_blocked,
      u.last_active_at,
      u.polygon_wallet,
      u.access_level_id,
      al.name AS access_level_name,
      gs.last_updated_at AS gs_last_updated,
      gs.start_time AS gs_start_time,
      gs.total_usdc_deposited,
      gs.last_checkin_at_ms,
      ref.id AS referrer_id,
      ref.username AS referrer_username,
      ref.email AS referrer_email,
      COALESCE((
        SELECT SUM(cb.amount)::float FROM coin_balances cb WHERE cb.user_id = u.id
      ), 0) AS coin_balance_sum,
      COALESCE((SELECT COUNT(*)::int FROM placed_racks pr WHERE pr.user_id = u.id), 0) AS rack_count,
      COALESCE((
        SELECT COUNT(*)::int FROM placed_racks pr
        WHERE pr.user_id = u.id AND pr.is_on = 1
          AND trim(coalesce(pr.wiring_id, '')) <> ''
          AND trim(coalesce(pr.battery_id, '')) <> ''
          AND trim(coalesce(pr.selected_coin_id, '')) <> ''
      ), 0) AS racks_mining_on,
      EXISTS (
        SELECT 1 FROM stock s WHERE s.user_id = u.id AND s.qty > 0
      ) AS has_stock
`;

const userJoinSql = `
    FROM users u
    LEFT JOIN access_levels al ON al.id = u.access_level_id
    LEFT JOIN game_states gs ON gs.user_id = u.id
    LEFT JOIN users ref ON ref.username = u.referred_by AND u.referred_by IS NOT NULL AND trim(u.referred_by) <> ''
`;

/** Serializa linhas já resolvidas (`SuspiciousEmailUserRow`) para CSV (RFC4180-like: aspas duplicadas escapam `"`). Usado pelo endpoint `export.csv`. */
export function buildSuspiciousEmailsCsv(users: SuspiciousEmailUserRow[]): string {
  const headers = [
    'id',
    'username',
    'email',
    'emailDomain',
    'riskScore',
    'riskLevel',
    'status',
    'accessLevel',
    'createdAt',
    'lastLoginAt',
    'walletAddress',
    'emailVerified',
    'totalHash',
    'totalMinedCoinSum',
    'totalDepositedUsdc',
    'hasMinedFlag',
    'referrerUsername',
    'referrerEmail',
    'reasons'
  ];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  for (const u of users) {
    const row = [
      String(u.id),
      esc(String(u.username ?? '')),
      esc(String(u.email ?? '')),
      esc(String(u.emailDomain ?? '')),
      String(u.riskScore),
      u.riskLevel,
      u.status,
      esc(String(u.accessLevel ?? '')),
      esc(String(u.createdAt ?? '')),
      esc(u.lastLoginAt ?? ''),
      esc(String(u.walletAddress ?? '')),
      u.emailVerified == null ? '' : u.emailVerified ? 'true' : 'false',
      String(u.totalHash),
      String(u.totalMinedUsd),
      String(u.totalDepositedUsdc),
      u.hasMinedFlag ? 'true' : 'false',
      esc(String(u.referrer?.username ?? '')),
      esc(String(u.referrer?.email ?? '')),
      esc((u.reasons || []).join('|'))
    ];
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

type Internal = {
  _db: DbUserRow;
  emailReasons: SuspiciousEmailReasonCode[];
  sig: UserActivitySignals;
  id: number;
  username: string;
  email: string;
  status: 'active' | 'blocked';
  accessLevel: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  walletAddress: string | null;
  emailVerified: boolean | null;
  reasons: SuspiciousEmailReasonCode[];
  riskScore: number;
  riskLevel: RiskLevel;
  coinBalanceSum: number;
  totalDepositedUsdc: number;
  referrer: SuspiciousEmailReferrer | null;
};

type ParsedSuspiciousQuery = { reason: string; activity: string; status: string; sort: string; q: string; specificDomain: string };

function parseSuspiciousEmailsQuery(query: SuspiciousEmailsListQuery): ParsedSuspiciousQuery {
  const reason = REASON_FILTERS.has(String(query.reason || '').trim()) ? String(query.reason || 'all').trim() : 'all';
  const activity = ACTIVITY_FILTERS.has(String(query.activity || '').trim().toLowerCase()) ? String(query.activity || 'all').trim().toLowerCase() : 'all';
  const status = String(query.status || 'all').trim().toLowerCase();
  const sort = String(query.sort || 'created_desc').trim().toLowerCase();
  const q = sanitizeQ(query.q);
  const specificDomain = String(query.domain || '').trim().toLowerCase().slice(0, Q_MAX_LEN).replace(/\0/g, '');
  return { reason, activity, status, sort, q, specificDomain };
}

function sortSuspiciousWorkingSet(working: Internal[], sort: string): Internal[] {
  const cmpStr = (a: string | null, b: string | null, dir: number) => {
    const sa = (a ?? '').toLowerCase();
    const sb = (b ?? '').toLowerCase();
    if (sa < sb) return -dir;
    if (sa > sb) return dir;
    return 0;
  };

  const sorted = [...working];
  switch (sort) {
    case 'risk_desc':
      sorted.sort((a, b) => b.riskScore - a.riskScore || b.id - a.id);
      break;
    case 'risk_asc':
      sorted.sort((a, b) => a.riskScore - b.riskScore || a.id - b.id);
      break;
    case 'last_login_desc':
      sorted.sort((a, b) => {
        const la = lastLoginMs(a._db) ?? 0;
        const lb = lastLoginMs(b._db) ?? 0;
        return lb - la || b.id - a.id;
      });
      break;
    case 'total_mined_desc':
      sorted.sort((a, b) => b.coinBalanceSum - a.coinBalanceSum || b.id - a.id);
      break;
    case 'total_deposited_desc':
      sorted.sort((a, b) => b.totalDepositedUsdc - a.totalDepositedUsdc || b.id - a.id);
      break;
    case 'created_asc':
      sorted.sort((a, b) => sortCreatedMs(a._db) - sortCreatedMs(b._db) || a.id - b.id);
      break;
    case 'domain_asc':
      sorted.sort((a, b) => cmpStr(getEmailDomain(a.email) || '', getEmailDomain(b.email) || '', 1) || b.id - a.id);
      break;
    case 'domain_desc':
      sorted.sort((a, b) => cmpStr(getEmailDomain(a.email) || '', getEmailDomain(b.email) || '', -1) || b.id - a.id);
      break;
    case 'username_asc':
      sorted.sort((a, b) => cmpStr(a.username, b.username, 1) || b.id - a.id);
      break;
    case 'username_desc':
      sorted.sort((a, b) => cmpStr(a.username, b.username, -1) || b.id - a.id);
      break;
    case 'created_desc':
    default:
      sorted.sort((a, b) => sortCreatedMs(b._db) - sortCreatedMs(a._db) || b.id - a.id);
  }
  return sorted;
}

function buildSuspiciousSummary(working: Internal[], total: number) {
  return {
    totalSuspicious: total,
    domainNotTrusted: working.filter((u) => u.reasons.includes('domain_not_trusted')).length,
    invalidFormat: working.filter((u) => u.reasons.includes('invalid_format')).length,
    temporaryDomains: working.filter((u) => u.reasons.includes('temporary_domain')).length,
    fakePatterns: working.filter((u) => u.reasons.includes('fake_pattern')).length,
    duplicates: working.filter((u) => u.reasons.includes('duplicate_email')).length,
    unverified: working.filter((u) => u.reasons.includes('unverified_email')).length,
    suspiciousDomain: working.filter((u) => u.reasons.includes('suspicious_domain')).length,
    deadAccounts: working.filter((u) => u.reasons.includes('dead_account')).length,
    referralOnly: working.filter((u) => u.reasons.includes('referral_only')).length,
    highRisk: working.filter((u) => u.riskLevel === 'high').length,
    totalActiveFiltered: working.filter((u) => u.status === 'active').length
  };
}

/**
 * Resolve o conjunto de utilizadores que batem com os filtros do relatório de
 * contas suspeitas. Faz 2 queries de suporte (emails duplicados, contagem por
 * domínio) e depois uma query de candidatos (heurística SQL ampla — ver
 * `candidateSql`), refinando cada linha com `detectSuspiciousEmail` +
 * `mergeEmailAndActivityReasons`.
 *
 * NOTA IMPORTANTE (consumida por `fetchSuspiciousEmailsReport` E por
 * `deactivateFilteredSuspiciousUsers`, este último uma acção destrutiva em
 * massa — ver risco abaixo):
 *
 * Os motivos (`reasons`) calculados aqui usam `totalHashFromSnapshot = null`
 * (linha `mergeEmailAndActivityReasons(emailReasons, sig, null)`), isto é,
 * SEM o hash real de mineração vindo de `computePlayerGameHeaderSnapshot`
 * (esse snapshot só é calculado depois, por linha da PÁGINA actual, dentro de
 * `fetchSuspiciousEmailsReport`, e usado para refinar `reasons`/`riskScore`
 * apenas nos dados devolvidos ao admin no ecrã). Isto significa que:
 *
 * 1. O conjunto `working` (todos os que passam nos filtros, não só a página
 *    actual) pode incluir/excluir um utilizador por `never_mined`/`zero_hash`/
 *    `dead_account` com base numa aproximação (saldo de moedas + racks a
 *    minerar), enquanto o que o admin vê no ecrã (para a página actual) foi
 *    recalculado com o hash real.
 * 2. `deactivateFilteredSuspiciousUsers` (função mais abaixo, chamada pela
 *    rota `POST /suspicious-emails/deactivate-filtered`) usava este `working`
 *    directamente para decidir QUEM desactivar, sem refinar com hash real —
 *    o `expectedCount` (contagem que o admin viu, também não-refinada) podia
 *    bater em NÚMERO sem ser exactamente o mesmo conjunto de IDs que o
 *    hash real justificaria. **Corrigido**: antes de desactivar, o lote final
 *    passa por `refineActiveCandidatesWithRealHash`, que confirma cada
 *    candidato com hash real quando o filtro pedido depende de hash
 *    (`dead_account`, `never_mined`, `zero_hash`, `no_game_progress`,
 *    `referral_only`, `high_risk`) e exclui quem deixar de bater — nunca
 *    desactiva além do que a listagem mostrou, só reduz. A listagem em si
 *    (`fetchSuspiciousEmailsReport`, `summary`/`domainStats`) continua usando
 *    a aproximação para o `working` inteiro por custo (uma query pesada por
 *    utilizador seria cara para milhares de linhas) — só a acção destrutiva
 *    paga o custo do hash real, e só para quem de facto será desactivado.
 */
export async function resolveSuspiciousUsersWorkingSet(query: SuspiciousEmailsListQuery): Promise<{ working: Internal[]; domainTotalCounts: Map<string, number>; parsed: ParsedSuspiciousQuery }> {
  const parsed = parseSuspiciousEmailsQuery(query);
  const { reason, activity, status, q, specificDomain } = parsed;

  const trusted = [...TRUSTED_EMAIL_DOMAINS].map((d) => d.toLowerCase());
  const trustedSet = new Set(trusted);
  const disposables = DISPOSABLE_EMAIL_DOMAINS.map((d) => d.toLowerCase());
  const fakeExact = [...FAKE_EXACT_EMAILS_LIST];

  const dupRes = await db.query<{ em: string }>(`
    SELECT lower(trim(email)) AS em
    FROM users
    GROUP BY 1
    HAVING count(*) > 1
    `);
  const duplicateSet = new Set(dupRes.rows.map((r) => r.em).filter(Boolean));

  const domainCountRes = await db.query<{ d: string; c: string }>(`
    SELECT lower(trim(split_part(trim(email), '@', 2))) AS d, count(*)::text AS c
    FROM users
    WHERE position('@' in trim(email)) > 0
    GROUP BY 1
    `);
  const domainTotalCounts = new Map<string, number>();
  for (const row of domainCountRes.rows) {
    if (row.d) domainTotalCounts.set(row.d, parseInt(row.c, 10) || 0);
  }

  const ctxEmail = {
    duplicateNormalizedEmails: duplicateSet,
    domainTotalCounts,
    highVolumeDomainThreshold: HIGH_VOLUME_DOMAIN_THRESHOLD,
    emailVerified: null as boolean | null,
    trustedDomains: trustedSet
  };

  let candidates: DbUserRow[];

  if (reason === 'specific_domain' && specificDomain) {
    const { rows } = await db.query<DbUserRow>(
      `
      SELECT ${userSelectSql}
      ${userJoinSql}
      WHERE lower(trim(split_part(trim(u.email), '@', 2))) = $1
      `,
      [specificDomain]
    );
    candidates = rows;
  } else {
    const candidateSql = `
    WITH dup AS (
      SELECT lower(trim(email)) AS em
      FROM users
      GROUP BY 1
      HAVING count(*) > 1
    )
    SELECT ${userSelectSql}
    ${userJoinSql}
    LEFT JOIN dup ON dup.em = lower(trim(u.email))
    WHERE
      dup.em IS NOT NULL
      OR coalesce(trim(u.email), '') = ''
      OR u.email ~ '[[:space:]]'
      OR (length(u.email) - length(replace(u.email, '@', ''))) <> 1
      OR split_part(trim(u.email), '@', 1) = ''
      OR split_part(trim(u.email), '@', 2) = ''
      OR position('.' in split_part(trim(u.email), '@', 2)) = 0
      OR lower(split_part(trim(u.email), '@', 2)) = ANY($1::text[])
      OR lower(trim(u.email)) = ANY($2::text[])
      OR lower(trim(u.email)) LIKE '%@example.com'
      OR lower(trim(u.email)) LIKE '%@example.org'
      OR lower(trim(u.email)) LIKE '%@example.net'
      OR lower(split_part(trim(u.email), '@', 1)) IN ('no-reply','noreply','mailer-daemon','postmaster','donotreply','do-not-reply')
      OR char_length(lower(split_part(trim(u.email), '@', 2))) >= 32
      OR (
        char_length(regexp_replace(lower(split_part(trim(u.email), '@', 2)), '[^0-9]', '', 'g')) >= 5
        AND char_length(lower(split_part(trim(u.email), '@', 2))) <= 18
      )
      OR (
        position('@' in trim(u.email)) > 0
        AND (length(u.email) - length(replace(u.email, '@', ''))) = 1
        AND position('.' in split_part(trim(lower(u.email)), '@', 2)) > 0
        AND split_part(trim(lower(u.email)), '@', 2) <> ALL($3::text[])
      )
      OR (
        COALESCE((SELECT SUM(cb.amount) FROM coin_balances cb WHERE cb.user_id = u.id), 0) < 0.00000001
        AND COALESCE(gs.total_usdc_deposited, 0) < 0.000001
        AND (u.polygon_wallet IS NULL OR trim(u.polygon_wallet) = '')
        AND NOT EXISTS (
          SELECT 1 FROM placed_racks pr
          WHERE pr.user_id = u.id AND pr.is_on = 1
            AND trim(coalesce(pr.wiring_id, '')) <> ''
            AND trim(coalesce(pr.battery_id, '')) <> ''
            AND trim(coalesce(pr.selected_coin_id, '')) <> ''
        )
      )
  `;
    const { rows } = await db.query<DbUserRow>(candidateSql, [disposables, fakeExact, trusted]);
    candidates = rows;
  }

  const enriched: Internal[] = [];

  for (const r of candidates) {
    const emailReasons = detectSuspiciousEmail(r.email, ctxEmail);
    const sig = rowToSignals(r);
    const reasons = mergeEmailAndActivityReasons(emailReasons, sig, null);
    if (reason === 'specific_domain' && specificDomain) {
      /* manter linhas do domínio mesmo sem motivos */
    } else if (reasons.length === 0) {
      continue;
    }

    const blocked = !!(r.is_blocked && Number(r.is_blocked) !== 0);
    const st: 'active' | 'blocked' = blocked ? 'blocked' : 'active';
    const lastMs = lastLoginMs(r);
    const refUser = (r.referred_by || '').trim()
      ? { id: r.referrer_id != null && Number.isFinite(Number(r.referrer_id)) ? Number(r.referrer_id) : null, username: r.referrer_username ?? null, email: r.referrer_email ?? null }
      : null;

    const { score, riskLevel } = calculateUserSuspicionScore(reasons);

    enriched.push({
      _db: r,
      emailReasons,
      sig,
      id: r.id,
      username: r.username,
      email: r.email,
      status: st,
      accessLevel: r.access_level_name ?? r.access_level_id ?? null,
      createdAt: createdAtIso(r),
      lastLoginAt: lastMs != null ? new Date(lastMs).toISOString() : null,
      walletAddress: r.polygon_wallet && String(r.polygon_wallet).trim() ? String(r.polygon_wallet).trim() : null,
      emailVerified: null,
      reasons,
      riskScore: score,
      riskLevel,
      coinBalanceSum: num(r.coin_balance_sum),
      totalDepositedUsdc: num(r.total_usdc_deposited),
      referrer: refUser
    });
  }

  let working = [...enriched];

  if (reason === 'specific_domain') {
    if (!specificDomain) working = [];
    else working = working.filter((u) => getEmailDomain(u.email) === specificDomain);
  } else if (reason === 'unverified_email') {
    working = working.filter((u) => u.reasons.includes('unverified_email'));
  } else if (reason === 'high_risk') {
    working = working.filter((u) => u.riskLevel === 'high');
  } else if (reason === 'no_recent_login') {
    const now = Date.now();
    working = working.filter((u) => {
      const lm = lastLoginMs(u._db);
      return lm == null || now - lm > NO_RECENT_LOGIN_MS;
    });
  } else if (reason !== 'all') {
    working = working.filter((u) => u.reasons.includes(reason as SuspiciousEmailReasonCode));
  }

  if (activity === 'never_mined') {
    working = working.filter((u) => u.reasons.includes('never_mined'));
  } else if (activity === 'no_wallet') {
    working = working.filter((u) => u.reasons.includes('no_wallet'));
  } else if (activity === 'no_deposit') {
    working = working.filter((u) => u.reasons.includes('no_deposit'));
  } else if (activity === 'no_recent_login') {
    const now = Date.now();
    working = working.filter((u) => {
      const lm = lastLoginMs(u._db);
      return lm == null || now - lm > NO_RECENT_LOGIN_MS;
    });
  } else if (activity === 'referral_entry') {
    working = working.filter((u) => !!(u._db.referred_by && String(u._db.referred_by).trim()));
  }

  if (status === 'active') {
    working = working.filter((u) => u.status === 'active');
  } else if (status === 'blocked' || status === 'suspended') {
    working = working.filter((u) => u.status === 'blocked');
  }

  if (q) {
    const ql = q.toLowerCase();
    const qId = parseInt(q, 10);
    working = working.filter((u) => {
      const em = (u.email || '').toLowerCase();
      const un = (u.username || '').toLowerCase();
      const dom = getEmailDomain(u.email) || '';
      const refn = (u.referrer?.username || '').toLowerCase();
      const refe = (u.referrer?.email || '').toLowerCase();
      const idMatch = Number.isFinite(qId) && qId > 0 && u.id === qId;
      return idMatch || em.includes(ql) || un.includes(ql) || dom.includes(ql) || refn.includes(ql) || refe.includes(ql);
    });
  }

  return { working, domainTotalCounts, parsed };
}

const DEACTIVATE_BATCH_SIZE = 500;

/**
 * Desactiva (`is_blocked = 1`) e faz logout forçado via `genesis-auth`
 * `delete-by-user` dos IDs dados, em lotes de `DEACTIVATE_BATCH_SIZE` dentro
 * de uma única transacção (tudo ou nada — `ROLLBACK` em erro de qualquer lote).
 * Idempotente: o `UPDATE` filtra `COALESCE(is_blocked, 0) = 0`, por isso
 * reexecutar com os mesmos IDs não re-conta contas já bloqueadas.
 *
 * Não valida por si só se os IDs ainda são "suspeitos" no momento da escrita —
 * quem chama (`deactivateFilteredSuspiciousUsers`) é responsável por resolver a
 * lista correcta antes de invocar isto. Ver nota de risco em
 * `resolveSuspiciousUsersWorkingSet` sobre como essa lista é composta.
 *
 * @returns Número de contas que passaram de activa para bloqueada nesta chamada.
 */
export async function deactivateSuspiciousActiveUserIds(activeIds: number[]): Promise<number> {
  if (activeIds.length === 0) return 0;
  let deactivated = 0;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < activeIds.length; i += DEACTIVATE_BATCH_SIZE) {
      const batch = activeIds.slice(i, i + DEACTIVATE_BATCH_SIZE);
      const upd = await client.query(`UPDATE users SET is_blocked = 1 WHERE id = ANY($1::int[]) AND COALESCE(is_blocked, 0) = 0`, [batch]);
      deactivated += upd.rowCount ?? 0;
      const wipe = await callAuthSessionDeleteByUser({ userIds: batch });
      if (!wipe.ok) {
        throw new Error(wipe.error ?? 'auth session delete-by-user failed');
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return deactivated;
}

export type DeactivateFilteredSuspiciousResult =
  | { ok: true; deactivated: number; alreadyBlocked: number; excludedByRealMining: number }
  | { ok: false; code: 'COUNT_MISMATCH'; expected: number; actual: number }
  | { ok: false; code: 'INVALID'; error: string };

/** Motivos de `reason` cuja elegibilidade depende de hash de mineração —
 *  ver {@link deriveActivityReasons}. Filtrar por qualquer um destes usando
 *  a aproximação (sem hash real) é o cenário de risco documentado em
 *  {@link resolveSuspiciousUsersWorkingSet}. */
const HASH_DEPENDENT_REASONS = new Set<string>(['dead_account', 'never_mined', 'zero_hash', 'no_game_progress', 'referral_only', 'high_risk']);

/** Idem, para o filtro `activity` (`ACTIVITY_FILTERS`). */
const HASH_DEPENDENT_ACTIVITY = new Set<string>(['never_mined']);

/**
 * Confirma, com o hash real de mineração (`computePlayerGameHeaderSnapshot`),
 * que cada candidato a desactivação ainda bate com o filtro `reason`/`activity`
 * pedido — mitigação do risco documentado em `resolveSuspiciousUsersWorkingSet`
 * (a listagem/contagem usa uma aproximação sem hash real; sem esta refinação,
 * um jogador que já minerou de verdade mas zerou saldo/desligou rigs seria
 * desactivado por engano num filtro `dead_account`/`never_mined`/etc.).
 *
 * No-op (devolve todos os IDs, sem chamada nenhuma) quando o filtro pedido
 * não depende de hash — a maioria dos filtros (formato/domínio de email,
 * `no_wallet`, `no_deposit`, `all`...) não precisa desta checagem extra e
 * cai neste atalho barato.
 *
 * @returns `validIds`: IDs confirmados pelo hash real (a desactivar de facto).
 *   `excludedByRealMining`: quantos candidatos foram descartados por, com o
 *   hash real, deixarem de bater com o filtro — nunca bloqueia a acção
 *   inteira, só reduz o lote ao subconjunto correcto.
 */
async function refineActiveCandidatesWithRealHash(
  candidates: Internal[],
  parsed: ParsedSuspiciousQuery
): Promise<{ validIds: number[]; excludedByRealMining: number }> {
  const needsRefinement = HASH_DEPENDENT_REASONS.has(parsed.reason) || HASH_DEPENDENT_ACTIVITY.has(parsed.activity);
  if (!needsRefinement || candidates.length === 0) {
    return { validIds: candidates.map((c) => c.id), excludedByRealMining: 0 };
  }

  const validIds: number[] = [];
  let excludedByRealMining = 0;

  for (let i = 0; i < candidates.length; i += SNAPSHOT_CONCURRENCY) {
    const chunk = candidates.slice(i, i + SNAPSHOT_CONCURRENCY);
    await Promise.all(
      chunk.map(async (c) => {
        const realHash = await computePlayerGameHeaderSnapshot(c.id)
          .then((snap) => snap.totalHash)
          .catch(() => 0);
        const refinedReasons = mergeEmailAndActivityReasons(c.emailReasons, c.sig, realHash);
        const matchesReason =
          parsed.reason === 'all' ||
          (parsed.reason === 'high_risk'
            ? calculateUserSuspicionScore(refinedReasons).riskLevel === 'high'
            : refinedReasons.includes(parsed.reason as SuspiciousEmailReasonCode));
        const matchesActivity = parsed.activity !== 'never_mined' || refinedReasons.includes('never_mined');
        if (matchesReason && matchesActivity) {
          validIds.push(c.id);
        } else {
          excludedByRealMining += 1;
        }
      })
    );
  }

  return { validIds, excludedByRealMining };
}

/**
 * Rota destrutiva em massa: recalcula o `working set` a partir dos mesmos
 * filtros (`query`) que o admin usou no ecrã e desactiva todos os que
 * estiverem `status === 'active'` — depois de confirmar cada um com o hash
 * real de mineração ({@link refineActiveCandidatesWithRealHash}) quando o
 * filtro pedido depende de hash.
 *
 * Dupla-checagem antes de agir: `opts.expectedCount` é a contagem que o admin
 * viu no ecrã (parâmetro obrigatório, `>= 1`); se o recálculo no servidor
 * (`activeIds.length`, ainda pela aproximação — mesma base de cálculo do que
 * o admin viu) não bater com `expected`, devolve `COUNT_MISMATCH` e NÃO
 * desactiva ninguém — protege contra a lista ter mudado entre o admin
 * carregar a página e clicar em "desactivar" (outra sessão admin, cron, etc.).
 * Só depois dessa checagem é que entra a refinação por hash real, que pode
 * reduzir ainda mais o lote final (nunca aumentar).
 *
 * `opts.adminUserId` é recebido mas não usado nesta função (auditoria fica a
 * cargo do `console.log` no controller, que já inclui o id do admin).
 *
 * @returns `{ ok: true, deactivated, alreadyBlocked, excludedByRealMining }`
 *   em sucesso; `COUNT_MISMATCH` se a contagem (aproximada) divergir;
 *   `INVALID` se `expectedCount < 1`.
 */
export async function deactivateFilteredSuspiciousUsers(
  query: SuspiciousEmailsListQuery,
  opts: { expectedCount: number; adminUserId: number }
): Promise<DeactivateFilteredSuspiciousResult> {
  const expected = Math.floor(Number(opts.expectedCount) || 0);
  if (expected < 1) {
    return { ok: false, code: 'INVALID', error: 'expectedCount deve ser >= 1.' };
  }

  const { working, parsed } = await resolveSuspiciousUsersWorkingSet(query);
  const activeCandidates = working.filter((u) => u.status === 'active');
  const alreadyBlocked = working.length - activeCandidates.length;

  if (activeCandidates.length !== expected) {
    return { ok: false, code: 'COUNT_MISMATCH', expected, actual: activeCandidates.length };
  }

  const { validIds, excludedByRealMining } = await refineActiveCandidatesWithRealHash(activeCandidates, parsed);
  const deactivated = await deactivateSuspiciousActiveUserIds(validIds);

  return { ok: true, deactivated, alreadyBlocked, excludedByRealMining };
}

function internalToPublic(i: Internal, totalHash: number, reasons: SuspiciousEmailReasonCode[]): SuspiciousEmailUserRow {
  const { score, riskLevel } = calculateUserSuspicionScore(reasons);
  const dom = getEmailDomain(i.email);
  const mined = totalHash > MINED_HASH_EPS || i.coinBalanceSum > MINED_COIN_EPS || i.sig.racksMiningOn > 0;
  return {
    id: i.id,
    username: i.username,
    email: i.email,
    emailDomain: dom,
    status: i.status,
    accessLevel: i.accessLevel,
    createdAt: i.createdAt,
    lastLoginAt: i.lastLoginAt,
    emailVerified: i.emailVerified,
    walletAddress: i.walletAddress,
    totalHash,
    totalMinedUsd: i.coinBalanceSum,
    totalDepositedUsdc: i.totalDepositedUsdc,
    hasMinedFlag: mined,
    referrer: i.referrer,
    riskScore: score,
    riskLevel,
    reasons
  };
}

/**
 * Monta o relatório paginado de contas suspeitas exibido no admin (e reusado,
 * com `exportMode: true`/limite maior, pelo CSV export).
 *
 * Só a página actual (`pageInternals`, até `SNAPSHOT_CONCURRENCY` em paralelo)
 * é enriquecida com o hash real de mineração via
 * `computePlayerGameHeaderSnapshot` — resolver isto para o `working` inteiro
 * seria caro (uma query pesada por utilizador). `summary`/`domainStats` usam o
 * `working` não-refinado (sem hash real) — ver nota em
 * `resolveSuspiciousUsersWorkingSet`. Falha de snapshot por utilizador é
 * absorvida (`catch` → hash 0), nunca derruba o relatório inteiro.
 */
export async function fetchSuspiciousEmailsReport(query: SuspiciousEmailsListQuery, opts?: { exportMode?: boolean }): Promise<SuspiciousEmailsReport> {
  const exportMode = !!opts?.exportMode;
  const page = clampInt(query.page, 1, 1, MAX_PAGE);
  const cap = exportMode ? MAX_EXPORT : MAX_LIMIT;
  const defaultLimit = exportMode ? MAX_EXPORT : DEFAULT_LIMIT;
  const limit = clampInt(query.limit, defaultLimit, 1, cap);

  const { working, domainTotalCounts, parsed } = await resolveSuspiciousUsersWorkingSet(query);
  const sorted = sortSuspiciousWorkingSet(working, parsed.sort);

  const total = sorted.length;
  const offset = (page - 1) * limit;
  const pageInternals = sorted.slice(offset, offset + limit);

  const hashById = new Map<number, number>();
  for (let i = 0; i < pageInternals.length; i += SNAPSHOT_CONCURRENCY) {
    const chunk = pageInternals.slice(i, i + SNAPSHOT_CONCURRENCY);
    await Promise.all(
      chunk.map(async (row) => {
        try {
          const snap = await computePlayerGameHeaderSnapshot(row.id);
          hashById.set(row.id, snap.totalHash);
        } catch {
          hashById.set(row.id, 0);
        }
      })
    );
  }

  const users: SuspiciousEmailUserRow[] = pageInternals.map((row) => {
    const th = hashById.get(row.id) ?? 0;
    const refined = mergeEmailAndActivityReasons(row.emailReasons, row.sig, th);
    const { score, riskLevel } = calculateUserSuspicionScore(refined);
    return internalToPublic({ ...row, reasons: refined, riskScore: score, riskLevel }, th, refined);
  });

  const summary = buildSuspiciousSummary(working, total);

  const domainAgg = new Map<string, { count: number; reason: SuspiciousEmailReasonCode | 'high_volume' }>();
  for (const u of working) {
    const d = getEmailDomain(u.email);
    if (!d) continue;
    const prev = domainAgg.get(d)?.count ?? 0;
    let tag: SuspiciousEmailReasonCode | 'high_volume' = 'suspicious_domain';
    if (u.reasons.includes('temporary_domain')) tag = 'temporary_domain';
    else if ((domainTotalCounts.get(d) ?? 0) >= HIGH_VOLUME_DOMAIN_THRESHOLD) tag = 'high_volume';
    domainAgg.set(d, { count: prev + 1, reason: tag });
  }
  const domainStats = [...domainAgg.entries()]
    .filter(([, v]) => v.count >= MIN_DOMAIN_STAT_COUNT)
    .map(([domain, v]) => ({ domain, count: v.count, reason: v.reason }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_DOMAIN_STATS);

  return {
    ok: true,
    summary,
    trustedDomains: TRUSTED_EMAIL_DOMAINS,
    domainStats,
    users,
    pagination: { page, limit, total },
    meta: {
      unverifiedEmailSupported: false,
      note: 'totalMinedUsd na API é a soma de `coin_balances.amount` (unidades na BD), não conversão USD. totalHash vem do mesmo cálculo do jogo (última página). email_verified não existe em users.'
    }
  };
}
