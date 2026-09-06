/**
 * Emissão/verificação do access token JWT via `genesis-auth` worker (fail-closed).
 *
 * Sem fallback `jsonwebtoken` — unset `GENESIS_AUTH_URL` lança.
 * Cookie Max-Age must use `expiresInSec` from the worker sign response (same TTL as token `exp`).
 */
import {
  callAuthJwtSign,
  callAuthJwtVerify
} from './auth-worker-client.js';

const USER_ID_PATTERN = /^\d+$/;

export type VerifiedAccess = { userId: number; jti: string | undefined; exp: number | undefined };

export type SignedAccessToken = { token: string; expiresInSec: number };

export async function signAccessToken(userId: number | string): Promise<SignedAccessToken> {
  const sub = String(userId);
  if (!USER_ID_PATTERN.test(sub)) {
    const e = new Error('Identificador de utilizador inválido para token.');
    e.name = 'ValidationError';
    throw e;
  }
  const r = await callAuthJwtSign(sub);
  if (!r.ok || !r.token || r.expiresInSec == null || r.expiresInSec <= 0) {
    const e = new Error(r.error ?? 'JWT sign failed');
    e.name = r.errorName ?? 'JsonWebTokenError';
    throw e;
  }
  return { token: r.token, expiresInSec: r.expiresInSec };
}

export async function verifyAccessToken(token: string): Promise<VerifiedAccess> {
  const r = await callAuthJwtVerify(token);
  if (!r.ok || r.userId == null) {
    const e = new Error(r.error ?? 'JWT verify failed');
    e.name = r.errorName ?? 'JsonWebTokenError';
    throw e;
  }
  return { userId: r.userId, jti: r.jti, exp: r.exp };
}
