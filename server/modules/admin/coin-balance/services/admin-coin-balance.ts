/**
 * Ajuste admin de `coin_balances` (AdminRanking).
 *
 * Individual (`POST /api/admin/update-coin-balance`): SET absoluto via
 * `genesis-wallet` (`POST /v1/wallet/admin/coin-balance/set`, fail-closed).
 *
 * Bulk (`POST /api/admin/bulk-update-coin-balance`): incremento de `amount`
 * (positivo ou negativo) com `GREATEST(0, …)`, numa transação Node, sobre
 * mineradores activos da moeda ∪ quem já tem saldo > 0.
 *
 * Semântica do legado (`legacy/backend/server.ts`). Sem FK no schema —
 * user/coin inexistentes não são 404; o UPSERT segue.
 */
import type { Pool, PoolClient } from 'pg';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import {
  callWalletAdminSetCoinBalance,
  isWalletWorkerError
} from '../../../wallet/services/wallet-worker-client.js';

const HTTP_BAD_REQUEST = 400;
const COIN_ID_MAX = 128;

const ERR_SINGLE = { error: 'Missing fields: userId, coinId, amount' };
const ERR_BULK = { error: 'Campos ausentes: coinId, amount' };

export type AdminSetCoinBalanceOk = { ok: true };
export type AdminBulkCoinBalanceOk = { ok: true; count: number };

function parseCoinId(raw: unknown, err: { error: string }): string {
  if (typeof raw !== 'string') {
    throw new HttpControlledError(HTTP_BAD_REQUEST, err);
  }
  const id = raw.trim();
  if (!id || id.length > COIN_ID_MAX) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, err);
  }
  return id;
}

function parseAmount(raw: unknown, err: { error: string }): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, err);
  }
  return raw;
}

function parseUserId(raw: unknown): number {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  throw new HttpControlledError(HTTP_BAD_REQUEST, ERR_SINGLE);
}

/**
 * Absolute SET via wallet worker (fail-closed).
 * Validação de payload fica no Node; money TX no worker.
 */
export async function setAdminCoinBalance(
  _pool: Pool,
  input: { userId: unknown; coinId: unknown; amount: unknown }
): Promise<AdminSetCoinBalanceOk> {
  const userId = parseUserId(input.userId);
  const coinId = parseCoinId(input.coinId, ERR_SINGLE);
  const amount = parseAmount(input.amount, ERR_SINGLE);

  try {
    return await callWalletAdminSetCoinBalance({ userId, coinId, amount });
  } catch (e) {
    if (isWalletWorkerError(e)) {
      throw new HttpControlledError(e.statusCode, e.jsonBody);
    }
    throw e;
  }
}

const SELECT_BULK_USER_IDS = `
      SELECT DISTINCT user_id
      FROM placed_racks
      WHERE is_on = 1
      AND wiring_id IS NOT NULL
      AND battery_id IS NOT NULL
      AND selected_coin_id = $1
      UNION
      SELECT user_id FROM coin_balances WHERE coin_id = $1 AND amount > 0
    `;

const UPSERT_BULK_INCREMENT = `
        INSERT INTO coin_balances (user_id, coin_id, amount)
        SELECT u, $2, GREATEST(0, $3::double precision) FROM unnest($1::int[]) AS u
        ON CONFLICT (user_id, coin_id)
        DO UPDATE SET amount = GREATEST(0, coin_balances.amount + $3::double precision)
      `;

export async function runAdminBulkUpdateCoinBalance(
  client: PoolClient,
  input: { coinId: unknown; amount: unknown }
): Promise<AdminBulkCoinBalanceOk> {
  const coinId = parseCoinId(input.coinId, ERR_BULK);
  const amount = parseAmount(input.amount, ERR_BULK);

  await client.query('BEGIN');
  try {
    const usersRes = await client.query(SELECT_BULK_USER_IDS, [coinId]);
    const userIds = usersRes.rows
      .map((r: { user_id: unknown }) => Number(r.user_id))
      .filter((n) => Number.isSafeInteger(n) && n > 0);

    if (userIds.length > 0) {
      await client.query(UPSERT_BULK_INCREMENT, [userIds, coinId, amount]);
    }

    await client.query('COMMIT');
    return { ok: true, count: userIds.length };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export async function bulkUpdateAdminCoinBalance(
  pool: Pool,
  input: { coinId: unknown; amount: unknown }
): Promise<AdminBulkCoinBalanceOk> {
  parseCoinId(input.coinId, ERR_BULK);
  parseAmount(input.amount, ERR_BULK);
  const client = await pool.connect();
  try {
    return await runAdminBulkUpdateCoinBalance(client, input);
  } finally {
    client.release();
  }
}
