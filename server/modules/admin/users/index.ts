export {
  registerAdminUsersModuleRoutes,
  type AdminUsersModuleDeps
} from './controllers/users.controller.js';
// list / update / delete of `/api/users`, `PUT /api/user`, `DELETE /api/user/:email`
// are served by genesis-api → mining-worker `/v1/users/admin-*`; the Node services
// were reference-only and have been removed.
export {
  loadAdminUserWalletHistory,
  parseAdminWalletHistoryUserId,
  type AdminUserWalletHistoryPayload
} from './services/wallet-history.js';
export {
  startAdminImpersonate,
  stopAdminImpersonate,
  type StartAdminImpersonateInput,
  type StopAdminImpersonateInput
} from './services/impersonate.js';
export {
  loadAdminGameStateByEmail,
  loadAdminGameStateByUserId,
  applyAdminSaveGameOverride,
  normalizeAdminStockSnapshot,
  type AdminGameStateDto,
  type ApplyAdminSaveGameOverrideInput,
  type ApplyAdminSaveGameOverrideResult
} from './services/admin-game-state.js';
