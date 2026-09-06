export const LIVE_BALANCE_TICK_MS = 1000;

const TEN_MIN_MS = 10 * 60 * 1000;

export function lastCompletedTenMinuteUtcGrid(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return 0;
  return Math.floor(nowMs / TEN_MIN_MS) * TEN_MIN_MS;
}

export function estimateLiveCoinBalance(opts: {
  serverBalance: number;
  coinsPerSec: number;
  accrualAnchorMs: number;
  nowMs: number;
}): number {
  const stored = Number.isFinite(opts.serverBalance) ? opts.serverBalance : 0;
  const elapsed = Math.max(0, opts.nowMs - (Number.isFinite(opts.accrualAnchorMs) ? opts.accrualAnchorMs : opts.nowMs));
  const extra = (Number.isFinite(opts.coinsPerSec) ? opts.coinsPerSec : 0) * (elapsed / 1000);
  return stored + extra;
}
