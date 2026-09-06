import { describe, expect, it } from 'vitest';
import {
  TEN_MIN_MS,
  lastCompletedTenMinuteUtcGrid,
  listCreditHistoryWindows,
  listPendingTenMinuteBoundaries,
  utcMidnightMs
} from '../../../../server/modules/mining-engine/services/wall-clock-grid.js';

describe('wall-clock-grid — listPendingTenMinuteBoundaries', () => {
  const day0 = utcMidnightMs(Date.UTC(2026, 7, 20, 12, 0, 0)); // 2026-08-20 UTC
  const t2210 = day0 + 22 * 60 * 60 * 1000 + 10 * 60 * 1000;
  const t2220 = t2210 + TEN_MIN_MS;
  const t2230 = t2220 + TEN_MIN_MS;
  const t2240 = t2230 + TEN_MIN_MS;
  const t2250 = t2240 + TEN_MIN_MS;

  it('TESTE 1 normal: checkpoint 22:20, cap 22:30 → só 22:30', () => {
    expect(listPendingTenMinuteBoundaries(t2220, t2230 + 5_000)).toEqual([t2230]);
  });

  it('TESTE 2 catch-up: checkpoint 22:20, cap 22:50 → 22:30, 22:40, 22:50', () => {
    expect(listPendingTenMinuteBoundaries(t2220, t2250 + 3 * 60_000)).toEqual([t2230, t2240, t2250]);
  });

  it('TESTE 3 não é só o último', () => {
    const pending = listPendingTenMinuteBoundaries(t2220, t2250 + 1);
    expect(pending).not.toEqual([t2250]);
    expect(pending.length).toBe(3);
  });

  it('TESTE 4 idempotência: checkpoint == cap → vazio', () => {
    expect(listPendingTenMinuteBoundaries(t2250, t2250)).toEqual([]);
    expect(listPendingTenMinuteBoundaries(t2250, t2250 + 60_000)).toEqual([]);
  });

  it('TESTE 7 boundary exacto 22:30:00 → cap 22:30; não inclui 22:40', () => {
    expect(lastCompletedTenMinuteUtcGrid(t2230)).toBe(t2230);
    expect(listPendingTenMinuteBoundaries(t2220, t2230)).toEqual([t2230]);
    expect(listPendingTenMinuteBoundaries(t2230, t2230)).toEqual([]);
  });

  it('TESTE 8 primeiro boot (checkpoint 0) → só cap actual, sem reconstruir epoch', () => {
    expect(listPendingTenMinuteBoundaries(0, t2250 + 1)).toEqual([t2250]);
    expect(listPendingTenMinuteBoundaries(-1, t2250 + 1)).toEqual([t2250]);
  });
});

describe('wall-clock-grid — listCreditHistoryWindows', () => {
  const day0 = utcMidnightMs(Date.UTC(2026, 7, 20, 12, 0, 0));
  const t2220 = day0 + 22 * 60 * 60 * 1000 + 20 * 60 * 1000;
  const t2230 = t2220 + TEN_MIN_MS;
  const t2240 = t2230 + TEN_MIN_MS;
  const t2250 = t2240 + TEN_MIN_MS;

  it('22:20→22:30 → uma janela completa', () => {
    expect(listCreditHistoryWindows(t2220, t2230)).toEqual([{ startMs: t2220, endMs: t2230 }]);
  });

  it('22:20→22:50 → três janelas canónicas', () => {
    expect(listCreditHistoryWindows(t2220, t2250)).toEqual([
      { startMs: t2220, endMs: t2230 },
      { startMs: t2230, endMs: t2240 },
      { startMs: t2240, endMs: t2250 }
    ]);
  });

  it('parcial off-grid: 22:25→22:50 preserva primeiro segmento curto', () => {
    const t2225 = t2220 + 5 * 60_000;
    expect(listCreditHistoryWindows(t2225, t2250)).toEqual([
      { startMs: t2225, endMs: t2230 },
      { startMs: t2230, endMs: t2240 },
      { startMs: t2240, endMs: t2250 }
    ]);
  });
});
