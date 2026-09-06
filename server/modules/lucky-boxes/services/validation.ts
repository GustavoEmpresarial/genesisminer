/**
 * Migrado de legacy/backend/validation/lootBoxValidation.ts. A sobrecarga
 * `PoolClient`/pg cru de `assertEmailMatchesSession` não é usada em
 * `current/server` (só a variante Prisma).
 */
import type { PrismaClient } from '@prisma/client';

const BOX_ID_RE = /^[a-zA-Z0-9_.-]+$/;
const BOX_ID_MAX_LENGTH = 200;
const DISCARD_QTY_MAX = 100_000;

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;

/** Valida ID de caixa vindo da API (path/body). */
export function parseLootBoxId(raw: unknown): string | null {
  const boxId = typeof raw === 'string' ? raw.trim() : '';
  if (!boxId || boxId.length > BOX_ID_MAX_LENGTH || !BOX_ID_RE.test(boxId)) return null;
  return boxId;
}

/** Extrai e valida `boxId` do corpo JSON de compra/abertura. */
export function bodyLootBoxId(body: unknown): string | null {
  if (body == null || typeof body !== 'object') return null;
  return parseLootBoxId((body as { boxId?: unknown }).boxId);
}

/**
 * Quantidade a descartar: ausente = todas as unidades em inventário.
 * Retorna `null` se `qty` for inválida (corpo mal formado).
 */
export function bodyOptionalDiscardQty(body: unknown): number | 'all' | null {
  if (body == null || typeof body !== 'object') return 'all';
  const q = (body as { qty?: unknown }).qty;
  if (q === undefined || q === null) return 'all';
  const n = typeof q === 'number' ? q : parseInt(String(q), 10);
  if (!Number.isFinite(n) || n !== Math.floor(n) || n < 1 || n > DISCARD_QTY_MAX) return null;
  return n;
}

/** Se o cliente envia `email`, tem de coincidir com o utilizador da sessão (camada extra contra CSRF confuso). */
export async function assertEmailMatchesSession(
  db: Pick<PrismaClient, 'users'>,
  userId: number,
  bodyEmail: unknown
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (bodyEmail == null || bodyEmail === '') return { ok: true };
  if (typeof bodyEmail !== 'string') {
    return { ok: false, status: HTTP_BAD_REQUEST, error: 'Invalid email.' };
  }
  const user = await db.users.findUnique({ where: { id: userId }, select: { email: true } });
  const sessionEmail = (user?.email ?? '').trim().toLowerCase();
  if (bodyEmail.trim().toLowerCase() !== sessionEmail) {
    return { ok: false, status: HTTP_FORBIDDEN, error: 'Session does not match email.' };
  }
  return { ok: true };
}
