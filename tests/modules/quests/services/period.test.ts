import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('quests services/period', () => {
  let checkinMock: Record<string, any>;
  let weekMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    checkinMock = {
      brtCheckinPeriodStartMs: vi.fn((ms: number) => ms - 1000),
      brtDayFromMs: vi.fn(() => '2026-01-01'),
      nextCheckinPeriodEndMs: vi.fn((ms: number) => ms + 86400000)
    };
    weekMock = { utcWeekStartMs: vi.fn(() => Date.UTC(2026, 0, 5)) };
    vi.doMock('../../../../server/modules/checkin/services/checkin.js', () => checkinMock);
    vi.doMock('../../../../server/shared/utils/utc-week.js', () => weekMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/checkin/services/checkin.js');
    vi.doUnmock('../../../../server/shared/utils/utc-week.js');
  });

  it('questDailyPeriodKey usa o dia BRT do início do ciclo de check-in', async () => {
    const { questDailyPeriodKey } = await import('../../../../server/modules/quests/services/period.js');
    expect(questDailyPeriodKey(1000)).toBe('d:2026-01-01');
    expect(checkinMock.brtCheckinPeriodStartMs).toHaveBeenCalledWith(1000);
  });

  it('questWeeklyPeriodKey usa a data da segunda UTC', async () => {
    const { questWeeklyPeriodKey } = await import('../../../../server/modules/quests/services/period.js');
    expect(questWeeklyPeriodKey(1000)).toBe('w:2026-01-05');
  });

  it('questPeriodKey escolhe diária ou semanal', async () => {
    const { questPeriodKey } = await import('../../../../server/modules/quests/services/period.js');
    expect(questPeriodKey('daily', 1000)).toBe('d:2026-01-01');
    expect(questPeriodKey('weekly', 1000)).toBe('w:2026-01-05');
  });

  it('questDailyPeriodBounds devolve start/end do ciclo de check-in', async () => {
    const { questDailyPeriodBounds } = await import('../../../../server/modules/quests/services/period.js');
    const bounds = questDailyPeriodBounds(5000);
    expect(bounds).toEqual({ key: 'd:2026-01-01', startMs: 4000, endMs: 4000 + 86400000 });
  });

  it('questWeeklyPeriodBounds devolve start/end de 7 dias', async () => {
    const { questWeeklyPeriodBounds } = await import('../../../../server/modules/quests/services/period.js');
    const bounds = questWeeklyPeriodBounds(5000);
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    expect(bounds).toEqual({ key: 'w:2026-01-05', startMs: Date.UTC(2026, 0, 5), endMs: Date.UTC(2026, 0, 5) + weekMs });
  });
});
