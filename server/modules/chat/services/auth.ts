/**
 * Migrado de legacy/backend/modules/chat/chat.auth.ts. `verifyAccessToken`/
 * `COOKIE_ACCESS` reaproveitam `modules/auth`; `loadSessionManagerFlags`
 * reaproveita `modules/gerente` — nenhum dos dois duplicado aqui.
 */
import type { IncomingMessage } from 'node:http';
import db from '../../../core/database/pool.js';
import { COOKIE_ACCESS } from '../../auth/services/config.js';
import { verifyAccessToken } from '../../auth/services/jwt-service.js';
import { loadSessionUser } from '../../auth/models/repository.js';
import { loadSessionManagerFlags } from '../../gerente/services/manager.js';

function allowLegacySid(): boolean {
  return process.env.JWT_ALLOW_LEGACY_SESSION === '1' && process.env.JWT_ALLOW_LEGACY_SID === '1';
}

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export type ChatActor = {
  /** sessions.user_id / JWT (dono quando em modo gerência). */
  sessionUserId: number;
  /** Humano real (gerente se manager_mode). */
  realUserId: number;
  managerMode: boolean;
  managerUserId: number | null;
  actingAsOwnerId: number | null;
  sid: string | null;
};

/** Resolve userId a partir dos cookies do handshake Socket.IO/upgrade WS. */
export async function resolveUserIdFromCookieHeader(cookieHeader: string | undefined): Promise<number | null> {
  const actor = await resolveChatActorFromCookieHeader(cookieHeader);
  return actor?.sessionUserId ?? null;
}

export async function resolveChatActorFromCookieHeader(cookieHeader: string | undefined): Promise<ChatActor | null> {
  const cookies = parseCookieHeader(cookieHeader);
  const sid = typeof cookies.sid === 'string' && cookies.sid ? cookies.sid : null;
  let sessionUserId: number | null = null;

  const accessRaw = cookies[COOKIE_ACCESS];
  if (typeof accessRaw === 'string' && accessRaw.length > 0) {
    try {
      const v = await verifyAccessToken(accessRaw);
      const uid = Number(v.userId);
      if (Number.isFinite(uid) && uid > 0) sessionUserId = uid;
    } catch {
      /* access inválido */
    }
  }

  if (sessionUserId == null && allowLegacySid() && sid) {
    const loaded = await loadSessionUser(sid);
    if (loaded) {
      const uid = Number(loaded.user.id);
      if (Number.isFinite(uid) && uid > 0) sessionUserId = uid;
    }
  }

  if (sessionUserId == null) return null;

  let managerMode = false;
  let managerUserId: number | null = null;
  let actingAsOwnerId: number | null = null;
  if (sid) {
    try {
      const flags = await loadSessionManagerFlags(db, sid);
      if (flags.managerMode) {
        managerMode = true;
        managerUserId = flags.managerUserId;
        actingAsOwnerId = flags.actingAsOwnerId;
      }
    } catch {
      /* ignore */
    }
  }

  const realUserId = managerMode && managerUserId != null && managerUserId > 0 ? managerUserId : sessionUserId;

  return { sessionUserId, realUserId, managerMode, managerUserId, actingAsOwnerId, sid };
}

export async function resolveChatActorFromHandshakeLike(handshake: { headers?: { cookie?: string }; request?: IncomingMessage }): Promise<ChatActor | null> {
  const fromHandshake = handshake?.headers?.cookie;
  if (fromHandshake) return resolveChatActorFromCookieHeader(fromHandshake);
  const fromReq = handshake?.request?.headers?.cookie;
  return resolveChatActorFromCookieHeader(typeof fromReq === 'string' ? fromReq : undefined);
}

export async function resolveUserIdFromHandshakeLike(handshake: { headers?: { cookie?: string }; request?: IncomingMessage }): Promise<number | null> {
  const actor = await resolveChatActorFromHandshakeLike(handshake);
  return actor?.sessionUserId ?? null;
}
