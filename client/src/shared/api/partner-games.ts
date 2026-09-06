/**
 * Partner Games (BlockMiner hub) — config / visit / heartbeat / stop.
 */
import { apiFetch } from './http';

const base = '/api/partner-games';

/** Root time units — mirror `server/shared/utils/time.ts` (no shared client package). */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** Mirror of server/Rust `HEARTBEAT_INTERVAL_MS` (= MS_PER_MINUTE) when config fails. */
export const PARTNER_GAMES_HEARTBEAT_INTERVAL_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;
/** One second in ms — used by session elapsed display tick. */
export const PARTNER_GAMES_ELAPSED_TICK_MS = MS_PER_SECOND;
export const PARTNER_GAMES_EMBED_PATH = '/bm/';
export const PARTNER_GAMES_PUBLIC_URL = 'https://blockminer.space/';
export { MS_PER_SECOND as PARTNER_GAMES_MS_PER_SECOND, SECONDS_PER_MINUTE as PARTNER_GAMES_SECONDS_PER_MINUTE };

export type PartnerGamesConfig = {
  embedPath: string;
  publicUrl: string;
  heartbeatIntervalMs: number;
  sessionKind: string;
  /** When true, UI shows maintenance and session APIs reject. */
  maintenance: boolean;
};

export type PartnerGamesHeartbeatResult = {
  accepted: boolean;
  creditedMinutes: number;
  nextEligibleAtMs: number;
};

function parseConfig(raw: Record<string, unknown>): PartnerGamesConfig | null {
  if (raw.ok !== true) return null;
  const embedPath =
    typeof raw.embedPath === 'string' && raw.embedPath.trim()
      ? raw.embedPath.trim()
      : PARTNER_GAMES_EMBED_PATH;
  const publicUrl =
    typeof raw.publicUrl === 'string' && raw.publicUrl.trim()
      ? raw.publicUrl.trim()
      : PARTNER_GAMES_PUBLIC_URL;
  const heartbeatIntervalMs =
    typeof raw.heartbeatIntervalMs === 'number' &&
    Number.isFinite(raw.heartbeatIntervalMs) &&
    raw.heartbeatIntervalMs > 0
      ? Math.floor(raw.heartbeatIntervalMs)
      : PARTNER_GAMES_HEARTBEAT_INTERVAL_MS;
  const sessionKind =
    typeof raw.sessionKind === 'string' && raw.sessionKind.trim()
      ? raw.sessionKind.trim()
      : 'blockminer';
  const maintenance = raw.maintenance === true;
  return { embedPath, publicUrl, heartbeatIntervalMs, sessionKind, maintenance };
}

export function fallbackPartnerGamesConfig(): PartnerGamesConfig {
  return {
    embedPath: PARTNER_GAMES_EMBED_PATH,
    publicUrl: PARTNER_GAMES_PUBLIC_URL,
    heartbeatIntervalMs: PARTNER_GAMES_HEARTBEAT_INTERVAL_MS,
    sessionKind: 'blockminer',
    // Fail-closed while tab is in operational maintenance: config load failure → maintenance UI.
    maintenance: true
  };
}

/** GET /api/partner-games/config */
export async function getPartnerGamesConfig(): Promise<
  { ok: true; data: PartnerGamesConfig } | { ok: false; error: string }
> {
  try {
    const res = await apiFetch(`${base}/config`);
    if (res.status === 401) return { ok: false, error: 'SESSION' };
    const raw = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim() : 'LOAD_FAILED';
      return { ok: false, error: err };
    }
    const data = parseConfig(raw);
    if (!data) return { ok: false, error: 'INVALID' };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

/** POST /api/partner-games/visit */
export async function postPartnerGamesVisit(): Promise<{ ok: boolean }> {
  try {
    const res = await apiFetch(`${base}/visit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

/** POST /api/partner-games/heartbeat */
export async function postPartnerGamesHeartbeat(): Promise<
  { ok: true; data: PartnerGamesHeartbeatResult } | { ok: false }
> {
  try {
    const res = await apiFetch(`${base}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) return { ok: false };
    const raw = (await res.json()) as Record<string, unknown>;
    if (raw.ok !== true) return { ok: false };
    return {
      ok: true,
      data: {
        accepted: raw.accepted === true,
        creditedMinutes:
          typeof raw.creditedMinutes === 'number' && Number.isFinite(raw.creditedMinutes)
            ? Math.max(0, Math.floor(raw.creditedMinutes))
            : 0,
        nextEligibleAtMs:
          typeof raw.nextEligibleAtMs === 'number' && Number.isFinite(raw.nextEligibleAtMs)
            ? Math.floor(raw.nextEligibleAtMs)
            : Date.now()
      }
    };
  } catch {
    return { ok: false };
  }
}

/** POST /api/partner-games/stop */
export async function postPartnerGamesStop(): Promise<{ ok: boolean }> {
  try {
    const res = await apiFetch(`${base}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}
