export {
  registerAdminPromoCodesModuleRoutes,
  type AdminPromoCodesModuleDeps
} from './controllers/promo-codes.controller.js';
export {
  bulkDeletePromoCodes,
  deletePromoCode,
  listPromoCodes,
  mapPromoCodeAdminDto,
  planBulkDeleteCodes,
  planCreatePromoCode,
  togglePromoCode,
  upsertPromoCode
} from './services/promo-codes.js';
export type { PromoCodeAdminDto } from './services/promo-codes.js';
