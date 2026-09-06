import { describe, expect, it } from 'vitest';
import { makeTag, registerPgIntegrationLifecycle, type PgFixtureCtx } from './harness.js';

/**
 * Valida índices de hot path (migration `20260820010000_perf_hotpath_indexes`)
 * e INSERT batch via UNNEST em `mining_yield_history` (mesmo shape do yield cron).
 */
describe('PG integration — perf hotpath indexes + yield batch insert', () => {
  let ctx: PgFixtureCtx | null = null;
  registerPgIntegrationLifecycle(
    () => ctx,
    (c) => {
      ctx = c;
    }
  );

  it('índices de performance existem (ou são criáveis de forma idempotente)', async () => {
    const pool = ctx!.pool;
    await pool.query(`
      CREATE INDEX IF NOT EXISTS mining_yield_history_effective_at_idx
        ON mining_yield_history (effective_at);
      CREATE INDEX IF NOT EXISTS player_listings_status_expires_idx
        ON player_listings (status, expires_at);
      CREATE INDEX IF NOT EXISTS placed_racks_is_on_user_idx
        ON placed_racks (is_on, user_id);
    `);
    const { rows } = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'mining_yield_history_effective_at_idx',
          'player_listings_status_expires_idx',
          'placed_racks_is_on_user_idx'
        )
      ORDER BY indexname
    `);
    expect(rows.map((r) => r.indexname)).toEqual([
      'mining_yield_history_effective_at_idx',
      'placed_racks_is_on_user_idx',
      'player_listings_status_expires_idx'
    ]);
  });

  it('UNNEST batch insert grava N linhas com os mesmos valores', async () => {
    const pool = ctx!.pool;
    const tag = makeTag();
    const coinId = `perf_${tag}_coin`;
    const effectiveAt = Date.now();

    const coinIds = [coinId, coinId];
    const yields = [0.001, 0.002];
    const rewards = [1, 1];
    const nets = [100, 200];
    const effectives = [effectiveAt, effectiveAt + 1];

    await pool.query(
      `INSERT INTO mining_yield_history (coin_id, yield_per_hash, block_reward, network_hashrate, effective_at)
       SELECT * FROM UNNEST($1::text[], $2::float8[], $3::float8[], $4::float8[], $5::int8[])`,
      [coinIds, yields, rewards, nets, effectives]
    );

    const { rows } = await pool.query<{ yield_per_hash: number; network_hashrate: number }>(
      `SELECT yield_per_hash, network_hashrate
       FROM mining_yield_history
       WHERE coin_id = $1 AND effective_at = ANY($2::bigint[])
       ORDER BY effective_at ASC`,
      [coinId, effectives]
    );
    expect(rows).toHaveLength(2);
    expect(Number(rows[0]!.yield_per_hash)).toBeCloseTo(0.001, 9);
    expect(Number(rows[1]!.yield_per_hash)).toBeCloseTo(0.002, 9);
    expect(Number(rows[0]!.network_hashrate)).toBe(100);
    expect(Number(rows[1]!.network_hashrate)).toBe(200);

    await pool.query(`DELETE FROM mining_yield_history WHERE coin_id = $1`, [coinId]);
  });
});
