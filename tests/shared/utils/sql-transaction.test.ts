import { describe, expect, it, vi } from 'vitest';
import { pgSqlTx, prismaSqlTx, prismaTxToPoolLikeClient } from '../../../server/shared/utils/sql-transaction.js';

describe('pgSqlTx', () => {
  it('queryRows devolve r.rows', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 }) };
    const tx = pgSqlTx(client as any);
    const rows = await tx.queryRows('SELECT 1');
    expect(rows).toEqual([{ id: 1 }]);
  });

  it('execute devolve rowCount (0 se null)', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: null }) };
    const tx = pgSqlTx(client as any);
    expect(await tx.execute('UPDATE x SET y = 1')).toBe(0);
  });
});

describe('prismaSqlTx', () => {
  it('queryRows usa $queryRawUnsafe e normaliza não-array para []', async () => {
    const tx = { $queryRawUnsafe: vi.fn().mockResolvedValue(null), $executeRawUnsafe: vi.fn() };
    const run = prismaSqlTx(tx as any);
    expect(await run.queryRows('SELECT 1')).toEqual([]);
  });

  it('execute usa $executeRawUnsafe e devolve o número de linhas', async () => {
    const tx = { $queryRawUnsafe: vi.fn(), $executeRawUnsafe: vi.fn().mockResolvedValue(3) };
    const run = prismaSqlTx(tx as any);
    expect(await run.execute('DELETE FROM x')).toBe(3);
  });
});

describe('prismaTxToPoolLikeClient', () => {
  it('BEGIN/COMMIT/ROLLBACK viram no-op (Prisma já controla a transação)', async () => {
    const tx = { $queryRawUnsafe: vi.fn(), $executeRawUnsafe: vi.fn() };
    const client = prismaTxToPoolLikeClient(tx as any);
    const res = await client.query('BEGIN');
    expect(res.rowCount).toBe(0);
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('SELECT roteia para queryRows', async () => {
    const tx = { $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: 1 }]), $executeRawUnsafe: vi.fn() };
    const client = prismaTxToPoolLikeClient(tx as any);
    const res = await client.query('SELECT * FROM users WHERE id = $1', [1]);
    expect(res.rows).toEqual([{ id: 1 }]);
    expect(res.rowCount).toBe(1);
  });

  it('UPDATE/INSERT/DELETE roteia para execute', async () => {
    const tx = { $queryRawUnsafe: vi.fn(), $executeRawUnsafe: vi.fn().mockResolvedValue(2) };
    const client = prismaTxToPoolLikeClient(tx as any);
    const res = await client.query('UPDATE users SET active = true');
    expect(res.rowCount).toBe(2);
    expect(res.rows).toEqual([]);
  });

  it('WITH/SHOW/EXPLAIN/TABLE também são tratados como leitura', async () => {
    const tx = { $queryRawUnsafe: vi.fn().mockResolvedValue([{ n: 1 }]), $executeRawUnsafe: vi.fn() };
    const client = prismaTxToPoolLikeClient(tx as any);
    const res = await client.query('WITH cte AS (SELECT 1) SELECT * FROM cte');
    expect(res.rows).toEqual([{ n: 1 }]);
  });
});
