import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MS_PER_DAY } from '../../../../../server/shared/utils/time.js';

const FIXTURE_WED_MS = Date.parse('2026-09-02T15:00:00.000Z');
const FIXTURE_SUN_MS = Date.parse('2026-09-06T12:00:00.000Z');
/** Espelha `WAU_ROLLING_DAYS` / `MAU_ROLLING_DAYS` do serviço (cutoffs no mock). */
const WAU_ROLLING_DAYS_EXPECTED = 7;
const MAU_ROLLING_DAYS_EXPECTED = 30;

describe('site-metrics calendar UTC', () => {
  it('utcCalendarDayStartMs / week / month — quarta 2026-09-02', async () => {
    const {
      utcCalendarDayStartMs,
      utcMondayWeekStartMs,
      utcMonthStartMs
    } = await import('../../../../../server/modules/admin/dashboard/services/site-metrics.js');

    expect(utcCalendarDayStartMs(FIXTURE_WED_MS)).toBe(Date.parse('2026-09-02T00:00:00.000Z'));
    expect(utcMondayWeekStartMs(FIXTURE_WED_MS)).toBe(Date.parse('2026-08-31T00:00:00.000Z'));
    expect(utcMonthStartMs(FIXTURE_WED_MS)).toBe(Date.parse('2026-09-01T00:00:00.000Z'));
  });

  it('domingo → segunda anterior da mesma semana ISO', async () => {
    const { utcMondayWeekStartMs } = await import(
      '../../../../../server/modules/admin/dashboard/services/site-metrics.js'
    );
    expect(utcMondayWeekStartMs(FIXTURE_SUN_MS)).toBe(Date.parse('2026-08-31T00:00:00.000Z'));
  });
});

describe('computeAdminSiteMetrics', () => {
  let dbMock: { default: { query: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    vi.resetModules();
    dbMock = {
      default: {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('FROM placed_racks')) {
            return { rows: [{ count: '3' }] };
          }
          if (sql.includes('polygon_wallet')) {
            return { rows: [{ count: '7' }] };
          }
          if (sql.includes('is_admin <> 0')) {
            return { rows: [{ count: '2' }] };
          }
          if (sql.includes('FROM users') && !sql.includes('JOIN') && !sql.includes('WHERE')) {
            return { rows: [{ count: '100' }] };
          }
          if (sql.includes('COALESCE(u.is_blocked, 0) <> 0')) {
            return { rows: [{ count: '5' }] };
          }
          if (sql.includes('COUNT(*) AS count FROM users u WHERE') && sql.includes('is_blocked, 0) = 0')) {
            return { rows: [{ count: '90' }] };
          }
          if (sql.includes('expires_at')) {
            return { rows: [{ count: '4' }] };
          }
          if (sql.includes('COUNT(DISTINCT s.user_id)') && sql.includes('>= $1') && !sql.includes('to_char')) {
            const cutoff = Number(params?.[0]);
            if (cutoff === FIXTURE_WED_MS - MS_PER_DAY) return { rows: [{ count: '11' }] };
            if (cutoff === FIXTURE_WED_MS - WAU_ROLLING_DAYS_EXPECTED * MS_PER_DAY) {
              return { rows: [{ count: '22' }] };
            }
            if (cutoff === FIXTURE_WED_MS - MAU_ROLLING_DAYS_EXPECTED * MS_PER_DAY) {
              return { rows: [{ count: '33' }] };
            }
            return { rows: [{ count: '0' }] };
          }
          if (sql.includes('game_states') && sql.includes('COUNT(*) AS count') && !sql.includes('to_char')) {
            const start = Number(params?.[0]);
            if (start === Date.parse('2026-09-02T00:00:00.000Z')) return { rows: [{ count: '1' }] };
            if (start === Date.parse('2026-08-31T00:00:00.000Z')) return { rows: [{ count: '8' }] };
            if (start === Date.parse('2026-09-01T00:00:00.000Z')) return { rows: [{ count: '9' }] };
            return { rows: [{ count: '0' }] };
          }
          if (sql.includes('to_char') && sql.includes('game_states')) {
            return {
              rows: [
                { day: '2026-08-20', cnt: 2 },
                { day: '2026-09-02', cnt: 1 }
              ]
            };
          }
          if (sql.includes('to_char') && sql.includes('sessions')) {
            return {
              rows: [
                { day: '2026-08-20', cnt: 5 },
                { day: '2026-09-01', cnt: 10 }
              ]
            };
          }
          return { rows: [{ count: '0' }] };
        })
      }
    };
    vi.doMock('../../../../../server/core/database/pool.js', () => dbMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/pool.js');
  });

  it('payload + série 14 dias com buraco a 0; janelas DAU/WAU/MAU usam MS_PER_*', async () => {
    const {
      computeAdminSiteMetrics,
      SITE_METRICS_SERIES_DAYS,
      WAU_ROLLING_DAYS,
      MAU_ROLLING_DAYS
    } = await import('../../../../../server/modules/admin/dashboard/services/site-metrics.js');

    expect(SITE_METRICS_SERIES_DAYS).toBe(14);
    expect(WAU_ROLLING_DAYS).toBe(WAU_ROLLING_DAYS_EXPECTED);
    expect(MAU_ROLLING_DAYS).toBe(MAU_ROLLING_DAYS_EXPECTED);

    const payload = await computeAdminSiteMetrics(FIXTURE_WED_MS);

    expect(payload.generatedAtMs).toBe(FIXTURE_WED_MS);
    expect(payload.registeredUsers).toBe(90);
    expect(payload.deactivatedUsers).toBe(5);
    expect(payload.onlineUsers).toBe(4);
    expect(payload.dau).toBe(11);
    expect(payload.wau).toBe(22);
    expect(payload.mau).toBe(33);
    expect(payload.signupsToday).toBe(1);
    expect(payload.signupsThisWeek).toBe(8);
    expect(payload.signupsThisMonth).toBe(9);
    expect(payload.totalAccounts).toBe(100);
    expect(payload.adminAccounts).toBe(2);
    expect(payload.usersWithWallet).toBe(7);
    expect(payload.usersMiningNow).toBe(3);

    expect(payload.dailySeries).toHaveLength(SITE_METRICS_SERIES_DAYS);
    expect(payload.dailySeries[0]?.date).toBe('2026-08-20');
    expect(payload.dailySeries[SITE_METRICS_SERIES_DAYS - 1]?.date).toBe('2026-09-02');
    expect(payload.dailySeries[0]).toEqual({ date: '2026-08-20', signups: 2, activeUsers: 5 });
    const hole = payload.dailySeries.find((r) => r.date === '2026-08-21');
    expect(hole).toEqual({ date: '2026-08-21', signups: 0, activeUsers: 0 });
    expect(payload.dailySeries.find((r) => r.date === '2026-09-01')).toEqual({
      date: '2026-09-01',
      signups: 0,
      activeUsers: 10
    });
    expect(payload.dailySeries.find((r) => r.date === '2026-09-02')).toEqual({
      date: '2026-09-02',
      signups: 1,
      activeUsers: 0
    });

    const dauCall = dbMock.default.query.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        c[0].includes('COUNT(DISTINCT s.user_id)') &&
        Array.isArray(c[1]) &&
        c[1][0] === FIXTURE_WED_MS - MS_PER_DAY
    );
    expect(dauCall).toBeTruthy();
    const wauCall = dbMock.default.query.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        Array.isArray(c[1]) &&
        c[1][0] === FIXTURE_WED_MS - WAU_ROLLING_DAYS * MS_PER_DAY
    );
    expect(wauCall).toBeTruthy();
    const mauCall = dbMock.default.query.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        Array.isArray(c[1]) &&
        c[1][0] === FIXTURE_WED_MS - MAU_ROLLING_DAYS * MS_PER_DAY
    );
    expect(mauCall).toBeTruthy();
  });
});
