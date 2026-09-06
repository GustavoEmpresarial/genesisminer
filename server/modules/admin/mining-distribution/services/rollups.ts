/**
 * Reconstrução dos rollups diários UTC (`mining_distribution_daily`, tracked no Prisma)
 * a partir de `mining_block_history` (não tracked — ver aviso em `./report.ts`).
 *
 * Migrado de legacy/backend/services/adminMiningDistribution.service.ts (parte de
 * escrita). `pool: Pool` deixou de vir por parâmetro — importa o singleton
 * `core/database/pool.js` directamente (mesmo padrão de `modules/shop`/`modules/servers`).
 */
import db from '../../../../core/database/pool.js';
import { MS_PER_DAY } from '../../../../shared/utils/time.js';
import { utcDayStartMsFromTs, ymdFromUtcMs } from './dates.js';

const DEFAULT_ROLLUP_DAYS_BACK = 45;
const POSTGRES_UNDEFINED_TABLE_CODE = '42P01';

let miningBlockHistoryMissingWarned = false;

/**
 * Reconstrói rollups diários UTC para o intervalo [fromDayYmd, toDayYmd] inclusive.
 * Degrada graciosamente (0 processado) se `mining_block_history` não existir na base —
 * mesmo tratamento defensivo do resto do domínio (ver `./report.ts`).
 */
export async function rebuildMiningDistributionRollups(fromDayYmd: string, toDayYmd: string): Promise<{ daysProcessed: number; rowsUpserted: number }> {
  const client = await db.connect();
  try {
    const r = await client.query(
      `INSERT INTO mining_distribution_daily (
          day_utc, coin_id, total_coins, total_usd, credit_rows, unique_users, updated_at
        )
        SELECT
          (to_timestamp(h.window_end_ms / 1000.0) AT TIME ZONE 'UTC')::date AS day_utc,
          h.coin_id,
          COALESCE(SUM(h.amount_coins), 0)::float8,
          COALESCE(SUM(h.amount_usd), 0)::float8,
          COUNT(*)::int,
          COUNT(DISTINCT h.user_id)::int,
          (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
        FROM mining_block_history h
        WHERE (to_timestamp(h.window_end_ms / 1000.0) AT TIME ZONE 'UTC')::date >= $1::date
          AND (to_timestamp(h.window_end_ms / 1000.0) AT TIME ZONE 'UTC')::date <= $2::date
        GROUP BY day_utc, h.coin_id
        ON CONFLICT (day_utc, coin_id) DO UPDATE SET
          total_coins = EXCLUDED.total_coins,
          total_usd = EXCLUDED.total_usd,
          credit_rows = EXCLUDED.credit_rows,
          unique_users = EXCLUDED.unique_users,
          updated_at = EXCLUDED.updated_at`,
      [fromDayYmd, toDayYmd]
    );
    const fromMs = Date.parse(`${fromDayYmd}T00:00:00.000Z`);
    const toMs = Date.parse(`${toDayYmd}T23:59:59.999Z`);
    const daysProcessed = Number.isFinite(fromMs) && Number.isFinite(toMs) ? Math.max(0, Math.round((utcDayStartMsFromTs(toMs) - utcDayStartMsFromTs(fromMs)) / MS_PER_DAY) + 1) : 0;
    return { daysProcessed, rowsUpserted: r.rowCount ?? 0 };
  } catch (e: unknown) {
    const code = e && typeof e === 'object' && 'code' in e ? String((e as { code?: string }).code) : '';
    if (code === POSTGRES_UNDEFINED_TABLE_CODE) {
      if (!miningBlockHistoryMissingWarned) {
        miningBlockHistoryMissingWarned = true;
        console.warn('[AdminMiningDistribution] tabela mining_block_history ausente (42P01) — rebuild de rollups sem efeito.');
      }
      return { daysProcessed: 0, rowsUpserted: 0 };
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Últimos N dias UTC (inclui hoje) para rebuild automático. */
export async function rebuildMiningDistributionRollupsRecent(daysBack = DEFAULT_ROLLUP_DAYS_BACK): Promise<{ daysProcessed: number; rowsUpserted: number }> {
  const now = Date.now();
  const toYmd = ymdFromUtcMs(now);
  const fromMs = utcDayStartMsFromTs(now) - (daysBack - 1) * MS_PER_DAY;
  const fromYmd = ymdFromUtcMs(fromMs);
  return rebuildMiningDistributionRollups(fromYmd, toYmd);
}
