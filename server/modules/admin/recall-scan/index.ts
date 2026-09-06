export {
  registerAdminRecallScanModuleRoutes,
  type AdminRecallScanModuleDeps
} from './controllers/recall-scan.controller.js';
export { computeRecallItemCount, scanRecallInstalledItems } from './services/recall-scan.js';
export type { RecallScanDto } from './services/recall-scan.js';
