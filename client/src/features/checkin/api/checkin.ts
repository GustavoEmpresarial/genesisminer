import { apiFetch } from '../../../shared/api/http';

const base = '/api';

export type CheckinStatusPayload = {
  today: string;
  timezone: string;
  lastCheckinDay: string | null;
  lastCheckinAtMs: number | null;
  streak: number;
  todayCheckedIn: boolean;
  canEarlyCheckin: boolean;
  frozen: boolean;
  nextResetMs: number;
  /** Next daily check-in unlock (UTC midnight), or null if available now. */
  nextCheckinAtMs: number | null;
  windowRemainingMs: number;
  windowDurationMs: number;
  rewardCycleProgress: number;
  rewardCycleSize: number;
  premiumWeeklyCheckin: boolean;
  premiumIntervalDays: number;
  premiumMinUsdc: number;
  nextCheckinAllowedMs: number | null;
  canCheckinNow: boolean;
  checkinBonusHps: number;
  rewardType: 'hashrate' | 'battery' | 'item';
  rewardUnit: string;
  dailyRewardAmount: number;
  weeklyRewardAmount: number;
  streakRewardEnabled: boolean;
  streakRewardItemId: string;
  streakRewardDurationAmount: number;
  streakRewardDurationUnit: string;
  streakRewardDurationLabel: string | null;
};

export type CheckinPerformPayload = CheckinStatusPayload & {
  performed: boolean;
  rewardGranted: number;
  rewardType: 'hashrate' | 'battery' | 'item';
  rewardUnit: string;
  checkinBonusHps: number;
  streakReset: boolean;
  streakRewardGranted: number;
  streakRewardGrantedItemId: string | null;
  streakRewardGrantedItemName: string | null;
  streakRewardGrantedExpiresAtMs: number | null;
  streakRewardGrantedDurationLabel: string | null;
};

function parseCheckinStatusPayload(raw: Record<string, unknown>): CheckinStatusPayload | null {
  if (raw.ok !== true) return null;
  const today = typeof raw.today === 'string' ? raw.today : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const streak =
    typeof raw.streak === 'number' && Number.isFinite(raw.streak) ? Math.max(0, Math.floor(raw.streak)) : 0;
  const nextResetMs =
    typeof raw.nextResetMs === 'number' && Number.isFinite(raw.nextResetMs) ? raw.nextResetMs : Date.now();
  const lastCheckinAtMs =
    typeof raw.lastCheckinAtMs === 'number' && Number.isFinite(raw.lastCheckinAtMs) && raw.lastCheckinAtMs > 0
      ? Math.floor(raw.lastCheckinAtMs)
      : null;
  const windowDurationMs =
    typeof raw.windowDurationMs === 'number' && Number.isFinite(raw.windowDurationMs) && raw.windowDurationMs > 0
      ? Math.floor(raw.windowDurationMs)
      : 24 * 60 * 60 * 1000;
  const windowRemainingMs =
    typeof raw.windowRemainingMs === 'number' && Number.isFinite(raw.windowRemainingMs) && raw.windowRemainingMs >= 0
      ? Math.floor(raw.windowRemainingMs)
      : Math.max(0, nextResetMs - Date.now());
  return {
    today,
    timezone: typeof raw.timezone === 'string' ? raw.timezone : 'UTC',
    lastCheckinDay: (() => {
      const v = raw.lastCheckinDay;
      if (v == null || v === '') return null;
      const s = String(v).trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    })(),
    lastCheckinAtMs,
    streak,
    todayCheckedIn: raw.todayCheckedIn === true,
    canEarlyCheckin: raw.canEarlyCheckin === true,
    frozen: raw.frozen === true,
    nextResetMs,
    nextCheckinAtMs:
      typeof raw.nextCheckinAtMs === 'number' && Number.isFinite(raw.nextCheckinAtMs)
        ? Math.floor(raw.nextCheckinAtMs)
        : null,
    windowRemainingMs,
    windowDurationMs,
    rewardCycleProgress:
      typeof raw.rewardCycleProgress === 'number' && Number.isFinite(raw.rewardCycleProgress)
        ? Math.max(0, Math.floor(raw.rewardCycleProgress))
        : 0,
    rewardCycleSize:
      typeof raw.rewardCycleSize === 'number' && Number.isFinite(raw.rewardCycleSize)
        ? Math.max(1, Math.floor(raw.rewardCycleSize))
        : 7,
    premiumWeeklyCheckin: raw.premiumWeeklyCheckin === true,
    premiumIntervalDays:
      typeof raw.premiumIntervalDays === 'number' && Number.isFinite(raw.premiumIntervalDays)
        ? Math.max(1, Math.floor(raw.premiumIntervalDays))
        : 7,
    premiumMinUsdc:
      typeof raw.premiumMinUsdc === 'number' && Number.isFinite(raw.premiumMinUsdc) ? raw.premiumMinUsdc : 195,
    nextCheckinAllowedMs:
      typeof raw.nextCheckinAllowedMs === 'number' && Number.isFinite(raw.nextCheckinAllowedMs)
        ? Math.floor(raw.nextCheckinAllowedMs)
        : null,
    canCheckinNow: raw.canCheckinNow !== false,
    checkinBonusHps:
      typeof raw.checkinBonusHps === 'number' && Number.isFinite(raw.checkinBonusHps)
        ? Math.max(0, raw.checkinBonusHps)
        : 0,
    rewardType:
      raw.rewardType === 'battery' || raw.rewardType === 'item' || raw.rewardType === 'hashrate'
        ? raw.rewardType
        : 'hashrate',
    rewardUnit: typeof raw.rewardUnit === 'string' && raw.rewardUnit.trim() ? raw.rewardUnit.trim() : 'H/s',
    dailyRewardAmount:
      typeof raw.dailyRewardAmount === 'number' && Number.isFinite(raw.dailyRewardAmount)
        ? Math.max(0, raw.dailyRewardAmount)
        : 1,
    weeklyRewardAmount:
      typeof raw.weeklyRewardAmount === 'number' && Number.isFinite(raw.weeklyRewardAmount)
        ? Math.max(0, raw.weeklyRewardAmount)
        : 7,
    streakRewardEnabled: raw.streakRewardEnabled === true,
    streakRewardItemId: typeof raw.streakRewardItemId === 'string' ? raw.streakRewardItemId.trim() : '',
    streakRewardDurationAmount:
      typeof raw.streakRewardDurationAmount === 'number' && Number.isFinite(raw.streakRewardDurationAmount)
        ? Math.max(1, Math.floor(raw.streakRewardDurationAmount))
        : 7,
    streakRewardDurationUnit:
      raw.streakRewardDurationUnit === 'week' ||
      raw.streakRewardDurationUnit === 'month' ||
      raw.streakRewardDurationUnit === 'year'
        ? raw.streakRewardDurationUnit
        : 'day',
    streakRewardDurationLabel:
      typeof raw.streakRewardDurationLabel === 'string' && raw.streakRewardDurationLabel.trim()
        ? raw.streakRewardDurationLabel.trim()
        : null
  };
}

/** GET /api/checkin/status */
export async function getCheckinStatus(): Promise<
  { ok: true; data: CheckinStatusPayload } | { ok: false; error: string }
> {
  try {
    const res = await apiFetch(`${base}/checkin/status`);
    if (res.status === 401) return { ok: false, error: 'SESSION' };
    const raw = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim() : 'LOAD_FAILED';
      return { ok: false, error: err };
    }
    const data = parseCheckinStatusPayload(raw);
    if (!data) return { ok: false, error: 'INVALID' };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

/** POST /api/checkin — idempotent in the same UTC day (00:00→00:00). */
export async function postCheckin(): Promise<
  { ok: true; data: CheckinPerformPayload } | { ok: false; error: string; code?: string }
> {
  try {
    const res = await apiFetch(`${base}/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.status === 401) return { ok: false, error: 'SESSION' };
    const raw = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof raw.code === 'string' ? raw.code : undefined;
      const err = typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim() : 'CLAIM_FAILED';
      return { ok: false, error: err, code };
    }
    const baseFields = parseCheckinStatusPayload(raw);
    if (!baseFields) return { ok: false, error: 'INVALID' };
    const data: CheckinPerformPayload = {
      ...baseFields,
      performed: raw.performed === true,
      rewardGranted:
        typeof raw.rewardGranted === 'number' && Number.isFinite(raw.rewardGranted)
          ? Math.max(0, raw.rewardGranted)
          : 0,
      rewardType:
        raw.rewardType === 'battery' || raw.rewardType === 'item' || raw.rewardType === 'hashrate'
          ? raw.rewardType
          : baseFields.rewardType,
      rewardUnit:
        typeof raw.rewardUnit === 'string' && raw.rewardUnit.trim()
          ? raw.rewardUnit.trim()
          : baseFields.rewardUnit,
      checkinBonusHps:
        typeof raw.checkinBonusHps === 'number' && Number.isFinite(raw.checkinBonusHps)
          ? Math.max(0, raw.checkinBonusHps)
          : baseFields.checkinBonusHps,
      streakReset: raw.streakReset === true,
      streakRewardGranted:
        typeof raw.streakRewardGranted === 'number' && Number.isFinite(raw.streakRewardGranted)
          ? Math.max(0, Math.floor(raw.streakRewardGranted))
          : 0,
      streakRewardGrantedItemId:
        typeof raw.streakRewardGrantedItemId === 'string' && raw.streakRewardGrantedItemId.trim()
          ? raw.streakRewardGrantedItemId.trim()
          : null,
      streakRewardGrantedItemName:
        typeof raw.streakRewardGrantedItemName === 'string' && raw.streakRewardGrantedItemName.trim()
          ? raw.streakRewardGrantedItemName.trim()
          : null,
      streakRewardGrantedExpiresAtMs:
        typeof raw.streakRewardGrantedExpiresAtMs === 'number' &&
        Number.isFinite(raw.streakRewardGrantedExpiresAtMs)
          ? Math.floor(raw.streakRewardGrantedExpiresAtMs)
          : null,
      streakRewardGrantedDurationLabel:
        typeof raw.streakRewardGrantedDurationLabel === 'string' &&
        raw.streakRewardGrantedDurationLabel.trim()
          ? raw.streakRewardGrantedDurationLabel.trim()
          : null
    };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}
