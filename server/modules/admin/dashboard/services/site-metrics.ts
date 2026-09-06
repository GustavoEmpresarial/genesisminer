/**
 * Snapshot de métricas do site (Admin → Métricas).
 * Sem cache — gerado sob pedido; calendário UTC alinhado ao copy da UI.
 */
import db from '../../../../core/database/pool.js';
import { MS_PER_DAY } from '../../../../shared/utils/time.js';
import { DAYS_PER_WEEK, utcWeekStartMs } from '../../../../shared/utils/utc-week.js';
import { ADMIN_DASHBOARD_ONLINE_STALE_MS } from './dashboard-stats.js';

/** Comprimento de `YYYY-MM-DD` em ISO (`Date#toISOString().slice`). */
const ISO_YMD_LENGTH = 'YYYY-MM-DD'.length;

/**
 * Dias na série diária da UI («Últimos 14 dias (UTC)» em AdminMetrics).
 */
export const SITE_METRICS_SERIES_DAYS = 14;

/** Rolling WAU: 7 dias (ISO week length). */
export const WAU_ROLLING_DAYS = 7;

/** Rolling MAU: copy UI «últimos 30 dias». */
export const MAU_ROLLING_DAYS = 30;

/** Dias por semana ISO (segunda→domingo). Alias de {@link DAYS_PER_WEEK}. */
export const DAYS_PER_ISO_WEEK = DAYS_PER_WEEK;

export type DailyMetricRow = {
  date: string;
  signups: number;
  activeUsers: number;
};

export type AdminSiteMetricsPayload = {
  generatedAtMs: number;
  registeredUsers: number;
  deactivatedUsers: number;
  onlineUsers: number;
  dau: number;
  wau: number;
  mau: number;
  signupsToday: number;
  signupsThisWeek: number;
  signupsThisMonth: number;
  totalAccounts: number;
  adminAccounts: number;
  usersWithWallet: number;
  usersMiningNow: number;
  dailySeries: DailyMetricRow[];
};

/** Início do dia civil UTC (00:00:00.000Z) que contém `nowMs`. */
export function utcCalendarDayStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

/**
 * Segunda 00:00 UTC da semana ISO que contém `nowMs`.
 * Domingo → segunda anterior (usa {@link DAYS_PER_ISO_WEEK} via utc-week).
 */
export function utcMondayWeekStartMs(nowMs: number): number {
  return utcWeekStartMs(nowMs);
}

/** Dia 1 do mês UTC, 00:00:00.000Z. */
export function utcMonthStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}

function utcYmdFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, ISO_YMD_LENGTH);
}

function parseCount(row: { count?: unknown } | undefined): number {
  return parseInt(String(row?.count ?? 0), 10) || 0;
}

const REGISTERED_USER_SQL = `u.is_admin = 0 AND COALESCE(u.is_blocked, 0) = 0`;
const ACTIVITY_MS_SQL = `COALESCE(NULLIF(s.last_seen_at, 0), s.created_at)`;

type DayCountRow = { day: string; cnt: unknown };

function mergeDailySeries(
  seriesStartMs: number,
  signupRows: DayCountRow[],
  activeRows: DayCountRow[]
): DailyMetricRow[] {
  const signupsByDay = new Map<string, number>();
  for (const r of signupRows) {
    signupsByDay.set(String(r.day), parseInt(String(r.cnt ?? 0), 10) || 0);
  }
  const activeByDay = new Map<string, number>();
  for (const r of activeRows) {
    activeByDay.set(String(r.day), parseInt(String(r.cnt ?? 0), 10) || 0);
  }

  const out: DailyMetricRow[] = [];
  for (let i = 0; i < SITE_METRICS_SERIES_DAYS; i += 1) {
    const dayMs = seriesStartMs + i * MS_PER_DAY;
    const date = utcYmdFromMs(dayMs);
    out.push({
      date,
      signups: signupsByDay.get(date) ?? 0,
      activeUsers: activeByDay.get(date) ?? 0
    });
  }
  return out;
}

export async function computeAdminSiteMetrics(
  nowMs: number = Date.now()
): Promise<AdminSiteMetricsPayload> {
  const todayStart = utcCalendarDayStartMs(nowMs);
  const weekStart = utcMondayWeekStartMs(nowMs);
  const monthStart = utcMonthStartMs(nowMs);
  const seriesStart = todayStart - (SITE_METRICS_SERIES_DAYS - 1) * MS_PER_DAY;
  const seriesEndExclusive = todayStart + MS_PER_DAY;
  const onlineCutoff = nowMs - ADMIN_DASHBOARD_ONLINE_STALE_MS;
  const dauCutoff = nowMs - MS_PER_DAY;
  const wauCutoff = nowMs - WAU_ROLLING_DAYS * MS_PER_DAY;
  const mauCutoff = nowMs - MAU_ROLLING_DAYS * MS_PER_DAY;

  const [
    registeredRes,
    deactivatedRes,
    onlineRes,
    dauRes,
    wauRes,
    mauRes,
    signupsTodayRes,
    signupsWeekRes,
    signupsMonthRes,
    totalAccountsRes,
    adminAccountsRes,
    walletRes,
    miningNowRes,
    signupSeriesRes,
    activeSeriesRes
  ] = await Promise.all([
    db.query(`SELECT COUNT(*) AS count FROM users u WHERE ${REGISTERED_USER_SQL}`),
    db.query(
      `SELECT COUNT(*) AS count FROM users u WHERE u.is_admin = 0 AND COALESCE(u.is_blocked, 0) <> 0`
    ),
    db.query(
      `
      SELECT COUNT(DISTINCT s.user_id) AS count
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE u.is_admin = 0
        AND s.expires_at > $1
        AND ${ACTIVITY_MS_SQL} > $2
    `,
      [nowMs, onlineCutoff]
    ),
    db.query(
      `
      SELECT COUNT(DISTINCT s.user_id) AS count
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE ${REGISTERED_USER_SQL}
        AND ${ACTIVITY_MS_SQL} >= $1
    `,
      [dauCutoff]
    ),
    db.query(
      `
      SELECT COUNT(DISTINCT s.user_id) AS count
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE ${REGISTERED_USER_SQL}
        AND ${ACTIVITY_MS_SQL} >= $1
    `,
      [wauCutoff]
    ),
    db.query(
      `
      SELECT COUNT(DISTINCT s.user_id) AS count
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE ${REGISTERED_USER_SQL}
        AND ${ACTIVITY_MS_SQL} >= $1
    `,
      [mauCutoff]
    ),
    db.query(
      `
      SELECT COUNT(*) AS count
      FROM game_states gs
      JOIN users u ON u.id = gs.user_id
      WHERE u.is_admin = 0
        AND gs.start_time >= $1
    `,
      [todayStart]
    ),
    db.query(
      `
      SELECT COUNT(*) AS count
      FROM game_states gs
      JOIN users u ON u.id = gs.user_id
      WHERE u.is_admin = 0
        AND gs.start_time >= $1
    `,
      [weekStart]
    ),
    db.query(
      `
      SELECT COUNT(*) AS count
      FROM game_states gs
      JOIN users u ON u.id = gs.user_id
      WHERE u.is_admin = 0
        AND gs.start_time >= $1
    `,
      [monthStart]
    ),
    db.query(`SELECT COUNT(*) AS count FROM users`),
    db.query(`SELECT COUNT(*) AS count FROM users WHERE is_admin <> 0`),
    db.query(
      `
      SELECT COUNT(*) AS count
      FROM users u
      WHERE ${REGISTERED_USER_SQL}
        AND u.polygon_wallet IS NOT NULL
        AND BTRIM(u.polygon_wallet) <> ''
    `
    ),
    db.query(
      `
      SELECT COUNT(DISTINCT pr.user_id) AS count
      FROM placed_racks pr
      JOIN users u ON u.id = pr.user_id
      WHERE pr.is_on = 1
        AND ${REGISTERED_USER_SQL}
    `
    ),
    db.query(
      `
      SELECT to_char((to_timestamp(gs.start_time / 1000.0) AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS cnt
      FROM game_states gs
      JOIN users u ON u.id = gs.user_id
      WHERE u.is_admin = 0
        AND gs.start_time >= $1
        AND gs.start_time < $2
      GROUP BY day
      ORDER BY day
    `,
      [seriesStart, seriesEndExclusive]
    ),
    db.query(
      `
      SELECT to_char((to_timestamp(${ACTIVITY_MS_SQL} / 1000.0) AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             COUNT(DISTINCT s.user_id)::int AS cnt
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE ${REGISTERED_USER_SQL}
        AND ${ACTIVITY_MS_SQL} >= $1
        AND ${ACTIVITY_MS_SQL} < $2
      GROUP BY day
      ORDER BY day
    `,
      [seriesStart, seriesEndExclusive]
    )
  ]);

  return {
    generatedAtMs: nowMs,
    registeredUsers: parseCount(registeredRes.rows[0]),
    deactivatedUsers: parseCount(deactivatedRes.rows[0]),
    onlineUsers: parseCount(onlineRes.rows[0]),
    dau: parseCount(dauRes.rows[0]),
    wau: parseCount(wauRes.rows[0]),
    mau: parseCount(mauRes.rows[0]),
    signupsToday: parseCount(signupsTodayRes.rows[0]),
    signupsThisWeek: parseCount(signupsWeekRes.rows[0]),
    signupsThisMonth: parseCount(signupsMonthRes.rows[0]),
    totalAccounts: parseCount(totalAccountsRes.rows[0]),
    adminAccounts: parseCount(adminAccountsRes.rows[0]),
    usersWithWallet: parseCount(walletRes.rows[0]),
    usersMiningNow: parseCount(miningNowRes.rows[0]),
    dailySeries: mergeDailySeries(
      seriesStart,
      signupSeriesRes.rows as DayCountRow[],
      activeSeriesRes.rows as DayCountRow[]
    )
  };
}
