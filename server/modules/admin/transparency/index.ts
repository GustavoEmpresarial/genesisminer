export {
  registerAdminTransparencyModuleRoutes,
  type AdminTransparencyModuleDeps
} from './controllers/admin-transparency.controller.js';
export {
  createTransparencyEntry,
  deleteTransparencyEntry,
  parseTransparencyEntryId,
  planCreateTransparencyEntry,
  planUpdateTransparencyEntry,
  updateTransparencyEntry
} from './services/admin-transparency.js';
