/**
 * Public HTTP API for admin user management.
 * Re-exports from admin-legacy so all users-panel imports stay under this folder.
 */
export {
  getUsers,
  toggleUserBlocked,
  updateUser,
  deleteUser,
  bulkDeleteUsers,
  bulkGiftUsers,
  getGameState,
  saveGameStateAdminOverride,
  getAdminUserWalletHistory,
  impersonateUser,
  grantPremiumCheckin,
  stopImpersonate,
  getAdminDormantMiningAccounts,
  getAdminUserActivity,
  updateAdminPermissions,
  getAdminUpgrades,
  createAdminUpgrade,
  deleteAdminUpgrade,
  getLootBoxes,
  setLootBoxes,
  getReferralModels,
  saveReferralModel,
  deleteReferralModel,
  getAccessLevelReferralAssignments,
  saveAccessLevelReferralAssignments,
  getSeasonPasses,
  getMiningCoins,
  type AdminDormantMiningRow,
  type AdminUserWalletHistoryEntry,
  type AdminUserWalletCurrent
} from '../../../../shared/api/admin-legacy';
export { getAdminUserReinvestmentHistory } from '../../../../shared/api/admin-users';
export type { ReinvestmentHistoryEntry } from '../../../../shared/api/wallet';

export { deactivateStreamerRoomByAdminCatalog as deactivateStreamerRoomByAdmin } from './deactivateStreamerRoom';
export { setAdminUserOwnedRooms } from './ownedRooms';
