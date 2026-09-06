/**
 * PG — UNIQUE(coin_id, effective_at) + ON CONFLICT DO NOTHING.
 * Skip automático se a BD / índice único ainda não existir.
 */
import { describe, expect, it } from 'vitest';
import { makeTag, registerPgIntegrationLifecycle, type PgFixtureCtx } from './harness.js';
import { MINING_YIELD_HISTORY_INSERT_SQL } from '../../../server/modules/mining-engine/services/yield-cron.js';

describe('PG integration — mining_yield_history idempotency', () => {
  let ctx: PgFixtureCtx | null = null;
  registerPgIntegrationLifecycle(
    () => ctx,
    (c) => {
      ctx = c;
    }
  );

  async function uniqueReady(pool: PgFixtureCtx['pool']): Promise<boolean> {
    const r = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'mining_yield_history_coin_effective_uidx'
       ) AS exists`
    );
    return Boolean(r.rows[0]?.exists);
  }

  it('TESTE A — dois INSERTs concorrentes → exactamente 1 row', async () => {
    const c = ctx!;
    if (!(await uniqueReady(c.pool))) {
      console.warn('[itest] UNIQUE mining_yield_history_coin_effective_uidx ausente — skip (aplicar migration)');
      return;
    }
    const tag = makeTag();
    const coinId = `${tag}_pol`;
    const effectiveAt = Date.UTC(2026, 7, 20, 22, 30, 0, 0);

    const insertOnce = () =>
      c.pool.query(MINING_YIELD_HISTORY_INSERT_SQL, [
        [coinId],
        [0.01],
        [1],
        [1000],
        [effectiveAt]
      ]);

    try {
      const results = await Promise.allSettled([insertOnce(), insertOnce()]);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(0);

      const count = await c.pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM mining_yield_history WHERE coin_id = $1 AND effective_at = $2`,
        [coinId, effectiveAt]
      );
      expect(Number(count.rows[0]?.n)).toBe(1);

      // reexecução: não duplica
      await insertOnce();
      const count2 = await c.pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM mining_yield_history WHERE coin_id = $1 AND effective_at = $2`,
        [coinId, effectiveAt]
      );
      expect(Number(count2.rows[0]?.n)).toBe(1);
    } finally {
      await c.pool.query(`DELETE FROM mining_yield_history WHERE coin_id = $1`, [coinId]);
    }
  });

  it('após UNIQUE: zero duplicatas canónicas (amostra global)', async () => {
    const c = ctx!;
    if (!(await uniqueReady(c.pool))) {
      console.warn('[itest] UNIQUE ausente — skip diagnóstico de duplicatas');
      return;
    }
    const dups = await c.pool.query(
      `SELECT coin_id, effective_at, COUNT(*)::int AS total
       FROM mining_yield_history
       GROUP BY coin_id, effective_at
       HAVING COUNT(*) > 1
       LIMIT 5`
    );
    expect(dups.rows).toHaveLength(0);
  });
});
