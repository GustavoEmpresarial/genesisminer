/**
 * Tipos do `GET /api/dashboard/state`.
 * Canonical copy lives in `features/dashboard/lib/types` — this file is a compatibility re-export
 * for admin imports that historically used `features/admin/lib/dashboardTypes`.
 */
export type {
  DashboardMinerStatus,
  DashboardMinerState,
  DashboardTokenBalance,
  DashboardWalletState,
  DashboardEcosystemModuleStatus,
  DashboardEcosystemModule,
  DashboardNotificationType,
  DashboardNotification,
  DashboardEvent,
  DashboardRankingEntry,
  DashboardRanking,
  DashboardQuickAccessItem,
  DashboardState,
  DashboardStateResult
} from '../../dashboard/lib/types';
