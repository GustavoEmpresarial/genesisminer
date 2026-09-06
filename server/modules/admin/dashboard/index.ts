export {
  registerAdminDashboardModuleRoutes,
  type AdminDashboardModuleDeps
} from './controllers/dashboard.controller.js';
export {
  ADMIN_DASHBOARD_ONLINE_STALE_MS,
  computeAdminDashboardStatsUncached,
  getAdminDashboardStatsCached,
  invalidateAdminDashboardStatsCache,
  type AdminDashboardStatsPayload
} from './services/dashboard-stats.js';
export {
  computeAdminSiteMetrics,
  DAYS_PER_ISO_WEEK,
  MAU_ROLLING_DAYS,
  SITE_METRICS_SERIES_DAYS,
  utcCalendarDayStartMs,
  utcMondayWeekStartMs,
  utcMonthStartMs,
  WAU_ROLLING_DAYS,
  type AdminSiteMetricsPayload,
  type DailyMetricRow
} from './services/site-metrics.js';
