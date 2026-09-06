import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MINING_YIELD_HISTORY_INSERT_SQL } from '../../../../server/modules/mining-engine/services/yield-cron.js';

const ROOT = resolve(__dirname, '../../../..');

describe('mining_yield_history — UNIQUE + migration', () => {
  it('schema declara @@unique([coin_id, effective_at])', () => {
    const schema = readFileSync(resolve(ROOT, 'prisma/schema.prisma'), 'utf8');
    const block = schema.slice(schema.indexOf('model mining_yield_history'), schema.indexOf('model mining_distribution_daily'));
    expect(block).toMatch(/@@unique\(\[coin_id,\s*effective_at\].*mining_yield_history_coin_effective_uidx/);
    expect(block).not.toMatch(/@@index\(\[coin_id,\s*effective_at\]/);
  });

  it('migration: dedupe por MIN(id) + UNIQUE index; PostgreSQL', () => {
    const sql = readFileSync(
      resolve(ROOT, 'prisma/migrations/20260821040000_mining_yield_history_coin_effective_unique/migration.sql'),
      'utf8'
    );
    expect(sql).toMatch(/PARTITION BY coin_id, effective_at/);
    expect(sql).toMatch(/ORDER BY id ASC/);
    expect(sql).toMatch(/WHERE ranked\.rn > 1/);
    expect(sql).toMatch(/DROP INDEX IF EXISTS "mining_yield_history_coin_effective_idx"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "mining_yield_history_coin_effective_uidx"/);
    expect(sql).toMatch(/ON "mining_yield_history" \("coin_id", "effective_at"\)/);
  });

  it('INSERT canónico usa ON CONFLICT DO NOTHING (não SELECT+INSERT)', () => {
    expect(MINING_YIELD_HISTORY_INSERT_SQL).toContain('ON CONFLICT (coin_id, effective_at) DO NOTHING');
    expect(MINING_YIELD_HISTORY_INSERT_SQL).toContain('UNNEST');
    expect(MINING_YIELD_HISTORY_INSERT_SQL.toLowerCase()).not.toMatch(/select .* from mining_yield_history.*insert/s);
  });

  it('TESTE A (simulação): dois writers → exactamente 1 row por (coin, boundary)', () => {
    /** Simula UNIQUE + ON CONFLICT DO NOTHING. */
    const store = new Map<string, { yield_per_hash: number }>();
    function insert(coinId: string, effectiveAt: number, yieldPerHash: number): 'inserted' | 'conflict' {
      const key = `${coinId}|${effectiveAt}`;
      if (store.has(key)) return 'conflict';
      store.set(key, { yield_per_hash: yieldPerHash });
      return 'inserted';
    }
    expect(insert('POL', 22_30, 1)).toBe('inserted');
    expect(insert('POL', 22_30, 999)).toBe('conflict');
    expect(store.size).toBe(1);
    expect(store.get('POL|2230')!.yield_per_hash).toBe(1);
  });
});
