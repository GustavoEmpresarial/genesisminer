/**
 * Liga rotas HTTP ao `app` Express.
 *
 * Player HTTP e Socket.IO são de genesis-api. Aqui só sobra admin:
 * `/api/admin/*`, `/api/admin-upgrades*` e os registers admin-only que
 * restaram de módulos antes mistos (rotas de player já retiradas).
 * As abas admin fora do prefixo `/api/admin` são Rust (`admin_tabs.rs`,
 * `admin_catalog.rs`, `admin_wallet_tabs.rs`, `admin_users.rs`).
 */
import type { Express } from 'express';
import pool from '../core/database/pool.js';
import type { AppDeps } from './deps.js';

import { registerAdminBackupModuleRoutes } from '../modules/admin/backup/index.js';
import { registerAdminDashboardModuleRoutes } from '../modules/admin/dashboard/index.js';
import {
  registerAdminCoinEconomyModuleRoutes,
  registerAdminEconomyStatsModuleRoutes
} from '../modules/admin/economy-stats/index.js';
import { registerAdminEtherscanModuleRoutes } from '../modules/admin/etherscan/index.js';
import { registerAdminUsersModuleRoutes } from '../modules/admin/users/index.js';
import { registerDeviceFingerprintAdminModuleRoutes } from '../modules/admin/device-fingerprint/index.js';
import { registerImageAssetModuleRoutes } from '../modules/admin/image-asset/index.js';
import { registerAdminMiningDistributionModuleRoutes } from '../modules/admin/mining-distribution/index.js';
import { registerAdminMiningRuntimeSummaryModuleRoutes } from '../modules/admin/mining-runtime-summary/index.js';
import { registerAdminMonetizationSettingsModuleRoutes } from '../modules/admin/monetization-settings/index.js';
import { registerAdminPromoCodesModuleRoutes } from '../modules/admin/promo-codes/index.js';
import { registerAdminRecallAllModuleRoutes } from '../modules/admin/recall-all/index.js';
import { registerAdminRecallScanModuleRoutes } from '../modules/admin/recall-scan/index.js';
import { registerAdminReferralModuleRoutes } from '../modules/admin/referral/index.js';
import { registerAdminSecurityBulkModuleRoutes } from '../modules/admin/security-bulk/index.js';
import { registerAdminSecurityStatsModuleRoutes } from '../modules/admin/security-stats/index.js';
import { registerAdminSuspiciousEmailsModuleRoutes } from '../modules/admin/suspicious-emails/index.js';
import { registerAdminUserAuditModuleRoutes } from '../modules/admin/user-audit/index.js';
import { registerCheckinModuleRoutes } from '../modules/checkin/index.js';
import { registerDisplayLabelsModuleRoutes } from '../modules/display-labels/index.js';
import { registerGuideModuleRoutes } from '../modules/guide/index.js';
import { registerMergeModuleRoutes } from '../modules/merge/index.js';
import { registerRoadmapModuleRoutes } from '../modules/roadmap/index.js';
import { registerUpgradesModuleRoutes } from '../modules/upgrades/index.js';
import { registerWheelModuleRoutes } from '../modules/wheel/index.js';

/**
 * Registra admin (+ mixed leftover admin tabs). Player HTTP = genesis-api.
 */
export function registerAllRoutes(app: Express, deps: AppDeps): void {
  const { authenticateToken, isAdmin, parseCookies, issueJwtAuthCookies } = deps;

  registerAdminBackupModuleRoutes(app, { isAdmin });
  registerAdminDashboardModuleRoutes(app, { isAdmin });
  registerAdminCoinEconomyModuleRoutes(app, { isAdmin });
  registerAdminEconomyStatsModuleRoutes(app, { isAdmin });
  registerAdminEtherscanModuleRoutes(app, { isAdmin });
  registerAdminUsersModuleRoutes(app, {
    isAdmin,
    authenticateToken,
    pool,
    parseCookies,
    issueJwtAuthCookies
  });
  registerDeviceFingerprintAdminModuleRoutes(app, { isAdmin });
  registerImageAssetModuleRoutes(app, {
    isAdmin: deps.isAdmin,
    imgDir: deps.imgDir,
    uploadsDir: deps.uploadsDir
  });
  registerAdminMiningDistributionModuleRoutes(app, { isAdmin });
  registerAdminMiningRuntimeSummaryModuleRoutes(app, { isAdmin });
  registerAdminMonetizationSettingsModuleRoutes(app, { isAdmin });
  registerAdminPromoCodesModuleRoutes(app, { isAdmin });
  registerAdminRecallAllModuleRoutes(app, { isAdmin });
  registerAdminRecallScanModuleRoutes(app, { isAdmin });
  registerAdminReferralModuleRoutes(app, { isAdmin });
  registerAdminSecurityBulkModuleRoutes(app, { isAdmin });
  registerAdminSecurityStatsModuleRoutes(app, { isAdmin });
  registerAdminSuspiciousEmailsModuleRoutes(app, { isAdmin });
  registerAdminUserAuditModuleRoutes(app, { isAdmin });


  // Admin leftovers from formerly mixed registers (player routes in genesis-api).
  registerCheckinModuleRoutes(app, { isAdmin });
  registerDisplayLabelsModuleRoutes(app, { isAdmin });
  registerGuideModuleRoutes(app, { isAdmin });
  registerMergeModuleRoutes(app, { isAdmin });
  registerRoadmapModuleRoutes(app, { isAdmin });
  registerUpgradesModuleRoutes(app, { isAdmin: deps.isAdmin });
  registerWheelModuleRoutes(app, { isAdmin: deps.isAdmin });
}
