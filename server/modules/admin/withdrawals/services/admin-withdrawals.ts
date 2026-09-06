/**
 * Admin: listar saques e transicionar `pending` → `completed` | `rejected`.
 *
 * Semântica do legado (`legacy/backend/server.ts`): o débito já ocorreu no
 * pedido do jogador; `completed` só marca processado; `rejected` estorna
 * `amount_crypto` em `coin_balances` na mesma transação.
 *
 * Money TX em `genesis-wallet` (`POST /v1/wallet/admin/withdrawals/status`, fail-closed).
 * Auth admin fica no controller Node.
 */
import type { Pool } from 'pg';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import { mapWithdrawalRequestRow, type WithdrawalHistoryEntry } from '../../../wallet/services/withdrawal-history-shape.js';
import {
  callWalletAdminWithdrawalStatus,
  isWalletWorkerError
} from '../../../wallet/services/wallet-worker-client.js';

const HTTP_BAD_REQUEST = 400;
const ALLOWED_STATUS = new Set(['completed', 'rejected']);
const REQUEST_ID_MAX = 80;
const TX_HASH_MAX = 128;

export type AdminWithdrawalStatus = 'completed' | 'rejected';

export type AdminWithdrawalStatusOk = {
  ok: true;
  message: string;
};

function parseRequestId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id || id.length > REQUEST_ID_MAX) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Dados inválidos' });
  }
  return id;
}

function parseStatus(raw: unknown): AdminWithdrawalStatus {
  if (typeof raw !== 'string' || !ALLOWED_STATUS.has(raw)) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Dados inválidos' });
  }
  return raw as AdminWithdrawalStatus;
}

function parseTxHash(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Dados inválidos' });
  }
  const t = raw.trim();
  if (!t) return null;
  if (t.length > TX_HASH_MAX) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Dados inválidos' });
  }
  return t;
}

export async function listAdminWithdrawals(pool: Pool): Promise<WithdrawalHistoryEntry[]> {
  const result = await pool.query(
    `
    SELECT w.*, u.username, u.email, c.symbol as coin_symbol
    FROM withdrawal_requests w
    JOIN users u ON w.user_id = u.id
    JOIN mining_coins c ON w.coin_id = c.id
    ORDER BY w.created_at DESC
    `
  );
  return result.rows.map((r) => mapWithdrawalRequestRow(r));
}

/**
 * Transição de status via wallet worker (fail-closed).
 * Validação de payload fica no Node; money TX no worker.
 */
export async function runAdminWithdrawalStatusUpdate(input: {
  requestId: unknown;
  status: unknown;
  txHash?: unknown;
  nowMs?: number;
}): Promise<AdminWithdrawalStatusOk> {
  const requestId = parseRequestId(input.requestId);
  const status = parseStatus(input.status);
  const txHash = parseTxHash(input.txHash);
  const nowMs = input.nowMs ?? Date.now();

  try {
    return await callWalletAdminWithdrawalStatus({
      requestId,
      status,
      txHash,
      serverNowMs: nowMs
    });
  } catch (e) {
    if (isWalletWorkerError(e)) {
      throw new HttpControlledError(e.statusCode, e.jsonBody);
    }
    throw e;
  }
}

export async function updateAdminWithdrawalStatus(
  _pool: Pool,
  input: { requestId: unknown; status: unknown; txHash?: unknown; nowMs?: number }
): Promise<AdminWithdrawalStatusOk> {
  return runAdminWithdrawalStatusUpdate(input);
}
