/**
 * Relatórios admin: distribuição de créditos de mineração, lidos de `mining_block_history`
 * (janelas de crédito gravadas por `modules/mining-engine/services/progress-computer.ts`).
 *
 * Migrado de legacy/backend/services/adminMiningDistribution.service.ts (parte de
 * leitura — rebuild dos rollups fica em `./rollups.ts`).
 *
 * ⚠️ `mining_block_history` não é tracked no `schema.prisma` (mesma situação documentada
 * em DECISIONS.md #24/#25 — tabela criada via DDL manual do legado, `config/initDb.ts`,
 * nunca portado). Todas as leituras aqui degradam graciosamente (vazio/zerado) em vez de
 * 500 se a tabela não existir na base de destino — catch de `P2021` (Prisma: relação
 * inexistente), mesmo espírito do catch `42P01` já usado em `progress-computer.ts`
 * (lá é raw `pg`, aqui é Prisma, códigos diferentes pro mesmo problema).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../core/database/prisma.js';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import { clamp } from '../../../../shared/utils/clamp.js';
import { daysBetweenUtc, utcDayStartMsFromTs } from './dates.js';

const MS_PER_DAY = 86_400_000;
const HOURS_PER_DAY = 24;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = HOURS_PER_DAY * SECONDS_PER_HOUR;
const MAX_LEDGER_RANGE_DAYS = 93;
const MAX_LEDGER_RANGE_MS = MAX_LEDGER_RANGE_DAYS * MS_PER_DAY;
const MAX_EXPORT_ROWS = 50_000;
const MAX_LEDGER_LIMIT = 100;
const MAX_LEDGER_PAGE = 99_999;
const PERCENT_MULTIPLIER = 100;
const LAST_7_DAYS_OFFSET = 6;
const LAST_30_DAYS_OFFSET = 29;
const POSTGRES_TABLE_MISSING_CODE = 'P2021';
const HTTP_BAD_REQUEST = 400;

let miningBlockHistoryMissingWarned = false;

async function runOrDegradeIfTableMissing<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === POSTGRES_TABLE_MISSING_CODE) {
      if (!miningBlockHistoryMissingWarned) {
        miningBlockHistoryMissingWarned = true;
        console.warn('[AdminMiningDistribution] tabela mining_block_history ausente (P2021) — relatórios degradam para vazio/zero.');
      }
      return fallback;
    }
    throw e;
  }
}

export type DistributionTotals = {
  totalCoins: number;
  totalUsd: number;
  creditRows: number;
  uniqueUsers: number;
};

export type DistributionOverviewPeriod = DistributionTotals & {
  label: string;
  fromMs: number;
  toMs: number;
};

export type DistributionByCoinRow = {
  coinId: string;
  symbol: string;
  name: string;
  totalCoins: number;
  totalUsd: number;
  creditRows: number;
  uniqueUsers: number;
  pctOfTotalUsd: number;
  theoreticalEmissionCoins: number | null;
  emissionUtilizationPct: number | null;
};

export type DistributionTimelineRow = {
  bucketStartMs: number;
  bucketLabel: string;
  totalCoins: number;
  totalUsd: number;
  creditRows: number;
  uniqueUsers: number;
};

export type MiningCreditLedgerRow = {
  id: string;
  userId: number;
  username: string | null;
  email: string | null;
  coinId: string;
  coinSymbol: string | null;
  roomId: string | null;
  windowStartMs: number;
  windowEndMs: number;
  creditBlocks: number;
  amountCoins: number;
  amountUsd: number;
  userHashHps: number;
  networkHashrate: number;
  blockReward: number;
  blockTime: number;
  createdAtMs: number;
};

const EMPTY_TOTALS: DistributionTotals = { totalCoins: 0, totalUsd: 0, creditRows: 0, uniqueUsers: 0 };

function asNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function aggregateFromBlockHistory(fromMs: number, toMs: number, coinId?: string): Promise<DistributionTotals> {
  return runOrDegradeIfTableMissing(async () => {
    const from = Math.floor(fromMs);
    const to = Math.floor(toMs);
    const rows = coinId
      ? await prisma.$queryRaw<Array<{ total_coins: number | string | null; total_usd: number | string | null; credit_rows: bigint | number | string | null; unique_users: bigint | number | string | null }>>`
          SELECT
            COALESCE(SUM(h.amount_coins), 0)::float8 AS total_coins,
            COALESCE(SUM(h.amount_usd), 0)::float8 AS total_usd,
            COUNT(*)::bigint AS credit_rows,
            COUNT(DISTINCT h.user_id)::bigint AS unique_users
          FROM mining_block_history h
          WHERE h.window_end_ms >= ${from} AND h.window_end_ms <= ${to} AND h.coin_id = ${coinId}
        `
      : await prisma.$queryRaw<Array<{ total_coins: number | string | null; total_usd: number | string | null; credit_rows: bigint | number | string | null; unique_users: bigint | number | string | null }>>`
          SELECT
            COALESCE(SUM(h.amount_coins), 0)::float8 AS total_coins,
            COALESCE(SUM(h.amount_usd), 0)::float8 AS total_usd,
            COUNT(*)::bigint AS credit_rows,
            COUNT(DISTINCT h.user_id)::bigint AS unique_users
          FROM mining_block_history h
          WHERE h.window_end_ms >= ${from} AND h.window_end_ms <= ${to}
        `;
    const r = rows[0];
    return { totalCoins: asNum(r?.total_coins), totalUsd: asNum(r?.total_usd), creditRows: asNum(r?.credit_rows), uniqueUsers: asNum(r?.unique_users) };
  }, EMPTY_TOTALS);
}

export async function getDistributionOverview(
  customFromMs?: number | null,
  customToMs?: number | null
): Promise<{
  generatedAtMs: number;
  timezone: 'UTC';
  periods: { today: DistributionOverviewPeriod; last7Days: DistributionOverviewPeriod; last30Days: DistributionOverviewPeriod; custom: DistributionOverviewPeriod | null };
}> {
  const now = Date.now();
  const todayStart = utcDayStartMsFromTs(now);

  const today = await aggregateFromBlockHistory(todayStart, now);
  const last7Start = todayStart - LAST_7_DAYS_OFFSET * MS_PER_DAY;
  const last7 = await aggregateFromBlockHistory(last7Start, now);
  const last30Start = todayStart - LAST_30_DAYS_OFFSET * MS_PER_DAY;
  const last30 = await aggregateFromBlockHistory(last30Start, now);

  let custom: DistributionOverviewPeriod | null = null;
  if (customFromMs != null && customToMs != null && customToMs >= customFromMs) {
    const totals = await aggregateFromBlockHistory(customFromMs, customToMs);
    custom = { label: 'custom', fromMs: customFromMs, toMs: customToMs, ...totals };
  }

  return {
    generatedAtMs: now,
    timezone: 'UTC',
    periods: {
      today: { label: 'today', fromMs: todayStart, toMs: now, ...today },
      last7Days: { label: 'last7Days', fromMs: last7Start, toMs: now, ...last7 },
      last30Days: { label: 'last30Days', fromMs: last30Start, toMs: now, ...last30 },
      custom
    }
  };
}

export async function getDistributionByCoin(fromMs: number, toMs: number): Promise<{ fromMs: number; toMs: number; rows: DistributionByCoinRow[]; totals: DistributionTotals }> {
  return runOrDegradeIfTableMissing(async () => {
    const from = Math.floor(fromMs);
    const to = Math.floor(toMs);
    const rows = await prisma.$queryRaw<
      Array<{
        coin_id: string;
        symbol: string | null;
        name: string | null;
        block_reward: number | string | null;
        block_time: number | string | null;
        total_coins: number | string | null;
        total_usd: number | string | null;
        credit_rows: bigint | number | string | null;
        unique_users: bigint | number | string | null;
      }>
    >`
      SELECT
          h.coin_id,
          COALESCE(c.symbol, h.coin_id) AS symbol,
          COALESCE(c.name, h.coin_id) AS name,
          c.block_reward,
          c.block_time,
          COALESCE(SUM(h.amount_coins), 0)::float8 AS total_coins,
          COALESCE(SUM(h.amount_usd), 0)::float8 AS total_usd,
          COUNT(*)::bigint AS credit_rows,
          COUNT(DISTINCT h.user_id)::bigint AS unique_users
        FROM mining_block_history h
        LEFT JOIN mining_coins c ON c.id = h.coin_id
        WHERE h.window_end_ms >= ${from} AND h.window_end_ms <= ${to}
        GROUP BY h.coin_id, c.symbol, c.name, c.block_reward, c.block_time
        ORDER BY total_usd DESC, total_coins DESC
    `;

    const dayCount = daysBetweenUtc(fromMs, toMs);
    let totalUsdAll = 0;
    const mapped: DistributionByCoinRow[] = rows.map((r) => {
      const totalUsd = asNum(r.total_usd);
      totalUsdAll += totalUsd;
      const blockReward = asNum(r.block_reward);
      const blockTime = asNum(r.block_time);
      let theoreticalEmissionCoins: number | null = null;
      let emissionUtilizationPct: number | null = null;
      if (blockReward > 0 && blockTime > 0) {
        theoreticalEmissionCoins = blockReward * (SECONDS_PER_DAY / blockTime) * dayCount;
        const distributed = asNum(r.total_coins);
        if (theoreticalEmissionCoins > 0) {
          emissionUtilizationPct = (distributed / theoreticalEmissionCoins) * PERCENT_MULTIPLIER;
        }
      }
      return {
        coinId: r.coin_id,
        symbol: String(r.symbol || r.coin_id),
        name: String(r.name || r.coin_id),
        totalCoins: asNum(r.total_coins),
        totalUsd,
        creditRows: asNum(r.credit_rows),
        uniqueUsers: asNum(r.unique_users),
        pctOfTotalUsd: 0,
        theoreticalEmissionCoins,
        emissionUtilizationPct
      };
    });

    for (const row of mapped) {
      row.pctOfTotalUsd = totalUsdAll > 0 ? (row.totalUsd / totalUsdAll) * PERCENT_MULTIPLIER : 0;
    }

    const totals = mapped.reduce<DistributionTotals>(
      (acc, r) => ({ totalCoins: acc.totalCoins + r.totalCoins, totalUsd: acc.totalUsd + r.totalUsd, creditRows: acc.creditRows + r.creditRows, uniqueUsers: acc.uniqueUsers }),
      { totalCoins: 0, totalUsd: 0, creditRows: 0, uniqueUsers: 0 }
    );

    return { fromMs, toMs, rows: mapped, totals };
  }, { fromMs, toMs, rows: [], totals: EMPTY_TOTALS });
}

export async function getDistributionTimeline(fromMs: number, toMs: number, bucket: 'day' | 'week', coinId?: string): Promise<{ bucket: 'day' | 'week'; rows: DistributionTimelineRow[] }> {
  return runOrDegradeIfTableMissing(async () => {
    const from = Math.floor(fromMs);
    const to = Math.floor(toMs);
    const trunc = Prisma.raw(bucket === 'week' ? 'week' : 'day');
    const rows = coinId
      ? await prisma.$queryRaw<Array<{ bucket_start: Date | string; total_coins: number | string | null; total_usd: number | string | null; credit_rows: bigint | number | string | null; unique_users: bigint | number | string | null }>>`
          SELECT
              date_trunc(${trunc}, to_timestamp(h.window_end_ms / 1000.0) AT TIME ZONE 'UTC') AS bucket_start,
              COALESCE(SUM(h.amount_coins), 0)::float8 AS total_coins,
              COALESCE(SUM(h.amount_usd), 0)::float8 AS total_usd,
              COUNT(*)::bigint AS credit_rows,
              COUNT(DISTINCT h.user_id)::bigint AS unique_users
            FROM mining_block_history h
            WHERE h.window_end_ms >= ${from} AND h.window_end_ms <= ${to} AND h.coin_id = ${coinId}
            GROUP BY bucket_start
            ORDER BY bucket_start ASC
        `
      : await prisma.$queryRaw<Array<{ bucket_start: Date | string; total_coins: number | string | null; total_usd: number | string | null; credit_rows: bigint | number | string | null; unique_users: bigint | number | string | null }>>`
          SELECT
              date_trunc(${trunc}, to_timestamp(h.window_end_ms / 1000.0) AT TIME ZONE 'UTC') AS bucket_start,
              COALESCE(SUM(h.amount_coins), 0)::float8 AS total_coins,
              COALESCE(SUM(h.amount_usd), 0)::float8 AS total_usd,
              COUNT(*)::bigint AS credit_rows,
              COUNT(DISTINCT h.user_id)::bigint AS unique_users
            FROM mining_block_history h
            WHERE h.window_end_ms >= ${from} AND h.window_end_ms <= ${to}
            GROUP BY bucket_start
            ORDER BY bucket_start ASC
        `;

    const BUCKET_LABEL_LENGTH = 10;
    const mapped: DistributionTimelineRow[] = rows.map((r) => {
      const d = r.bucket_start instanceof Date ? r.bucket_start : new Date(String(r.bucket_start));
      return {
        bucketStartMs: d.getTime(),
        bucketLabel: d.toISOString().slice(0, BUCKET_LABEL_LENGTH),
        totalCoins: asNum(r.total_coins),
        totalUsd: asNum(r.total_usd),
        creditRows: asNum(r.credit_rows),
        uniqueUsers: asNum(r.unique_users)
      };
    });

    return { bucket, rows: mapped };
  }, { bucket, rows: [] });
}

export type CreditsQueryFilters = {
  fromMs: number;
  toMs: number;
  userId?: number;
  coinId?: string;
  roomId?: string;
  q?: string;
  page: number;
  limit: number;
};

export function validateCreditsRange(fromMs: number, toMs: number, forExport: boolean): string | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return 'Intervalo de datas inválido (from/to).';
  }
  if (toMs - fromMs > MAX_LEDGER_RANGE_MS) {
    return forExport ? `Intervalo máximo de ${MAX_LEDGER_RANGE_DAYS} dias para exportação.` : `Intervalo máximo de ${MAX_LEDGER_RANGE_DAYS} dias no ledger.`;
  }
  return null;
}

function buildCreditsWhere(filters: CreditsQueryFilters): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`h.window_end_ms >= ${Math.floor(filters.fromMs)}`, Prisma.sql`h.window_end_ms <= ${Math.floor(filters.toMs)}`];
  if (filters.userId != null && Number.isFinite(filters.userId)) clauses.push(Prisma.sql`h.user_id = ${Math.floor(filters.userId)}`);
  if (filters.coinId) clauses.push(Prisma.sql`h.coin_id = ${filters.coinId}`);
  if (filters.roomId) clauses.push(Prisma.sql`h.room_id = ${filters.roomId}`);
  if (filters.q) {
    const qNorm = filters.q.replace(/%/g, '').trim().toLowerCase();
    clauses.push(Prisma.sql`(LOWER(COALESCE(u.username,'')) LIKE ${`%${qNorm}%`} OR LOWER(COALESCE(u.email,'')) LIKE ${`%${qNorm}%`} OR u.id::text = ${qNorm})`);
  }
  return Prisma.join(clauses, ' AND ');
}

type LedgerRawRow = {
  id: bigint | number | string;
  user_id: number;
  username: string | null;
  email: string | null;
  coin_id: string;
  coin_symbol: string | null;
  room_id: string | null;
  window_start_ms: bigint | number;
  window_end_ms: bigint | number;
  credit_blocks: number;
  amount_coins: number | string | null;
  amount_usd: number | string | null;
  user_hash_hps: number | string | null;
  network_hashrate: number | string | null;
  block_reward: number | string | null;
  block_time: number | string | null;
  created_at: bigint | number;
};

function mapLedgerRow(r: LedgerRawRow): MiningCreditLedgerRow {
  return {
    id: String(r.id),
    userId: r.user_id,
    username: r.username,
    email: r.email,
    coinId: r.coin_id,
    coinSymbol: r.coin_symbol,
    roomId: r.room_id,
    windowStartMs: asNum(r.window_start_ms),
    windowEndMs: asNum(r.window_end_ms),
    creditBlocks: r.credit_blocks,
    amountCoins: asNum(r.amount_coins),
    amountUsd: asNum(r.amount_usd),
    userHashHps: asNum(r.user_hash_hps),
    networkHashrate: asNum(r.network_hashrate),
    blockReward: asNum(r.block_reward),
    blockTime: asNum(r.block_time),
    createdAtMs: asNum(r.created_at)
  };
}

export async function getMiningCreditsLedger(filters: CreditsQueryFilters): Promise<{ total: number; page: number; limit: number; rows: MiningCreditLedgerRow[] }> {
  const err = validateCreditsRange(filters.fromMs, filters.toMs, false);
  if (err) throw new HttpControlledError(HTTP_BAD_REQUEST, { error: err });

  const limit = clamp(filters.limit, 1, MAX_LEDGER_LIMIT);
  const page = clamp(filters.page, 1, MAX_LEDGER_PAGE);
  const offset = (page - 1) * limit;

  return runOrDegradeIfTableMissing(async () => {
    const where = buildCreditsWhere(filters);

    const totalRows = await prisma.$queryRaw<Array<{ total: bigint | number | string | null }>>`
      SELECT COUNT(*)::bigint AS total FROM mining_block_history h LEFT JOIN users u ON u.id = h.user_id WHERE ${where}
    `;
    const total = asNum(totalRows[0]?.total);

    const rows = await prisma.$queryRaw<LedgerRawRow[]>`
      SELECT
          h.id, h.user_id, u.username, u.email, h.coin_id, c.symbol AS coin_symbol, h.room_id,
          h.window_start_ms, h.window_end_ms, h.credit_blocks, h.amount_coins, h.amount_usd,
          h.user_hash_hps, h.network_hashrate, h.block_reward, h.block_time, h.created_at
        FROM mining_block_history h
        LEFT JOIN users u ON u.id = h.user_id
        LEFT JOIN mining_coins c ON c.id = h.coin_id
        WHERE ${where}
        ORDER BY h.window_end_ms DESC, h.id DESC
        LIMIT ${limit} OFFSET ${offset}
    `;

    return { total, page, limit, rows: rows.map(mapLedgerRow) };
  }, { total: 0, page, limit, rows: [] });
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function streamMiningCreditsCsv(filters: CreditsQueryFilters, write: (chunk: string) => void): Promise<{ rowsWritten: number; truncated: boolean }> {
  const err = validateCreditsRange(filters.fromMs, filters.toMs, true);
  if (err) throw new HttpControlledError(HTTP_BAD_REQUEST, { error: err });

  return runOrDegradeIfTableMissing(async () => {
    const where = buildCreditsWhere(filters);
    const rows = await prisma.$queryRaw<LedgerRawRow[]>`
      SELECT
          h.id, h.user_id, u.username, u.email, h.coin_id, c.symbol AS coin_symbol, h.room_id,
          h.window_start_ms, h.window_end_ms, h.credit_blocks, h.amount_coins, h.amount_usd,
          h.user_hash_hps, h.network_hashrate, h.created_at
        FROM mining_block_history h
        LEFT JOIN users u ON u.id = h.user_id
        LEFT JOIN mining_coins c ON c.id = h.coin_id
        WHERE ${where}
        ORDER BY h.window_end_ms DESC, h.id DESC
        LIMIT ${MAX_EXPORT_ROWS + 1}
    `;

    const truncated = rows.length > MAX_EXPORT_ROWS;
    const slice = truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows;

    write('id,user_id,username,email,coin_id,coin_symbol,room_id,window_start_utc,window_end_utc,credit_blocks,amount_coins,amount_usd,user_hash_hps,network_hashrate,created_at_utc\n');
    for (const r of slice) {
      const cells = [
        r.id,
        r.user_id,
        r.username ?? '',
        r.email ?? '',
        r.coin_id,
        r.coin_symbol ?? '',
        r.room_id ?? '',
        new Date(asNum(r.window_start_ms)).toISOString(),
        new Date(asNum(r.window_end_ms)).toISOString(),
        r.credit_blocks,
        asNum(r.amount_coins),
        asNum(r.amount_usd),
        asNum(r.user_hash_hps),
        asNum(r.network_hashrate),
        new Date(asNum(r.created_at)).toISOString()
      ].map(csvCell);
      write(cells.join(',') + '\n');
    }

    return { rowsWritten: slice.length, truncated };
  }, { rowsWritten: 0, truncated: false });
}

export async function getUserMiningDistributionSummary(
  userId: number,
  fromMs: number,
  toMs: number
): Promise<{ userId: number; fromMs: number; toMs: number; totals: DistributionTotals; byCoin: DistributionByCoinRow[] }> {
  const err = validateCreditsRange(fromMs, toMs, false);
  if (err) throw new HttpControlledError(HTTP_BAD_REQUEST, { error: err });

  return runOrDegradeIfTableMissing(async () => {
    const from = Math.floor(fromMs);
    const to = Math.floor(toMs);
    const filtered = await prisma.$queryRaw<Array<{ coin_id: string; symbol: string | null; name: string | null; total_coins: number | string | null; total_usd: number | string | null; credit_rows: bigint | number | string | null }>>`
      SELECT
          h.coin_id, COALESCE(c.symbol, h.coin_id) AS symbol, COALESCE(c.name, h.coin_id) AS name,
          COALESCE(SUM(h.amount_coins), 0)::float8 AS total_coins,
          COALESCE(SUM(h.amount_usd), 0)::float8 AS total_usd,
          COUNT(*)::bigint AS credit_rows
        FROM mining_block_history h
        LEFT JOIN mining_coins c ON c.id = h.coin_id
        WHERE h.user_id = ${userId} AND h.window_end_ms >= ${from} AND h.window_end_ms <= ${to}
        GROUP BY h.coin_id, c.symbol, c.name
        ORDER BY total_usd DESC
    `;

    let totalUsdAll = 0;
    const byCoin: DistributionByCoinRow[] = filtered.map((r) => {
      const totalUsd = asNum(r.total_usd);
      totalUsdAll += totalUsd;
      return {
        coinId: r.coin_id,
        symbol: String(r.symbol || r.coin_id),
        name: String(r.name || r.coin_id),
        totalCoins: asNum(r.total_coins),
        totalUsd,
        creditRows: asNum(r.credit_rows),
        uniqueUsers: 1,
        pctOfTotalUsd: 0,
        theoreticalEmissionCoins: null,
        emissionUtilizationPct: null
      };
    });
    for (const row of byCoin) {
      row.pctOfTotalUsd = totalUsdAll > 0 ? (row.totalUsd / totalUsdAll) * PERCENT_MULTIPLIER : 0;
    }

    const userTotals = await aggregateFromBlockHistory(fromMs, toMs);
    return { userId, fromMs, toMs, totals: { ...userTotals, uniqueUsers: 1 }, byCoin };
  }, { userId, fromMs, toMs, totals: { ...EMPTY_TOTALS, uniqueUsers: 1 }, byCoin: [] });
}
