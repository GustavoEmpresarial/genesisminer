export {
  registerAdminWithdrawalsModuleRoutes,
  type AdminWithdrawalsModuleDeps
} from './controllers/withdrawals.controller.js';
export {
  listAdminWithdrawals,
  runAdminWithdrawalStatusUpdate,
  updateAdminWithdrawalStatus
} from './services/admin-withdrawals.js';
