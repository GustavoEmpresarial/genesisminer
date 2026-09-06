/**
 * Ferramentas admin de segurança em massa: bloqueio por inatividade (dias sem login) e
 * reset forçado de senha de jogadores (exclui admin/super-admin).
 *
 * Migrado de legacy/backend/controllers/adminSecurityBulk.controller.ts (lógica de
 * negócio extraída pra services/, rotas ficam em controllers/security-bulk.controller.ts).
 */
import crypto from 'node:crypto';
import { prisma } from '../../../../core/database/prisma.js';
import { getSettingValue, upsertSettingsEntries } from '../../../../shared/settings/settings-repository.js';
import { MS_PER_DAY } from '../../../../shared/utils/time.js';
import {
  BCRYPT_ROUNDS_PROFILE,
  authWorkerBcrypt,
  callAuthSessionDeleteByUser
} from '../../../auth/services/auth-worker-client.js';

const SETTING_INACTIVE_DAYS = 'security_inactive_block_days';
const SETTING_AUTO_ENABLED = 'security_inactive_auto_block_enabled';
const DEFAULT_INACTIVE_BLOCK_DAYS = 90;
const MIN_INACTIVE_DAYS = 1;
const MAX_INACTIVE_DAYS = 3650;
const RANDOM_SECRET_BYTES = 32;

/**
 * Valida/normaliza um valor de "dias de inatividade" vindo de query/body (string ou
 * number não confiável). `null` significa inválido — quem chama deve tratar como
 * "usar o valor guardado em settings" ou rejeitar o pedido, conforme o endpoint.
 *
 * @param v - Valor bruto (query string, body JSON, etc.).
 * @returns Inteiro dentro de `[MIN_INACTIVE_DAYS, MAX_INACTIVE_DAYS]`, ou `null` se
 *   não for um número finito ou estiver fora do intervalo.
 */
export function parseInactiveDays(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n) || n < MIN_INACTIVE_DAYS || n > MAX_INACTIVE_DAYS) return null;
  return n;
}

/** Interpreta valores textuais de settings booleanas (`'1'`, `'true'`, `'yes'`, `'on'`, case-insensitive). */
function parseBoolSetting(v: string | null | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export type InactiveBlockConfig = { inactiveBlockDays: number; autoBlockEnabled: boolean };

/**
 * Lê a configuração persistida de bloqueio automático por inatividade
 * (`security_inactive_block_days` / `security_inactive_auto_block_enabled` em `settings`).
 * Aplica fallback para `DEFAULT_INACTIVE_BLOCK_DAYS` (90) quando o valor guardado é
 * inválido/ausente — nunca lança por causa de settings corrompidas.
 */
export async function readInactiveBlockConfig(): Promise<InactiveBlockConfig> {
  const [daysRaw, autoRaw] = await Promise.all([getSettingValue(SETTING_INACTIVE_DAYS), getSettingValue(SETTING_AUTO_ENABLED)]);
  return {
    inactiveBlockDays: parseInactiveDays(daysRaw) ?? DEFAULT_INACTIVE_BLOCK_DAYS,
    autoBlockEnabled: parseBoolSetting(autoRaw)
  };
}

/** Persiste a configuração de bloqueio automático por inatividade (upsert em `settings`). */
export async function saveInactiveBlockConfig(days: number, autoBlockEnabled: boolean): Promise<void> {
  await upsertSettingsEntries([
    { key: SETTING_INACTIVE_DAYS, value: String(days) },
    { key: SETTING_AUTO_ENABLED, value: autoBlockEnabled ? '1' : '0' }
  ]);
}

/**
 * Conta quantos jogadores (exclui admin/super-admin) seriam bloqueados por inatividade
 * com o corte de `days` dias — usado na pré-visualização (`GET .../preview`) antes do
 * admin confirmar `blockInactiveUsersByDays`. A condição SQL é idêntica à de
 * `blockInactiveUsersByDays` de propósito: a contagem mostrada ao admin tem de bater
 * certo com quem de facto será bloqueado ao aplicar.
 */
export async function countInactiveUsers(days: number): Promise<number> {
  const cutoff = BigInt(Date.now() - days * MS_PER_DAY);
  const rows = await prisma.$queryRaw<Array<{ count: bigint | number | string }>>`
    SELECT COUNT(*)::bigint AS count
      FROM users u
      LEFT JOIN game_states gs ON gs.user_id = u.id
     WHERE COALESCE(u.is_admin, 0) = 0
       AND COALESCE(u.is_super_admin, 0) = 0
       AND COALESCE(u.is_blocked, 0) = 0
       AND COALESCE(u.last_active_at, gs.last_updated_at) IS NOT NULL
       AND COALESCE(u.last_active_at, gs.last_updated_at) < ${cutoff}
  `;
  const c = rows[0]?.count;
  return c == null ? 0 : Number(c);
}

/**
 * Bloqueia (`is_blocked = 1`) todos os jogadores (exclui admin/super-admin, já
 * bloqueados) sem actividade há mais de `days` dias, e apaga as sessões
 * activas desses jogadores (logout forçado imediato) — mesmo comportamento de
 * `forcePasswordResetForPlayers`, corrigido aqui: antes, esta função não
 * invalidava sessões, então uma conta com sessão já aberta continuava
 * utilizável até expirar naturalmente mesmo depois de "bloqueada". Mesmo
 * filtro SQL de `countInactiveUsers` — ver nota lá.
 *
 * @returns Número de contas efectivamente bloqueadas (0 se não houver alvos).
 */
export async function blockInactiveUsersByDays(days: number): Promise<number> {
  const cutoff = BigInt(Date.now() - days * MS_PER_DAY);
  const rows = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT u.id
      FROM users u
      LEFT JOIN game_states gs ON gs.user_id = u.id
     WHERE COALESCE(u.is_admin, 0) = 0
       AND COALESCE(u.is_super_admin, 0) = 0
       AND COALESCE(u.is_blocked, 0) = 0
       AND COALESCE(u.last_active_at, gs.last_updated_at) IS NOT NULL
       AND COALESCE(u.last_active_at, gs.last_updated_at) < ${cutoff}
  `;
  const ids = rows.map((r) => Number(r.id));
  if (ids.length === 0) return 0;
  await prisma.users.updateMany({ where: { id: { in: ids } }, data: { is_blocked: 1 } });
  const wipe = await callAuthSessionDeleteByUser({ userIds: ids });
  if (!wipe.ok) {
    throw new Error(wipe.error ?? 'auth session delete-by-user failed');
  }
  return ids.length;
}

/**
 * Conta jogadores (exclui admin/super-admin) que seriam afectados por
 * `forcePasswordResetForPlayers` — usado na pré-visualização. Sem filtro de
 * bloqueio/actividade: inclui contas já bloqueadas (reset de senha é
 * independente do estado `is_blocked`).
 */
export async function countPasswordResetTargets(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint | number | string }>>`
    SELECT COUNT(*)::bigint AS count
      FROM users u
     WHERE COALESCE(u.is_admin, 0) = 0
       AND COALESCE(u.is_super_admin, 0) = 0
  `;
  const c = rows[0]?.count;
  return c == null ? 0 : Number(c);
}

/**
 * Reset forçado de senha em massa para todos os jogadores (exclui admin/super-admin):
 * substitui `password` por uma única hash bcrypt de segredo aleatório partilhada por
 * todos os alvos, limpa contadores/locks de login e tokens de "esqueci a senha"
 * pendentes, e apaga as sessões desses jogadores (logout forçado imediato).
 *
 * Uma única hash bcrypt para todos os jogadores atingidos — eles não conhecem a senha de
 * qualquer forma e devem usar "Esqueci a senha". Evita milhares de `bcrypt.hash`
 * sequenciais (timeout de request numa base grande).
 *
 * @returns Número de linhas afectadas pelo `UPDATE`; se o driver não devolver
 *   `rowCount` (`0`/`undefined`) mas havia alvos, cai para `targetCount` da
 *   pré-contagem — evita reportar falsamente `0 resets` num sucesso real.
 */
export async function forcePasswordResetForPlayers(): Promise<number> {
  const idRows = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT u.id
      FROM users u
     WHERE COALESCE(u.is_admin, 0) = 0
       AND COALESCE(u.is_super_admin, 0) = 0
  `;
  const ids = idRows.map((r) => Number(r.id)).filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return 0;

  const randomSecret = crypto.randomBytes(RANDOM_SECRET_BYTES).toString('hex');
  const hash = await authWorkerBcrypt.hash(randomSecret, BCRYPT_ROUNDS_PROFILE);

  const updated = await prisma.$executeRaw`
    UPDATE users
       SET password = ${hash},
           login_failure_count = 0,
           login_locked_until = NULL,
           password_reset_token_hash = NULL,
           password_reset_token_expires_at = NULL
     WHERE COALESCE(is_admin, 0) = 0
       AND COALESCE(is_super_admin, 0) = 0
  `;

  const wipe = await callAuthSessionDeleteByUser({ userIds: ids });
  if (!wipe.ok) {
    throw new Error(wipe.error ?? 'auth session delete-by-user failed');
  }

  return Number(updated) > 0 ? Number(updated) : ids.length;
}
