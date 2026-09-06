/**
 * Migrado de legacy/backend/modules/account-manager/accountManager.accrual.ts (verbatim).
 *
 * Chamado por `modules/mining-engine/services/progress-computer.ts`, na
 * mesma transação do crédito de mineração ao dono da conta.
 */
import type { PoolClient } from 'pg';
import { ACCOUNT_MANAGER_SHARE, ACCOUNT_MANAGER_STATUS } from './constants.js';
import { isAccountManagerEnabled } from './feature.js';
import { utcWeekStartMs } from '../../../shared/utils/utc-week.js';

export type MiningGainEntry = { coinId: string; amount: number };

/**
 * Acumula 10% do minerado do dono na semana UTC corrente (mesma TX do crédito).
 * Não altera `coin_balances` do dono — só o ledger de accrual do gerente.
 */
export async function accrueManagerMiningShare(client: PoolClient, ownerUserId: number, gains: MiningGainEntry[], nowMs: number = Date.now()): Promise<void> {
  if (!isAccountManagerEnabled()) return;
  const positive = gains.filter((g) => g.coinId && Number.isFinite(g.amount) && g.amount > 0);
  if (positive.length === 0) return;

  const contractRes = await client.query<{ id: number; hired_at: string | number | null }>(
    `SELECT id, hired_at
       FROM account_manager_contracts
      WHERE owner_user_id = $1
        AND status = $2
      LIMIT 1`,
    [ownerUserId, ACCOUNT_MANAGER_STATUS.ACTIVE]
  );
  const contract = contractRes.rows[0];
  if (!contract) return;

  const hiredAt = contract.hired_at != null ? Number(contract.hired_at) : NaN;
  if (!Number.isFinite(hiredAt) || nowMs < hiredAt) return;

  const weekStart = utcWeekStartMs(nowMs);

  for (const g of positive) {
    const share = g.amount * ACCOUNT_MANAGER_SHARE;
    await client.query(
      `INSERT INTO account_manager_mining_accrual
         (contract_id, coin_id, week_start, owner_mined_amount, manager_share_amount, paid_at)
       VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT (contract_id, coin_id, week_start)
       DO UPDATE SET
         owner_mined_amount = account_manager_mining_accrual.owner_mined_amount + EXCLUDED.owner_mined_amount,
         manager_share_amount = account_manager_mining_accrual.manager_share_amount + EXCLUDED.manager_share_amount
       WHERE account_manager_mining_accrual.paid_at IS NULL`,
      [contract.id, g.coinId, weekStart, g.amount, share]
    );
  }
}
