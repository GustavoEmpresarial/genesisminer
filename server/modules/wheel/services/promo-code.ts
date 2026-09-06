/**
 * Migrado de legacy/backend/models/promoCodeRoleta.ts — só a variante Prisma
 * (`Prisma.TransactionClient`); a sobrecarga com `PoolClient` cru do legado
 * não é usada em `current/server` (não há módulos aqui que ainda falem com o
 * pool `pg` diretamente para este fluxo).
 */
import type { Prisma } from '@prisma/client';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';

const HTTP_BAD_REQUEST = 400;

/** `expires_at` em ms UNIX; 0 ou ausente = sem expiração. */
export function throwIfPromoCodeExpired(row: { expires_at?: unknown }, serverNowMs: number): void {
  const raw = row.expires_at;
  if (raw == null) return;
  const exp = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(exp) || exp <= 0) return;
  if (serverNowMs > exp) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Code expired.' });
  }
}

export function promoTypeLiteralIsRoleta(type: unknown): boolean {
  return typeof type === 'string' && type.startsWith('roleta_');
}

/**
 * Código promocional que abre a roleta: `type` começa com `roleta_` OU está ligado a uma
 * caixa com gatilho `roleta_code`. (O admin às vezes gravava só `loot_box_id` + `per_player`
 * — o resgate caía na loja em vez da roleta.)
 */
export async function promoCodeRowEligibleForRoletaFlow(
  tx: Prisma.TransactionClient,
  row: { type?: unknown; loot_box_id?: string | null }
): Promise<boolean> {
  if (promoTypeLiteralIsRoleta(row.type)) return true;
  const bid = row.loot_box_id;
  if (bid == null || String(bid).trim() === '') return false;
  const lb = await tx.loot_boxes.findFirst({
    where: { id: String(bid).trim() },
    select: { trigger: true }
  });
  return String(lb?.trigger || '') === 'roleta_code';
}
