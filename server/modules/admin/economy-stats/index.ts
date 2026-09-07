export {
  registerAdminEconomyStatsModuleRoutes,
  type AdminEconomyStatsModuleDeps
} from './controllers/economy-stats.controller.js';
export { aggregateEconomyStats, listEconomyStats, rackEffectiveHashrate } from './services/economy-stats.js';
export type { EconomyCoinStatDto } from './services/economy-stats.js';
