/**
 * Barrel do módulo admin de auditoria de jogador. `registerAdminUserAuditModuleRoutes`
 * é o único export consumido fora deste módulo (por `server/bootstrap/routes.ts`,
 * que registra as 4 rotas — ver controller). `listUserInventoryAudit`/
 * `parseInventoryAuditRange` também são reexportados aqui por serem a API
 * pública mais provável de precisar de reuso externo (ex. relatórios/scripts
 * admin), embora hoje só sejam usados dentro do próprio controller. As demais
 * funções de `services/` (account-trace, activity-event-formatter,
 * player-state-snapshot) são importadas diretamente do respetivo arquivo
 * pelos consumidores internos do módulo — não precisam passar por este barrel.
 */
export { registerAdminUserAuditModuleRoutes, type AdminUserAuditModuleDeps } from './controllers/user-audit.controller.js';
export { listUserInventoryAudit, parseInventoryAuditRange, type InventoryAuditRow } from './services/inventory-audit.js';
