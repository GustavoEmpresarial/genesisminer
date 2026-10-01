/**
 * Partner Games — multi-game catalog + session by slug.
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
export {
  MS_PER_SECOND as PARTNER_GAMES_MS_PER_SECOND,
  SECONDS_PER_MINUTE as PARTNER_GAMES_SECONDS_PER_MINUTE
};

export type PartnerGameSection = 'official' | 'partner';

export type PartnerGame = {
  slug: string;
  name: string;
  publicUrl: string;
  embedPath: string | null;
  imageUrl: string | null;
  sessionKind: string;
  section: PartnerGameSection;
};

export type PartnerGamesConfig = {
  heartbeatIntervalMs: number;
  games: PartnerGame[];
  /** When true, UI shows maintenance and session APIs reject. */
  maintenance: boolean;
};

export type PartnerGamesHeartbeatResult = {
  accepted: boolean;
  creditedMinutes: number;
  nextEligibleAtMs: number;
};

function parseOptionalString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t ? t : null;
}

function parseSection(raw: unknown): PartnerGameSection | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t === 'official' || t === 'partner') return t;
  return null;
}

function parseGame(raw: unknown): PartnerGame | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  const slug = parseOptionalString(g.slug);
  const name = parseOptionalString(g.name);
  const publicUrl = parseOptionalString(g.publicUrl);
  const sessionKind = parseOptionalString(g.sessionKind);
  const section = parseSection(g.section);
  if (!slug || !name || !publicUrl || !sessionKind || !section) return null;
  return {
    slug,
    name,
    publicUrl,
    embedPath: parseOptionalString(g.embedPath),
    imageUrl: parseOptionalString(g.imageUrl),
    sessionKind,
    section
  };
}

/** Exported for unit tests. */
export function parsePartnerGamesConfig(raw: Record<string, unknown>): PartnerGamesConfig | null {
  if (raw.ok !== true) return null;
  const heartbeatIntervalMs =
    typeof raw.heartbeatIntervalMs === 'number' &&
    Number.isFinite(raw.heartbeatIntervalMs) &&
    raw.heartbeatIntervalMs > 0
      ? Math.floor(raw.heartbeatIntervalMs)
      : PARTNER_GAMES_HEARTBEAT_INTERVAL_MS;
  const maintenance = raw.maintenance === true;
  const gamesRaw = Array.isArray(raw.games) ? raw.games : [];
  const games: PartnerGame[] = [];
  for (const item of gamesRaw) {
    const g = parseGame(item);
    if (g) games.push(g);
  }
  return { heartbeatIntervalMs, games, maintenance };
}

export function fallbackPartnerGamesConfig(): PartnerGamesConfig {
  return {
    heartbeatIntervalMs: PARTNER_GAMES_HEARTBEAT_INTERVAL_MS,
    games: [],
    // Fail-closed while tab is in operational maintenance: config load failure → maintenance UI.
    maintenance: true
  };
}

export function partnerGameBySlug(
  config: PartnerGamesConfig,
  slug: string
): PartnerGame | null {
  const needle = slug.trim();
  if (!needle) return null;
  return config.games.find((g) => g.slug === needle) ?? null;
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
    const data = parsePartnerGamesConfig(raw);
    if (!data) return { ok: false, error: 'INVALID' };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

function slugBody(slug: string): string {
  return JSON.stringify({ slug });
}

/** POST /api/partner-games/visit */
export async function postPartnerGamesVisit(slug: string): Promise<{ ok: boolean }> {
  try {
    const res = await apiFetch(`${base}/visit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: slugBody(slug)
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

/** POST /api/partner-games/heartbeat */
export async function postPartnerGamesHeartbeat(
  slug: string
): Promise<{ ok: true; data: PartnerGamesHeartbeatResult } | { ok: false }> {
  try {
    const res = await apiFetch(`${base}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: slugBody(slug)
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
export async function postPartnerGamesStop(slug: string): Promise<{ ok: boolean }> {
  try {
    const res = await apiFetch(`${base}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: slugBody(slug)
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}
