/**
 * Módulo `upgrades`: pacotes admin (compra com USDC, entregues como loot box
 * em "Caixas da Sorte") + CRUD admin (`POST/DELETE /api/admin-upgrades`).
 *
 * ⚠️ Corrige um achado de segurança já documentado antes deste módulo migrar
 * (docs/architecture/DECISIONS.md #8): a compra não confería
 * `admin_upgrade_visibility` (pacotes exclusivos por nível). Agora confere
 * no worker `POST /v1/upgrades/purchase` antes de debitar.
 */
export { registerUpgradesModuleRoutes } from './controllers/upgrades.controller.js';
export type { UpgradesModuleDeps } from './controllers/upgrades.controller.js';

export { deleteAdminUpgrade, upsertAdminUpgrade } from './services/admin-crud.js';
export type { AdminUpgradeUpsertInput } from './services/admin-crud.js';

export { computeDiscountPercent, parseUpgradePackageId, usdcDecimalFromRow } from './services/catalog.js';
export { resolveUserAccessLevelIds } from './services/access-levels.js';
export { loadAdminUpgradesForUser } from './services/admin-upgrades-loader.js';
export type { AdminUpgradePackRow } from './services/admin-upgrades-loader.js';
export { materializeUpgradePackageAsLootBoxInTx, UPGRADE_PACKAGE_BOX_TRIGGER } from './services/grant.js';
export { buildUpgradesStatePayload } from './services/state.js';
export { runUpgradePackagePurchase, upgradePurchaseRequestFingerprint } from './services/purchase.js';
export type { UpgradePurchaseOk } from './services/purchase.js';
