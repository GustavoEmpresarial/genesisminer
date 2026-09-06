/**
 * Wheel / Roleta player API — DECISIONS #101.
 * Routes under `/api/wheel/*` and `/api/roleta/*`.
 */
import { apiFetch } from './http';

const base = '/api';

export type WheelItem = {
  id: string;
  label: string;
  weight: number;
  color: string;
  itemId?: string;
  image?: string;
  isActive?: number;
  tier?: string;
};

export type WheelStatePayload = {
  spinPriceUsdc: number;
  paidWheelEnabled: boolean;
  usdcBalance: number;
  legacyPaidPending: { wonItemId: string } | null;
  prizes: WheelItem[];
  notice?: string;
};

export function clearPendingPaidSpin(): void {
  try {
    globalThis.sessionStorage?.removeItem('gm_pending_paid_spin');
    globalThis.localStorage?.removeItem('gm_pending_paid_spin');
  } catch {
    /* ignore */
  }
}

export function newWheelIdempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

export async function getPendingRoletaCode(): Promise<string | null> {
  try {
    const res = await apiFetch(`${base}/roleta/pending-code`);
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { code?: unknown };
    const c = data.code;
    if (c == null || typeof c !== 'string') return null;
    const t = c.trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export async function getWheelState(): Promise<
  { ok: true; data: WheelStatePayload } | { ok: false; error: string; status?: number }
> {
  try {
    const res = await apiFetch(`${base}/wheel/state`);
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err =
        typeof (raw as { error?: unknown }).error === 'string'
          ? (raw as { error: string }).error
          : `HTTP ${res.status}`;
      return { ok: false, error: err, status: res.status };
    }
    const j = raw as Record<string, unknown>;
    const spinPriceUsdc =
      typeof j.spinPriceUsdc === 'number' ? j.spinPriceUsdc : Number(j.spinPriceUsdc) || 1;
    const cfgObj = j.config as { isEnabled?: unknown } | undefined;
    const paidWheelEnabled =
      typeof j.paidWheelEnabled === 'boolean'
        ? j.paidWheelEnabled
        : typeof cfgObj?.isEnabled === 'boolean'
          ? cfgObj.isEnabled
          : true;
    const usdcBalance = typeof j.usdcBalance === 'number' ? j.usdcBalance : Number(j.usdcBalance) || 0;
    const leg = j.legacyPaidPending as { wonItemId?: string } | null | undefined;
    const legacyPaidPending =
      leg && typeof leg.wonItemId === 'string' && leg.wonItemId.trim()
        ? { wonItemId: leg.wonItemId.trim() }
        : null;
    const prizes = Array.isArray(j.prizes) ? (j.prizes as WheelItem[]) : [];
    const notice = typeof j.notice === 'string' ? j.notice : undefined;
    return {
      ok: true,
      data: { spinPriceUsdc, paidWheelEnabled, usdcBalance, legacyPaidPending, prizes, notice }
    };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

export async function postWheelSpin(idempotencyKey: string): Promise<
  | {
      ok: true;
      spinId: string;
      wonItemId: string;
      item?: unknown;
      newUsdc?: number;
      chargedUsdc: number;
      boxId: string;
      boxName: string;
      idempotentReplay?: boolean;
    }
  | { ok: false; error: string; status?: number }
> {
  try {
    const res = await apiFetch(`${base}/wheel/spin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey })
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err =
        typeof (raw as { error?: unknown }).error === 'string'
          ? (raw as { error: string }).error
          : `HTTP ${res.status}`;
      return { ok: false, error: err, status: res.status };
    }
    const j = raw as Record<string, unknown>;
    return {
      ok: true,
      spinId: String(j.spinId ?? ''),
      wonItemId: String(j.wonItemId ?? ''),
      item: j.item,
      newUsdc: typeof j.newUsdc === 'number' ? j.newUsdc : undefined,
      chargedUsdc: Number(j.chargedUsdc) || 0,
      boxId: String(j.boxId ?? ''),
      boxName: String(j.boxName ?? ''),
      idempotentReplay: Boolean(j.idempotentReplay)
    };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

export async function postWheelRedeemCode(
  code: string,
  idempotencyKey: string
): Promise<{ ok: boolean; error?: string; status?: number; data?: unknown }> {
  try {
    const res = await apiFetch(`${base}/wheel/redeem-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, idempotencyKey })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error:
          typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : `HTTP ${res.status}`,
        status: res.status
      };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

export async function rollWheel(
  code: string
): Promise<{ ok: boolean; wonItemId?: string; item?: unknown; error?: string }> {
  try {
    const res = await apiFetch(`${base}/wheel/roll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      wonItemId?: string;
      item?: unknown;
      error?: string;
    };
    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return {
      ok: data.ok !== false,
      wonItemId: data.wonItemId,
      item: data.item,
      error: data.error
    };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

export async function claimRoletaPrize(
  code: string,
  wonItemId: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/roleta/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, wonItemId })
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}
