/**
 * Persistência de refresh tokens via `genesis-auth` (hash em repouso, rotate
 * atómico `SELECT … FOR UPDATE` no worker). Fail-closed: unset URL → throw.
 */
import {
  callAuthRefreshIssue,
  callAuthRefreshRevoke,
  callAuthRefreshRotate
} from './auth-worker-client.js';

/** Marca todos os refresh tokens ativos do utilizador como revogados (não apaga histórico). */
export async function revokeAllRefreshForUser(userId: number): Promise<void> {
  const r = await callAuthRefreshRevoke({ userId });
  if (!r.ok) {
    throw new Error(r.error ?? 'auth refresh revoke failed');
  }
}

export type IssueRefreshArgs = {
  userId: number;
  userAgent: string | null;
  ip: string | null;
};

export type IssuedRefresh = {
  refreshToken: string;
  expiresAtMs: number;
  expiresInSec: number;
};

/** Worker gera o raw token, guarda só o hash e devolve o valor para o cookie. */
export async function issueRefreshToken(args: IssueRefreshArgs): Promise<IssuedRefresh> {
  const r = await callAuthRefreshIssue({
    userId: args.userId,
    userAgent: args.userAgent,
    ip: args.ip
  });
  if (!r.ok) {
    throw new Error(r.error ?? 'auth refresh issue failed');
  }
  return {
    refreshToken: r.refreshToken,
    expiresAtMs: r.expiresAtMs,
    expiresInSec: r.expiresInSec
  };
}

export type RotateRefreshOk = {
  ok: true;
  userId: number;
  newRefreshRaw: string;
  expiresInSec: number;
};
export type RotateRefreshFail = { ok: false; code: string };
export type RotateRefreshResult = RotateRefreshOk | RotateRefreshFail;

/**
 * Rotação atómica no worker: `SELECT … FOR UPDATE`, valida não-revogado/não-expirado,
 * substitui por novo token da mesma família. `{ ok: false, code: 'invalid'|'expired' }`
 * para falha de token; infra (unset/5xx) lança.
 */
export async function rotateRefreshToken(
  rawOld: string,
  { userAgent, ip }: { userAgent: string | null; ip: string | null }
): Promise<RotateRefreshResult> {
  const r = await callAuthRefreshRotate({
    refreshToken: rawOld,
    userAgent,
    ip
  });
  if (!r.ok) {
    return { ok: false, code: r.code };
  }
  return {
    ok: true,
    userId: r.userId,
    newRefreshRaw: r.refreshToken,
    expiresInSec: r.expiresInSec
  };
}
