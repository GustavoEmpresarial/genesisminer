import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { Prisma } from '@prisma/client';
import { HttpControlledError } from '../../../server/shared/errors/http-controlled-error.js';
import {
  ASSERT_ACTIVE_USER_ROW_LOCK,
  BLOCKED_FLAG,
  assertActiveUserPg,
  assertActiveUserPrisma
} from '../../../server/shared/security/assert-active-user-tx.js';

const USER_ID = 7;

function sqlFromFirstArg(fn: ReturnType<typeof vi.fn>): string {
  const first = fn.mock.calls[0]?.[0];
  if (typeof first === 'string') return first;
  if (Array.isArray(first)) return first.join('');
  return '';
}

function mockPg(rows: Array<{ is_blocked: number | null }>): { client: PoolClient; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows });
  return { client: { query } as unknown as PoolClient, query };
}

function mockPrisma(rows: Array<{ is_blocked: number | null }>): {
  tx: Prisma.TransactionClient;
  queryRaw: ReturnType<typeof vi.fn>;
} {
  const queryRaw = vi.fn().mockResolvedValue(rows);
  return { tx: { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient, queryRaw };
}

describe('shared/security/assert-active-user-tx', () => {
  it('assertActiveUserPg: SQL usa FOR NO KEY UPDATE e aceita user ativo', async () => {
    const { client, query } = mockPg([{ is_blocked: 0 }]);
    await expect(assertActiveUserPg(client, USER_ID)).resolves.toBeUndefined();
    expect(sqlFromFirstArg(query)).toContain(ASSERT_ACTIVE_USER_ROW_LOCK);
  });

  it('assertActiveUserPrisma: SQL usa FOR NO KEY UPDATE e aceita user ativo', async () => {
    const { tx, queryRaw } = mockPrisma([{ is_blocked: 0 }]);
    await expect(assertActiveUserPrisma(tx, USER_ID)).resolves.toBeUndefined();
    expect(sqlFromFirstArg(queryRaw)).toContain(ASSERT_ACTIVE_USER_ROW_LOCK);
  });

  it('user em falta: HttpControlledError 404 NOT_FOUND (pg e prisma)', async () => {
    const { client } = mockPg([]);
    await expect(assertActiveUserPg(client, USER_ID)).rejects.toMatchObject({
      statusCode: 404,
      jsonBody: { code: 'NOT_FOUND' }
    });
    await expect(assertActiveUserPg(client, USER_ID)).rejects.toBeInstanceOf(HttpControlledError);

    const { tx } = mockPrisma([]);
    await expect(assertActiveUserPrisma(tx, USER_ID)).rejects.toMatchObject({
      statusCode: 404,
      jsonBody: { code: 'NOT_FOUND' }
    });
    await expect(assertActiveUserPrisma(tx, USER_ID)).rejects.toBeInstanceOf(HttpControlledError);
  });

  it('is_blocked bloqueado: HttpControlledError 403 FORBIDDEN (pg e prisma)', async () => {
    const { client } = mockPg([{ is_blocked: BLOCKED_FLAG }]);
    await expect(assertActiveUserPg(client, USER_ID)).rejects.toMatchObject({
      statusCode: 403,
      jsonBody: { code: 'FORBIDDEN' }
    });
    await expect(assertActiveUserPg(client, USER_ID)).rejects.toBeInstanceOf(HttpControlledError);

    const { tx } = mockPrisma([{ is_blocked: BLOCKED_FLAG }]);
    await expect(assertActiveUserPrisma(tx, USER_ID)).rejects.toMatchObject({
      statusCode: 403,
      jsonBody: { code: 'FORBIDDEN' }
    });
    await expect(assertActiveUserPrisma(tx, USER_ID)).rejects.toBeInstanceOf(HttpControlledError);
  });
});
