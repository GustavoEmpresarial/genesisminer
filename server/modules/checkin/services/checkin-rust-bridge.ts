/**
 * Opt-in Rust bridge for check-in UTC day + 48h grace window.
 */
import {
  genesisCheckinRustEnabled,
  loadGenesisNative
} from '../../../shared/rust/genesis-native.js';

function nativeCheckin() {
  if (!genesisCheckinRustEnabled()) return null;
  return loadGenesisNative();
}

export type CheckinWindowSnapshot = {
  withinWindow: boolean;
  frozen: boolean;
  todayCheckedIn: boolean;
  canCheckinNow: boolean;
  graceMs: number;
  periodStartMs: number;
  today: string;
};

export function rustUtcDayFromMs(ms: number): string | null {
  const n = nativeCheckin();
  const fn = n?.checkinUtcDayFromMs;
  if (!fn) return null;
  try {
    return fn(ms);
  } catch (e) {
    console.warn('[checkin/rust] utcDayFromMs fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustCheckinPeriodStartMs(nowMs: number): number | null {
  const n = nativeCheckin();
  const fn = n?.checkinPeriodStartMs;
  if (!fn) return null;
  try {
    return fn(nowMs);
  } catch (e) {
    console.warn('[checkin/rust] periodStartMs fallback', e instanceof Error ? e.message : e);
    return null;
  }
}

export function rustCheckinWindow(
  lastCheckinAtMs: number | null | undefined,
  nowMs: number
): CheckinWindowSnapshot | null {
  const n = nativeCheckin();
  const fn = n?.checkinWindowJson;
  if (!fn) return null;
  try {
    return JSON.parse(
      fn(lastCheckinAtMs == null ? undefined : Number(lastCheckinAtMs), nowMs)
    ) as CheckinWindowSnapshot;
  } catch (e) {
    console.warn('[checkin/rust] window fallback', e instanceof Error ? e.message : e);
    return null;
  }
}
