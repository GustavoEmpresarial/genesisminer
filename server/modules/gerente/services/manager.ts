/**
 * Núcleo de domínio da Gerência de Conta: ciclo de vida do contrato
 * (hire/apply → accept/decline → active → fire/resign), a troca de sessão
 * pra "entrar"/"sair" da conta gerida, e o resumo de ganhos do gerente.
 *
 * Estados do contrato (ver `constants.ts`): `pending` (dono convidou,
 * aguarda gerente) e `applied` (gerente candidatou-se, aguarda dono) são os
 * dois jeitos de abrir um contrato — ambos convergem em `active` via
 * {@link acceptContract}, ou terminam em `ended` via
 * {@link declineContract}/{@link fireManager}/{@link resignManager}.
 *
 * Migrado de legacy/backend/modules/account-manager/accountManager.service.ts (verbatim).
 */
import type { Pool, PoolClient } from 'pg';
import { ACCOUNT_MANAGER_FIRE_LOCK_DAYS, ACCOUNT_MANAGER_SHARE, ACCOUNT_MANAGER_STATUS } from './constants.js';
import { utcWeekStartMs } from '../../../shared/utils/utc-week.js';
import { AccountManagerError } from './errors.js';
import { MS_PER_DAY } from '../../../shared/utils/time.js';
import {
  SESSION_MANAGER_MODE_OFF,
  SESSION_MANAGER_MODE_ON,
  callAuthSessionLoad,
  callAuthSessionUpdateFlags
} from '../../auth/services/auth-worker-client.js';

const HTTP_UNAUTHORIZED = 401;

function nowMs(): number {
  return Date.now();
}

async function withClient<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

type UserRow = { id: number; username: string; email: string };

async function findUserByEmailOrUsername(client: PoolClient, raw: string): Promise<UserRow | null> {
  const q = String(raw || '').trim();
  if (!q) return null;
  const byEmail = await client.query<UserRow>(`SELECT id, username, email FROM users WHERE lower(email) = lower($1) LIMIT 1`, [q]);
  if (byEmail.rows[0]) return byEmail.rows[0];
  const byUser = await client.query<UserRow>(`SELECT id, username, email FROM users WHERE lower(username) = lower($1) LIMIT 1`, [q]);
  return byUser.rows[0] || null;
}

function mapContract(row: Record<string, unknown>) {
  const hiredAt = row.hired_at != null ? Number(row.hired_at) : null;
  const fireLockedUntil = row.fire_locked_until != null ? Number(row.fire_locked_until) : null;
  const endsAt = row.ends_at != null ? Number(row.ends_at) : null;
  const now = nowMs();
  return {
    id: Number(row.id),
    ownerUserId: Number(row.owner_user_id),
    managerUserId: Number(row.manager_user_id),
    status: String(row.status),
    hiredAt,
    endsAt,
    fireLockedUntil,
    canFire: row.status === ACCOUNT_MANAGER_STATUS.ACTIVE ? fireLockedUntil == null || now >= fireLockedUntil : false,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ownerUsername: row.owner_username != null ? String(row.owner_username) : undefined,
    ownerEmail: row.owner_email != null ? String(row.owner_email) : undefined,
    managerUsername: row.manager_username != null ? String(row.manager_username) : undefined,
    managerEmail: row.manager_email != null ? String(row.manager_email) : undefined
  };
}

async function endOpenCompetingForOwner(client: PoolClient, ownerUserId: number, keepContractId: number, t: number): Promise<void> {
  await client.query(
    `UPDATE account_manager_contracts
        SET status = $1, ends_at = $2, updated_at = $2
      WHERE owner_user_id = $3
        AND id <> $4
        AND status IN ($5, $6)`,
    [ACCOUNT_MANAGER_STATUS.ENDED, t, ownerUserId, keepContractId, ACCOUNT_MANAGER_STATUS.PENDING, ACCOUNT_MANAGER_STATUS.APPLIED]
  );
}

const LOCK_TIMEOUT_MS = 45_000;
const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;

/**
 * Dono convida `target` (email ou username) a gerir a conta — cria contrato
 * em status `pending`. Falha se: alvo não existe, é o próprio dono,
 * ou o dono já tem convite/contrato aberto. Encerra automaticamente qualquer
 * candidatura (`applied`) pendente pra este dono (o convite tem prioridade).
 */
export async function hireManager(pool: Pool, ownerUserId: number, target: string): Promise<ReturnType<typeof mapContract>> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    try {
      const manager = await findUserByEmailOrUsername(client, target);
      if (!manager) throw new AccountManagerError('USER_NOT_FOUND', 'Jogador não encontrado.', HTTP_NOT_FOUND);
      if (manager.id === ownerUserId) {
        throw new AccountManagerError('SELF_HIRE', 'Não podes contratar-te a ti próprio.');
      }

      const existing = await client.query(
        `SELECT id, status FROM account_manager_contracts
          WHERE owner_user_id = $1 AND status IN ($2, $3)
          LIMIT 1 FOR UPDATE`,
        [ownerUserId, ACCOUNT_MANAGER_STATUS.PENDING, ACCOUNT_MANAGER_STATUS.ACTIVE]
      );
      if (existing.rows[0]) {
        throw new AccountManagerError(
          'ALREADY_HAS_MANAGER',
          existing.rows[0].status === ACCOUNT_MANAGER_STATUS.PENDING ? 'Já tens um pedido de gerência pendente.' : 'Já tens um gerente ativo. Demite-o antes de contratar outro.'
        );
      }

      const t = nowMs();
      // Convite do dono encerra candidaturas abertas a esta conta.
      await client.query(
        `UPDATE account_manager_contracts
            SET status = $1, ends_at = $2, updated_at = $2
          WHERE owner_user_id = $3 AND status = $4`,
        [ACCOUNT_MANAGER_STATUS.ENDED, t, ownerUserId, ACCOUNT_MANAGER_STATUS.APPLIED]
      );

      const ins = await client.query(
        `INSERT INTO account_manager_contracts
           (owner_user_id, manager_user_id, status, hired_at, ends_at, fire_locked_until, created_at, updated_at)
         VALUES ($1, $2, $3, NULL, NULL, NULL, $4, $4)
         RETURNING *`,
        [ownerUserId, manager.id, ACCOUNT_MANAGER_STATUS.PENDING, t]
      );
      await client.query('COMMIT');
      const row = { ...ins.rows[0], manager_username: manager.username, manager_email: manager.email };
      return mapContract(row);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  });
}

/** Gerente envia candidatura ("currículo") a um dono. */
export async function applyAsManager(pool: Pool, managerUserId: number, ownerTarget: string): Promise<ReturnType<typeof mapContract>> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    try {
      const owner = await findUserByEmailOrUsername(client, ownerTarget);
      if (!owner) throw new AccountManagerError('USER_NOT_FOUND', 'Jogador não encontrado.', HTTP_NOT_FOUND);
      if (owner.id === managerUserId) {
        throw new AccountManagerError('SELF_APPLY', 'Não podes candidatar-te à tua própria conta.');
      }

      const ownerBusy = await client.query(
        `SELECT id, status FROM account_manager_contracts
          WHERE owner_user_id = $1 AND status IN ($2, $3)
          LIMIT 1 FOR UPDATE`,
        [owner.id, ACCOUNT_MANAGER_STATUS.PENDING, ACCOUNT_MANAGER_STATUS.ACTIVE]
      );
      if (ownerBusy.rows[0]) {
        throw new AccountManagerError('OWNER_BUSY', ownerBusy.rows[0].status === ACCOUNT_MANAGER_STATUS.ACTIVE ? 'Esta conta já tem gerente ativo.' : 'Esta conta já tem um convite de gerência pendente.');
      }

      const dup = await client.query(
        `SELECT id FROM account_manager_contracts
          WHERE owner_user_id = $1 AND manager_user_id = $2 AND status = $3
          LIMIT 1`,
        [owner.id, managerUserId, ACCOUNT_MANAGER_STATUS.APPLIED]
      );
      if (dup.rows[0]) {
        throw new AccountManagerError('ALREADY_APPLIED', 'Já enviaste candidatura a esta conta. Aguarda aprovação ou rejeição.');
      }

      const t = nowMs();
      const ins = await client.query(
        `INSERT INTO account_manager_contracts
           (owner_user_id, manager_user_id, status, hired_at, ends_at, fire_locked_until, created_at, updated_at)
         VALUES ($1, $2, $3, NULL, NULL, NULL, $4, $4)
         RETURNING *`,
        [owner.id, managerUserId, ACCOUNT_MANAGER_STATUS.APPLIED, t]
      );
      await client.query('COMMIT');
      return mapContract({ ...ins.rows[0], owner_username: owner.username, owner_email: owner.email });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  });
}

/**
 * Aceita pedido aberto:
 * - `pending` → só o gerente (convite do dono)
 * - `applied` → só o dono (candidatura do gerente)
 */
export async function acceptContract(pool: Pool, actorUserId: number, contractId: number): Promise<ReturnType<typeof mapContract>> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    try {
      const res = await client.query(`SELECT * FROM account_manager_contracts WHERE id = $1 FOR UPDATE`, [contractId]);
      const row = res.rows[0];
      if (!row) throw new AccountManagerError('NOT_FOUND', 'Contrato não encontrado.', HTTP_NOT_FOUND);

      const status = String(row.status);
      if (status === ACCOUNT_MANAGER_STATUS.PENDING) {
        if (Number(row.manager_user_id) !== actorUserId) {
          throw new AccountManagerError('FORBIDDEN', 'Só o gerente convidado pode aceitar este pedido.', HTTP_FORBIDDEN);
        }
      } else if (status === ACCOUNT_MANAGER_STATUS.APPLIED) {
        if (Number(row.owner_user_id) !== actorUserId) {
          throw new AccountManagerError('FORBIDDEN', 'Só o dono da conta pode aprovar esta candidatura.', HTTP_FORBIDDEN);
        }
      } else {
        throw new AccountManagerError('INVALID_STATUS', 'Este pedido já não está pendente.');
      }

      const ownerBusy = await client.query(
        `SELECT id FROM account_manager_contracts
          WHERE owner_user_id = $1 AND status = $2 AND id <> $3
          LIMIT 1`,
        [row.owner_user_id, ACCOUNT_MANAGER_STATUS.ACTIVE, contractId]
      );
      if (ownerBusy.rows[0]) {
        throw new AccountManagerError('OWNER_HAS_MANAGER', 'O dono já tem outro gerente ativo.');
      }

      const t = nowMs();
      await endOpenCompetingForOwner(client, Number(row.owner_user_id), contractId, t);
      const lockUntil = t + ACCOUNT_MANAGER_FIRE_LOCK_DAYS * MS_PER_DAY;
      const upd = await client.query(
        `UPDATE account_manager_contracts
            SET status = $1, hired_at = $2, fire_locked_until = $3, updated_at = $2
          WHERE id = $4
          RETURNING *`,
        [ACCOUNT_MANAGER_STATUS.ACTIVE, t, lockUntil, contractId]
      );
      await client.query('COMMIT');
      return mapContract(upd.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  });
}

/**
 * Recusa pedido aberto:
 * - `pending` → só o gerente
 * - `applied` → só o dono
 */
export async function declineContract(pool: Pool, actorUserId: number, contractId: number): Promise<void> {
  return withClient(pool, async (client) => {
    const res = await client.query(`SELECT * FROM account_manager_contracts WHERE id = $1`, [contractId]);
    const row = res.rows[0];
    if (!row) throw new AccountManagerError('NOT_FOUND', 'Contrato não encontrado.', HTTP_NOT_FOUND);

    const status = String(row.status);
    if (status === ACCOUNT_MANAGER_STATUS.PENDING) {
      if (Number(row.manager_user_id) !== actorUserId) {
        throw new AccountManagerError('FORBIDDEN', 'Só o gerente convidado pode recusar este pedido.', HTTP_FORBIDDEN);
      }
    } else if (status === ACCOUNT_MANAGER_STATUS.APPLIED) {
      if (Number(row.owner_user_id) !== actorUserId) {
        throw new AccountManagerError('FORBIDDEN', 'Só o dono da conta pode rejeitar esta candidatura.', HTTP_FORBIDDEN);
      }
    } else {
      throw new AccountManagerError('INVALID_STATUS', 'Este pedido já não está pendente.');
    }

    const t = nowMs();
    await client.query(
      `UPDATE account_manager_contracts
          SET status = $1, ends_at = $2, updated_at = $2
        WHERE id = $3`,
      [ACCOUNT_MANAGER_STATUS.ENDED, t, contractId]
    );
  });
}

/**
 * Dono encerra o contrato ativo. Bloqueado durante os primeiros
 * {@link ACCOUNT_MANAGER_FIRE_LOCK_DAYS} dias (`fire_locked_until`) — trava
 * anti-abuso pra não trocar de gerente impulsivamente. Se o gerente estiver
 * no momento "dentro" da conta (`manager_mode`), força a sessão de volta
 * pro gerente (não deixa ninguém preso numa conta que acabou de perder acesso).
 */
export async function fireManager(pool: Pool, ownerUserId: number): Promise<void> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    try {
      const res = await client.query(
        `SELECT * FROM account_manager_contracts
          WHERE owner_user_id = $1 AND status = $2
          LIMIT 1 FOR UPDATE`,
        [ownerUserId, ACCOUNT_MANAGER_STATUS.ACTIVE]
      );
      const row = res.rows[0];
      if (!row) throw new AccountManagerError('NOT_FOUND', 'Não tens gerente ativo.', HTTP_NOT_FOUND);
      const lockUntil = row.fire_locked_until != null ? Number(row.fire_locked_until) : 0;
      const t = nowMs();
      if (lockUntil > t) {
        throw new AccountManagerError('FIRE_LOCKED', `Não podes demitir durante a primeira semana. Liberado em ${new Date(lockUntil).toISOString()}.`, HTTP_FORBIDDEN);
      }
      await client.query(
        `UPDATE account_manager_contracts
            SET status = $1, ends_at = $2, updated_at = $2
          WHERE id = $3`,
        [ACCOUNT_MANAGER_STATUS.ENDED, t, row.id]
      );
      // Se o gerente estiver na conta, forçar saída nas sessões
      const restore = await callAuthSessionUpdateFlags({
        restoreUserIdFromOriginal: true,
        matchActingAsOwnerId: ownerUserId
      });
      if (!restore.ok) {
        throw new Error(restore.error ?? 'auth session update-flags failed');
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  });
}

/**
 * Gerente encerra o próprio contrato — sem trava de tempo (ao contrário de
 * {@link fireManager}, resignar é sempre permitido). Sem `contractId`, pega
 * o contrato `active` mais recente do gerente. Também força saída de
 * `manager_mode` se a sessão estiver dentro dessa conta.
 */
export async function resignManager(pool: Pool, managerUserId: number, contractId?: number): Promise<void> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    try {
      let res;
      if (contractId != null) {
        res = await client.query(`SELECT * FROM account_manager_contracts WHERE id = $1 FOR UPDATE`, [contractId]);
      } else {
        res = await client.query(
          `SELECT * FROM account_manager_contracts
            WHERE manager_user_id = $1 AND status = $2
            ORDER BY hired_at DESC NULLS LAST
            LIMIT 1 FOR UPDATE`,
          [managerUserId, ACCOUNT_MANAGER_STATUS.ACTIVE]
        );
      }
      const row = res.rows[0];
      if (!row) throw new AccountManagerError('NOT_FOUND', 'Contrato ativo não encontrado.', HTTP_NOT_FOUND);
      if (Number(row.manager_user_id) !== managerUserId) {
        throw new AccountManagerError('FORBIDDEN', 'Este contrato não é teu.', HTTP_FORBIDDEN);
      }
      if (row.status !== ACCOUNT_MANAGER_STATUS.ACTIVE && row.status !== ACCOUNT_MANAGER_STATUS.PENDING && row.status !== ACCOUNT_MANAGER_STATUS.APPLIED) {
        throw new AccountManagerError('INVALID_STATUS', 'Contrato já terminado.');
      }
      const t = nowMs();
      await client.query(
        `UPDATE account_manager_contracts
            SET status = $1, ends_at = $2, updated_at = $2
          WHERE id = $3`,
        [ACCOUNT_MANAGER_STATUS.ENDED, t, row.id]
      );
      const restore = await callAuthSessionUpdateFlags({
        restoreUserIdFromOriginal: true,
        matchOriginalUserId: managerUserId,
        matchActingAsOwnerId: Number(row.owner_user_id)
      });
      if (!restore.ok) {
        throw new Error(restore.error ?? 'auth session update-flags failed');
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  });
}

/**
 * Estado de gerência de `userId`, dos dois lados: contratos como dono
 * (`asOwner`) e como gerente (`asManager`), mais o accrual da semana UTC
 * corrente ({@link utcWeekStartMs}) dos contratos ativos e o resumo
 * histórico de ganhos como gerente ({@link loadManagerEarningsSummary}).
 * Alimenta `GET /api/account-manager/me`.
 */
export async function getAccountManagerMe(pool: Pool, userId: number) {
  return withClient(pool, async (client) => {
    const asOwner = await client.query(
      `SELECT c.*, m.username AS manager_username, m.email AS manager_email
         FROM account_manager_contracts c
         JOIN users m ON m.id = c.manager_user_id
        WHERE c.owner_user_id = $1
          AND c.status IN ($2, $3, $4)
        ORDER BY c.created_at DESC`,
      [userId, ACCOUNT_MANAGER_STATUS.PENDING, ACCOUNT_MANAGER_STATUS.APPLIED, ACCOUNT_MANAGER_STATUS.ACTIVE]
    );
    const asManager = await client.query(
      `SELECT c.*, o.username AS owner_username, o.email AS owner_email
         FROM account_manager_contracts c
         JOIN users o ON o.id = c.owner_user_id
        WHERE c.manager_user_id = $1
          AND c.status IN ($2, $3, $4)
        ORDER BY c.created_at DESC`,
      [userId, ACCOUNT_MANAGER_STATUS.PENDING, ACCOUNT_MANAGER_STATUS.APPLIED, ACCOUNT_MANAGER_STATUS.ACTIVE]
    );

    const weekStart = utcWeekStartMs();
    const activeIds = [...asOwner.rows.filter((r) => r.status === ACCOUNT_MANAGER_STATUS.ACTIVE).map((r) => r.id), ...asManager.rows.filter((r) => r.status === ACCOUNT_MANAGER_STATUS.ACTIVE).map((r) => r.id)];
    let accruals: Array<{
      contractId: number;
      coinId: string;
      weekStart: number;
      ownerMinedAmount: number;
      managerShareAmount: number;
      paidAt: number | null;
    }> = [];
    if (activeIds.length > 0) {
      const acc = await client.query(
        `SELECT contract_id, coin_id, week_start, owner_mined_amount, manager_share_amount, paid_at
           FROM account_manager_mining_accrual
          WHERE contract_id = ANY($1::int[])
            AND week_start = $2`,
        [activeIds, weekStart]
      );
      accruals = acc.rows.map((r) => ({
        contractId: Number(r.contract_id),
        coinId: String(r.coin_id),
        weekStart: Number(r.week_start),
        ownerMinedAmount: Number(r.owner_mined_amount),
        managerShareAmount: Number(r.manager_share_amount),
        paidAt: r.paid_at != null ? Number(r.paid_at) : null
      }));
    }

    const managerEarnings = await loadManagerEarningsSummary(client, userId);

    const activeManagedCount = asManager.rows.filter((r) => r.status === ACCOUNT_MANAGER_STATUS.ACTIVE).length;

    const PERCENT_MULTIPLIER = 100;
    return {
      sharePercent: ACCOUNT_MANAGER_SHARE * PERCENT_MULTIPLIER,
      fireLockDays: ACCOUNT_MANAGER_FIRE_LOCK_DAYS,
      activeManagedCount,
      weekStart,
      asOwner: asOwner.rows.map((r) => mapContract(r)),
      asManager: asManager.rows.map((r) => mapContract(r)),
      weekAccruals: accruals,
      managerEarnings
    };
  });
}

/** Totais de share do gerente (ativo + histórico) por moeda. */
async function loadManagerEarningsSummary(client: PoolClient, managerUserId: number) {
  const counts = await client.query<{ active: string; ended: string; total: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = $2)::text AS active,
       COUNT(*) FILTER (WHERE status = $3)::text AS ended,
       COUNT(*) FILTER (WHERE status IN ($2, $3))::text AS total
     FROM account_manager_contracts
     WHERE manager_user_id = $1`,
    [managerUserId, ACCOUNT_MANAGER_STATUS.ACTIVE, ACCOUNT_MANAGER_STATUS.ENDED]
  );

  const byCoinRes = await client.query<{
    coin_id: string;
    symbol: string | null;
    name: string | null;
    total_share: string;
    paid_share: string;
    pending_share: string;
  }>(
    `SELECT
       a.coin_id,
       COALESCE(NULLIF(BTRIM(mc.symbol), ''), NULLIF(BTRIM(mc.name), ''), a.coin_id) AS symbol,
       COALESCE(NULLIF(BTRIM(mc.name), ''), a.coin_id) AS name,
       COALESCE(SUM(a.manager_share_amount), 0)::float8 AS total_share,
       COALESCE(SUM(a.manager_share_amount) FILTER (WHERE a.paid_at IS NOT NULL), 0)::float8 AS paid_share,
       COALESCE(SUM(a.manager_share_amount) FILTER (WHERE a.paid_at IS NULL), 0)::float8 AS pending_share
     FROM account_manager_mining_accrual a
     INNER JOIN account_manager_contracts c ON c.id = a.contract_id
     LEFT JOIN mining_coins mc ON mc.id = a.coin_id
     WHERE c.manager_user_id = $1
       AND c.status IN ($2, $3)
     GROUP BY a.coin_id, mc.symbol, mc.name
     HAVING COALESCE(SUM(a.manager_share_amount), 0) > 0
     ORDER BY total_share DESC`,
    [managerUserId, ACCOUNT_MANAGER_STATUS.ACTIVE, ACCOUNT_MANAGER_STATUS.ENDED]
  );

  const byCoin = byCoinRes.rows.map((r) => ({
    coinId: String(r.coin_id),
    symbol: String(r.symbol || r.coin_id),
    name: String(r.name || r.coin_id),
    totalShare: Number(r.total_share) || 0,
    paidShare: Number(r.paid_share) || 0,
    pendingShare: Number(r.pending_share) || 0
  }));

  const row = counts.rows[0];
  return {
    activeContracts: parseInt(String(row?.active || '0'), 10) || 0,
    endedContracts: parseInt(String(row?.ended || '0'), 10) || 0,
    managedContracts: parseInt(String(row?.total || '0'), 10) || 0,
    byCoin
  };
}

/**
 * Troca a sessão do gerente pra atuar como `ownerUserId` (`manager_mode = 1`,
 * `original_user_id` guarda o gerente real). Exige contrato `active` entre
 * os dois. Idempotente se já estiver dentro da mesma conta gerida (só
 * reafirma os campos); exige estar logado como o próprio gerente antes de
 * entrar (não permite "pular" de uma conta gerida pra outra direto).
 */
export async function enterManagedAccount(pool: Pool, managerUserId: number, ownerUserId: number, sessionId: string): Promise<{ ownerUserId: number }> {
  return withClient(pool, async (client) => {
    const HTTP_BAD_REQUEST = 400;
    const c = await client.query(
      `SELECT id FROM account_manager_contracts
        WHERE owner_user_id = $1 AND manager_user_id = $2 AND status = $3
        LIMIT 1`,
      [ownerUserId, managerUserId, ACCOUNT_MANAGER_STATUS.ACTIVE]
    );
    if (!c.rows[0]) {
      throw new AccountManagerError('NO_CONTRACT', 'Não tens contrato ativo com esta conta.', HTTP_FORBIDDEN);
    }
    const loaded = await callAuthSessionLoad({ sessionId, includeExpired: true });
    if (!loaded.ok) {
      if (loaded.status === HTTP_UNAUTHORIZED) {
        throw new AccountManagerError('NO_SESSION', 'Session required.', HTTP_BAD_REQUEST);
      }
      throw new Error(loaded.error ?? 'auth session load failed');
    }
    const currentUid = Number(loaded.userId);
    const original = loaded.originalUserId != null ? Number(loaded.originalUserId) : null;
    const alreadyManaging = Number(loaded.managerMode) === SESSION_MANAGER_MODE_ON && original === managerUserId;
    if (!alreadyManaging && currentUid !== managerUserId) {
      throw new AccountManagerError('WRONG_SESSION', 'Entra na tua conta de gerente antes de gerir outra.', HTTP_BAD_REQUEST);
    }
    const updated = await callAuthSessionUpdateFlags({
      sessionId,
      userId: ownerUserId,
      originalUserId: managerUserId,
      managerMode: SESSION_MANAGER_MODE_ON,
      actingAsOwnerId: ownerUserId
    });
    if (!updated.ok) {
      throw new Error(updated.error ?? 'auth session update-flags failed');
    }
    return { ownerUserId };
  });
}

/** Sai de `manager_mode`, devolvendo a sessão pro gerente real (`original_user_id`). */
export async function leaveManagedAccount(pool: Pool, sessionId: string): Promise<{ managerUserId: number }> {
  const HTTP_BAD_REQUEST = 400;
  void pool;
  const loaded = await callAuthSessionLoad({ sessionId, includeExpired: true });
  if (!loaded.ok) {
    if (loaded.status === HTTP_UNAUTHORIZED) {
      throw new AccountManagerError('NOT_MANAGING', 'Não estás a gerir nenhuma conta.', HTTP_BAD_REQUEST);
    }
    throw new Error(loaded.error ?? 'auth session load failed');
  }
  if (Number(loaded.managerMode) !== SESSION_MANAGER_MODE_ON || loaded.originalUserId == null) {
    throw new AccountManagerError('NOT_MANAGING', 'Não estás a gerir nenhuma conta.', HTTP_BAD_REQUEST);
  }
  const managerUserId = Number(loaded.originalUserId);
  const updated = await callAuthSessionUpdateFlags({
    sessionId,
    userId: managerUserId,
    originalUserId: null,
    managerMode: SESSION_MANAGER_MODE_OFF,
    actingAsOwnerId: null
  });
  if (!updated.ok) {
    throw new Error(updated.error ?? 'auth session update-flags failed');
  }
  return { managerUserId };
}

export type SessionManagerFlags = {
  managerMode: boolean;
  managerUserId: number | null;
  actingAsOwnerId: number | null;
  isManagingAccount: boolean;
};

/**
 * Lê os flags de `manager_mode` direto da sessão — usado pelo guard
 * ({@link createManagerModeGuard} em `./guard.ts`) em toda request, então é
 * deliberadamente uma query simples e direta (sem `withClient`/transação).
 */
export async function loadSessionManagerFlags(pool: Pool, sessionId: string | null | undefined): Promise<SessionManagerFlags> {
  const empty: SessionManagerFlags = { managerMode: false, managerUserId: null, actingAsOwnerId: null, isManagingAccount: false };
  void pool;
  if (!sessionId) return empty;
  const loaded = await callAuthSessionLoad({ sessionId, includeExpired: true });
  if (!loaded.ok) {
    if (loaded.status === HTTP_UNAUTHORIZED) return empty;
    throw new Error(loaded.error ?? 'auth session load failed');
  }
  if (Number(loaded.managerMode) !== SESSION_MANAGER_MODE_ON) return empty;
  const managerUserId = loaded.originalUserId != null ? Number(loaded.originalUserId) : null;
  const actingAsOwnerId = loaded.actingAsOwnerId != null ? Number(loaded.actingAsOwnerId) : Number(loaded.userId);
  return { managerMode: true, managerUserId, actingAsOwnerId, isManagingAccount: true };
}
