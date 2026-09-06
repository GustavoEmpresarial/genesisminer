/**
 * Inventário admin de caixas não abertas do jogador (`unopened_boxes`).
 *
 * Migrado de legacy/backend/server.ts (`GET /api/admin/user-boxes`,
 * `POST /api/admin/delete-user-box`). Lookup por email case-insensitive —
 * nunca `getUserIdByEmail`.
 */
import { prisma } from '../../../../core/database/prisma.js';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const EMAIL_MAX = 254;

export type UserBoxRow = { box_id: string; qty: number };

export type ListUserBoxesResult = { boxes: UserBoxRow[] };

export type DeleteUserBoxResult = {
  ok: true;
  message: string;
  deletedQty: number;
};

function normalizeEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
}

async function findUserIdByEmailInsensitive(email: string): Promise<number> {
  const user = await prisma.users.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true }
  });
  if (!user) {
    throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'User not found' });
  }
  return user.id;
}

/** Lista caixas não abertas do utilizador (`{ boxes: [{ box_id, qty }] }`). */
export async function listUserUnopenedBoxes(emailRaw: unknown): Promise<ListUserBoxesResult> {
  const email = normalizeEmail(emailRaw);
  if (!email || email.length > EMAIL_MAX) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Email required' });
  }

  const userId = await findUserIdByEmailInsensitive(email);
  const rows = await prisma.unopened_boxes.findMany({
    where: { user_id: userId },
    select: { box_id: true, qty: true },
    orderBy: { qty: 'desc' }
  });

  return {
    boxes: rows.map((r) => ({ box_id: String(r.box_id), qty: Number(r.qty) || 0 }))
  };
}

/** Apaga uma linha de `unopened_boxes` (user + boxId) e devolve qty removida. */
export async function deleteUserUnopenedBox(
  emailRaw: unknown,
  boxIdRaw: unknown
): Promise<DeleteUserBoxResult> {
  const email = normalizeEmail(emailRaw);
  const boxId = boxIdRaw != null && boxIdRaw !== '' ? String(boxIdRaw).trim() : '';
  if (!email || email.length > EMAIL_MAX || !boxId) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Email and boxId required' });
  }

  const userId = await findUserIdByEmailInsensitive(email);
  const existing = await prisma.unopened_boxes.findUnique({
    where: { user_id_box_id: { user_id: userId, box_id: boxId } },
    select: { qty: true }
  });
  if (!existing) {
    throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'Box not found in user inventory' });
  }

  await prisma.unopened_boxes.delete({
    where: { user_id_box_id: { user_id: userId, box_id: boxId } }
  });

  const deletedQty = Number(existing.qty) || 0;
  return {
    ok: true,
    message: `Deleted ${deletedQty}x box ${boxId} from ${email}`,
    deletedQty
  };
}
