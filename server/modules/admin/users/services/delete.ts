/**
 * Exclusão administrativa pontual (`DELETE /api/user/:email`).
 * Reutiliza `deleteUserByEmail` (mesmo cascade de network-delete).
 * Política de outro admin: igual a `POST /api/admin/referrals/network-delete`.
 */
import { prisma } from '../../../../core/database/prisma.js';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import { deleteUserByEmail } from '../../referral/services/delete-user.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const EMAIL_MAX = 254;

export type DeleteAdminUserInput = {
  actorUserId: number;
  actorIsSuperAdmin: boolean;
  emailRaw: unknown;
  revokeJwtRefreshForUser: (userId: number) => Promise<void>;
};

function truthyFlag(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0;
}

export function parseAdminUserPathEmail(raw: unknown): string {
  const source = String(raw ?? '').trim();
  if (!source) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { ok: false, error: 'Email inválido.', code: 'VALIDATION' });
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(source).trim();
  } catch {
    decoded = source;
  }
  if (!decoded || decoded.length > EMAIL_MAX) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { ok: false, error: 'Email inválido.', code: 'VALIDATION' });
  }
  return decoded;
}

export async function deleteAdminUserByEmail(input: DeleteAdminUserInput): Promise<{ ok: true }> {
  const email = parseAdminUserPathEmail(input.emailRaw);

  const target = await prisma.users.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, is_admin: true }
  });
  if (!target) {
    throw new HttpControlledError(HTTP_NOT_FOUND, { ok: false, error: 'Utilizador não encontrado.', code: 'NOT_FOUND' });
  }

  const targetIsAdmin = truthyFlag(target.is_admin);
  const editingOther = input.actorUserId !== target.id;
  if (targetIsAdmin && editingOther && !input.actorIsSuperAdmin) {
    throw new HttpControlledError(HTTP_FORBIDDEN, {
      ok: false,
      error: 'Apenas super administradores podem excluir outras contas administrador.',
      code: 'FORBIDDEN'
    });
  }

  let result: { ok: boolean; error?: string };
  try {
    result = await deleteUserByEmail(email, null);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('várias contas com o mesmo e-mail')) {
      throw new HttpControlledError(HTTP_CONFLICT, { ok: false, error: msg, code: 'CONFLICT' });
    }
    throw e;
  }

  if (!result.ok) {
    const err = result.error || 'Utilizador não encontrado.';
    if (err.includes('inválido')) {
      throw new HttpControlledError(HTTP_BAD_REQUEST, { ok: false, error: err, code: 'VALIDATION' });
    }
    throw new HttpControlledError(HTTP_NOT_FOUND, { ok: false, error: err, code: 'NOT_FOUND' });
  }

  try {
    await input.revokeJwtRefreshForUser(target.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[DELETE /api/user/:email] revokeJwtRefreshForUser após exclusão:', msg);
  }

  return { ok: true };
}
