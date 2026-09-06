/**
 * Revalida `users.is_blocked` **dentro** da transação (com `FOR NO KEY UPDATE`),
 * fechando o TOCTOU entre `requireActiveUser` no HTTP e a mutação de saldo.
 *
 * `FOR UPDATE` bloqueia `FOR KEY SHARE` de FKs (ex. `stock.user_id`) enquanto a
 * TX Node fica aberta no hardware HTTP — INSERT filho espera e estoura
 * `HARDWARE_TX_TIMEOUT_MS`. `FOR NO KEY UPDATE` serializa update/delete da row
 * (`is_blocked` não é PK) sem bloquear INSERT filho.
 *
 * Usar logo após `SET LOCAL lock_timeout` nas txs que debitam/creditam.
 */
import type { PoolClient } from 'pg';
import type { Prisma } from '@prisma/client';
import { HttpControlledError } from '../errors/http-controlled-error.js';

export const BLOCKED_FLAG = 1;
const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;

export const ASSERT_ACTIVE_USER_ROW_LOCK = 'FOR NO KEY UPDATE';

function throwIfInactive(row: { is_blocked: number | null } | undefined): void {
  if (!row) {
    throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'User not found.', code: 'NOT_FOUND' });
  }
  if (Number(row.is_blocked) === BLOCKED_FLAG) {
    throw new HttpControlledError(HTTP_FORBIDDEN, { error: 'Account blocked.', code: 'FORBIDDEN' });
  }
}

/** `pg` — exige `FOR NO KEY UPDATE` na linha de `users`. */
export async function assertActiveUserPg(client: PoolClient, userId: number): Promise<void> {
  const r = await client.query<{ is_blocked: number | null }>(
    `SELECT is_blocked FROM users WHERE id = $1 ${ASSERT_ACTIVE_USER_ROW_LOCK}`,
    [userId]
  );
  throwIfInactive(r.rows[0]);
}

/** Prisma `$transaction` — mesma semântica. */
export async function assertActiveUserPrisma(tx: Prisma.TransactionClient, userId: number): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ is_blocked: number | null }>>`SELECT is_blocked FROM users WHERE id = ${userId} FOR NO KEY UPDATE`;
  throwIfInactive(rows[0]);
}
