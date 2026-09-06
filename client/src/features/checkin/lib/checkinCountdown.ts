/**
 * Countdown helpers for the daily / premium check-in banner.
 */
import type { CheckinStatusPayload } from '../api/checkin';

export function formatCheckinCountdown(nextResetMs: number): string {
  const left = Math.max(0, nextResetMs - Date.now());
  const d = Math.floor(left / 86400000);
  const h = Math.floor((left % 86400000) / 3600000);
  const m = Math.floor((left % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h <= 0) {
    if (m <= 0) return '<1m';
    return `${m}m`;
  }
  return `${h}h ${m}m`;
}

export function isCheckinButtonDisabled(status: CheckinStatusPayload | null): boolean {
  if (!status) return true;
  if (status.premiumWeeklyCheckin) return !status.canCheckinNow;
  return !status.canCheckinNow;
}
