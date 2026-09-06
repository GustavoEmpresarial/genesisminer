/**
 * Plano 5 — integração PG+Redis: concorrência, retry, atomicidade, mismatch.
 * Skip se DATABASE_URL não ligar. Não corre no `npm test` default.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createUser,
  makeTag,
  registerPgIntegrationLifecycle,
  type PgFixtureCtx
} from './harness.js';
import { amountsAlmostEqual } from '../../../server/modules/mining-engine/services/mining-economic-epsilon.js';
import { TEN_MIN_MS, miningCreditCapNowMs } from '../../../server/modules/mining-engine/services/wall-clock-grid.js';

const TEN = TEN_MIN_MS;

async function ensureHistoryUnique(pool: PgFixtureCtx['pool']): Promise<{ hasUnique: boolean }> {
  const idx = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM pg_indexes
      WHERE schemaname='public' AND indexname='mining_block_history_user_coin_window_uidx'`
  );
  const hasUnique = Number(idx.rows[0]?.n || 0) > 0;
  return { hasUnique };
}

async function cleanupMiningUser(pool: PgFixtureCtx['pool'], userId: number): Promise<void> {
  await pool.query(`DELETE FROM mining_block_history WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM mining_progress_commit_ledger WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM coin_balances WHERE user_id = $1`, [userId]);
  await pool.query(
    `DELETE FROM rack_slots WHERE rack_id IN (SELECT id FROM placed_racks WHERE user_id = $1)`,
    [userId]
  );
  await pool.query(
    `DELETE FROM rack_multiplier_slots WHERE rack_id IN (SELECT id FROM placed_racks WHERE user_id = $1)`,
    [userId]
  );
  await pool.query(`DELETE FROM placed_racks WHERE user_id = $1`, [userId]);
}

async function pickActiveCoin(pool: PgFixtureCtx['pool']): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM mining_coins WHERE is_active = 1 ORDER BY id LIMIT 1`
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('no active mining_coins');
  return id;
}

async function pickMachineUpgrade(pool: PgFixtureCtx['pool']): Promise<{ id: string; hps: number }> {
  const r = await pool.query<{ id: string; base_production: string }>(
    `SELECT id, base_production::text AS base_production
       FROM upgrades
      WHERE type = 'machine' AND is_active = 1 AND COALESCE(base_production, 0) > 0
      ORDER BY base_production::float8 ASC
      LIMIT 1`
  );
  const row = r.rows[0];
  if (!row) throw new Error('no machine upgrade');
  return { id: row.id, hps: Number(row.base_production) };
}

async function seedMiningUser(
  c: PgFixtureCtx,
  opts?: { rackCount?: number }
): Promise<{ userId: number; coinId: string; last: number; creditCap: number; now: number }> {
  const tag = makeTag();
  const coinId = await pickActiveCoin(c.pool);
  const machine = await pickMachineUpgrade(c.pool);
  const chassisId = `${tag}_chassis`;
  c.upgradeIds.push(chassisId);
  await c.pool.query(
    `INSERT INTO upgrades (
       id, name, category, type, base_cost, base_production, description, icon, status,
       is_nft, sell_in_hardware_market, sell_in_black_market, is_active, rarity, total_sold
     ) VALUES ($1, $2, 'rack', 'rack', 1, 0, 'itest', 'x', 'active', 0, 0, 0, 1, 'common', 0)
     ON CONFLICT (id) DO NOTHING`,
    [chassisId, `itest chassis ${tag}`]
  );

  const now = Date.now();
  const creditCap = miningCreditCapNowMs(now);
  const last = creditCap - 3 * TEN;
  const userId = await createUser(c.pool, {
    username: `${tag}_miner`,
    email: `${tag}_miner@itest.local`,
    usdc: 0
  });
  c.userIds.push(userId);
  c.usernames.push(`${tag}_miner`);

  await c.pool.query(
    `UPDATE game_states
        SET last_updated_at = $2, start_time = $2, last_checkin_at_ms = $3, checkin_bonus_hps = 0
      WHERE user_id = $1`,
    [userId, last, now]
  );

  const rackCount = opts?.rackCount ?? 1;
  for (let i = 0; i < rackCount; i++) {
    const rackId = `${tag}_rack_${i}`;
    const batteryId = randomUUID();
    await c.pool.query(
      `INSERT INTO placed_racks (
         id, user_id, item_id, wiring_id, battery_id, is_on, selected_coin_id, room_id, slot_index
       ) VALUES ($1, $2, $3, 'wiring_itest', $4, 1, $5, 'room_initial', $6)`,
      [rackId, userId, chassisId, batteryId, coinId, i]
    );
    await c.pool.query(`INSERT INTO rack_slots (rack_id, machine_item_id, slot_index) VALUES ($1, $2, 0)`, [
      rackId,
      machine.id
    ]);
  }

  // Yield estável no intervalo
  await c.pool.query(
    `INSERT INTO mining_yield_history (coin_id, yield_per_hash, effective_at)
     VALUES ($1, 0.001, $2)
     ON CONFLICT (coin_id, effective_at) DO UPDATE SET yield_per_hash = EXCLUDED.yield_per_hash`,
    [coinId, last - TEN]
  );
  return { userId, coinId, last, creditCap, now };
}

describe.skipIf(!String(process.env.GENESIS_MINING_WORKER_URL ?? '').trim())(
  'PG integration — mining progress P5',
  () => {
  let ctx: PgFixtureCtx | null = null;
  registerPgIntegrationLifecycle(
    () => ctx,
    (c) => {
      ctx = c;
    }
  );

  it('concorrência 2/5/10/20 workers: 1 crédito económico + history canónico', async () => {
    const c = ctx!;
    process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    process.env.MINING_PROGRESS_REQUIRE_REDIS_LOCK = '0';
    process.env.MINING_WALL_CLOCK_TEN_MIN_GRID = '1';
    process.env.MINING_PROGRESS_LEDGER_ENABLED = '1';
    process.env.GENESIS_REDIS_LOCKS_ENABLED = '1';

    await ensureHistoryUnique(c.pool);
    const { computeProgressForUser } = await import(
      '../../../server/modules/mining-engine/services/progress-computer.js'
    );

    for (const workers of [2, 5, 10, 20]) {
      const seeded = await seedMiningUser(c, { rackCount: 2 });
      try {
        const balBefore = await c.pool.query<{ amount: string }>(
          `SELECT COALESCE(SUM(amount),0)::text AS amount FROM coin_balances WHERE user_id=$1 AND coin_id=$2`,
          [seeded.userId, seeded.coinId]
        );
        const beforeAmt = Number(balBefore.rows[0]?.amount || 0);

        const settled = await Promise.all(
          Array.from({ length: workers }, () =>
            computeProgressForUser(c.pool, seeded.userId, seeded.now, true)
          )
        );
        expect(settled.every((r) => r.ok)).toBe(true);
        const withCredit = settled.filter((r) => r.offlineMined && Object.keys(r.offlineMined).length > 0);
        expect(withCredit.length).toBe(1);

        const balAfter = await c.pool.query<{ amount: string }>(
          `SELECT COALESCE(SUM(amount),0)::text AS amount FROM coin_balances WHERE user_id=$1 AND coin_id=$2`,
          [seeded.userId, seeded.coinId]
        );
        const delta = Number(balAfter.rows[0]?.amount || 0) - beforeAmt;
        expect(delta).toBeGreaterThan(0);

        const led = await c.pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM mining_progress_commit_ledger WHERE user_id=$1`,
          [seeded.userId]
        );
        expect(Number(led.rows[0]?.n)).toBe(1);

        const hist = await c.pool.query<{ n: string; d: string }>(
          `SELECT COUNT(*)::text AS n,
                  COUNT(DISTINCT (coin_id, window_start_ms, window_end_ms))::text AS d
             FROM mining_block_history WHERE user_id=$1`,
          [seeded.userId]
        );
        expect(Number(hist.rows[0]?.n)).toBe(Number(hist.rows[0]?.d));
        expect(Number(hist.rows[0]?.n)).toBeGreaterThan(0);

        const gs = await c.pool.query<{ last_updated_at: string }>(
          `SELECT last_updated_at::text AS last_updated_at FROM game_states WHERE user_id=$1`,
          [seeded.userId]
        );
        expect(Number(gs.rows[0]?.last_updated_at)).toBe(seeded.creditCap);

        const mined = withCredit[0]!.offlineMined![seeded.coinId]!;
        expect(amountsAlmostEqual(delta, mined)).toBe(true);
      } finally {
        await cleanupMiningUser(c.pool, seeded.userId);
      }
    }
  }, 120_000);

  it('REQUIRE_REDIS_LOCK=1 sem Redis efectivo → fail-closed (não credita)', async () => {
    const c = ctx!;
    const prevRedis = process.env.REDIS_URL;
    const prevReq = process.env.MINING_PROGRESS_REQUIRE_REDIS_LOCK;
    process.env.REDIS_URL = '';
    process.env.MINING_PROGRESS_REQUIRE_REDIS_LOCK = '1';
    process.env.GENESIS_REDIS_LOCKS_ENABLED = '1';

    await ensureHistoryUnique(c.pool);
    const seeded = await seedMiningUser(c);
    try {
      // re-import after env change — module may cache; function reads env each call
      const { computeProgressForUser } = await import(
        '../../../server/modules/mining-engine/services/progress-computer.js'
      );
      const r = await computeProgressForUser(c.pool, seeded.userId, seeded.now, true);
      expect(r.ok).toBe(true);
      expect(r.offlineMined == null || Object.keys(r.offlineMined).length === 0).toBe(true);

      const gs = await c.pool.query<{ last_updated_at: string }>(
        `SELECT last_updated_at::text AS last_updated_at FROM game_states WHERE user_id=$1`,
        [seeded.userId]
      );
      expect(Number(gs.rows[0]?.last_updated_at)).toBe(seeded.last);

      const led = await c.pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM mining_progress_commit_ledger WHERE user_id=$1`,
        [seeded.userId]
      );
      expect(Number(led.rows[0]?.n)).toBe(0);
    } finally {
      process.env.REDIS_URL = prevRedis;
      process.env.MINING_PROGRESS_REQUIRE_REDIS_LOCK = prevReq;
      await cleanupMiningUser(c.pool, seeded.userId);
    }
  });

  it('retry idempotente + faultHooks F1..F5 rollback + retry válido', async () => {
    const c = ctx!;
    process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    process.env.MINING_PROGRESS_REQUIRE_REDIS_LOCK = '0';
    process.env.GENESIS_REDIS_LOCKS_ENABLED = '0'; // força só PG barriers neste teste
    await ensureHistoryUnique(c.pool);
    const { computeProgressForUser } = await import(
      '../../../server/modules/mining-engine/services/progress-computer.js'
    );

    const points: Array<{ name: string; hook: 'afterLedger' | 'afterBalances' | 'afterHistory' | 'afterLastUpdated' | 'beforeCommit' }> =
      [
        { name: 'F1', hook: 'afterLedger' },
        { name: 'F2', hook: 'afterBalances' },
        { name: 'F3', hook: 'afterHistory' },
        { name: 'F4', hook: 'afterLastUpdated' },
        { name: 'F5', hook: 'beforeCommit' }
      ];

    for (const p of points) {
      const seeded = await seedMiningUser(c);
      try {
        const fail = await computeProgressForUser(c.pool, seeded.userId, seeded.now, true, {
          faultHooks: {
            [p.hook]: () => {
              throw new Error(`inject_${p.name}`);
            }
          }
        });
        expect(fail.ok).toBe(false);

        const gs = await c.pool.query<{ last_updated_at: string }>(
          `SELECT last_updated_at::text AS last_updated_at FROM game_states WHERE user_id=$1`,
          [seeded.userId]
        );
        expect(Number(gs.rows[0]?.last_updated_at)).toBe(seeded.last);

        const led = await c.pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM mining_progress_commit_ledger WHERE user_id=$1`,
          [seeded.userId]
        );
        expect(Number(led.rows[0]?.n)).toBe(0);

        const hist = await c.pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM mining_block_history WHERE user_id=$1`,
          [seeded.userId]
        );
        expect(Number(hist.rows[0]?.n)).toBe(0);

        const bal = await c.pool.query<{ amount: string }>(
          `SELECT COALESCE(SUM(amount),0)::text AS amount FROM coin_balances WHERE user_id=$1`,
          [seeded.userId]
        );
        expect(Number(bal.rows[0]?.amount || 0)).toBe(0);

        const ok = await computeProgressForUser(c.pool, seeded.userId, seeded.now, true);
        expect(ok.ok).toBe(true);
        expect(ok.offlineMined && Object.keys(ok.offlineMined).length).toBeGreaterThan(0);

        const retry = await computeProgressForUser(c.pool, seeded.userId, seeded.now, true);
        expect(retry.ok).toBe(true);
        expect(retry.offlineMined == null || Object.keys(retry.offlineMined).length === 0).toBe(true);

        const led2 = await c.pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM mining_progress_commit_ledger WHERE user_id=$1`,
          [seeded.userId]
        );
        expect(Number(led2.rows[0]?.n)).toBe(1);
      } finally {
        await cleanupMiningUser(c.pool, seeded.userId);
      }
    }
  }, 120_000);

  it('mismatch canónico: amount B ≠ A → abort sem crédito; last intacto', async () => {
    const c = ctx!;
    process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    process.env.MINING_PROGRESS_REQUIRE_REDIS_LOCK = '0';
    process.env.GENESIS_REDIS_LOCKS_ENABLED = '0';
    await ensureHistoryUnique(c.pool);
    const { computeProgressForUser } = await import(
      '../../../server/modules/mining-engine/services/progress-computer.js'
    );
    const seeded = await seedMiningUser(c);
    try {
      // Pré-insere history com amount absurdo nas janelas do catch-up
      for (let i = 0; i < 3; i++) {
        const ws = seeded.last + i * TEN;
        const we = ws + TEN;
        await c.pool.query(
          `INSERT INTO mining_block_history (
             user_id, coin_id, room_id, window_start_ms, window_end_ms, credit_blocks,
             amount_coins, amount_usd, user_hash_hps, network_hashrate, block_reward, block_time, created_at
           ) VALUES ($1,$2,'', $3,$4,1, 999999, 0, 1, 1, 1, 600, $5)`,
          [seeded.userId, seeded.coinId, ws, we, seeded.now]
        );
      }

      const r = await computeProgressForUser(c.pool, seeded.userId, seeded.now, true);
      expect(r.ok).toBe(false);
      expect(String(r.error || '')).toMatch(/mismatch/i);

      const gs = await c.pool.query<{ last_updated_at: string }>(
        `SELECT last_updated_at::text AS last_updated_at FROM game_states WHERE user_id=$1`,
        [seeded.userId]
      );
      expect(Number(gs.rows[0]?.last_updated_at)).toBe(seeded.last);

      const bal = await c.pool.query<{ amount: string }>(
        `SELECT COALESCE(SUM(amount),0)::text AS amount FROM coin_balances WHERE user_id=$1`,
        [seeded.userId]
      );
      expect(Number(bal.rows[0]?.amount || 0)).toBe(0);

      const led = await c.pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM mining_progress_commit_ledger WHERE user_id=$1`,
        [seeded.userId]
      );
      expect(Number(led.rows[0]?.n)).toBe(0);
    } finally {
      await cleanupMiningUser(c.pool, seeded.userId);
    }
  });
  }
);
