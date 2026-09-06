/**
 * Módulo `quests`: tarefas diárias/semanais (check-in, merge, offerwall),
 * progresso e resgate de recompensa USDC.
 *
 * `bumpQuestProgress` é o hook usado por `modules/checkin` (e, futuramente,
 * `modules/merge`) pra creditar progresso — fecha o TODO deixado em
 * `modules/checkin/controllers/checkin.controller.ts`.
 */
export { registerQuestsModuleRoutes } from './controllers/quests.controller.js';
export type { QuestsModuleDeps } from './controllers/quests.controller.js';

export { DEFAULT_QUEST_DEFINITIONS } from './services/types.js';
export type { QuestActionType, QuestDefinitionRow, QuestPeriod, QuestProgressRow, QuestStateItem } from './services/types.js';
export { questDailyPeriodBounds, questDailyPeriodKey, questPeriodKey, questWeeklyPeriodBounds, questWeeklyPeriodKey } from './services/period.js';
export type { QuestPeriodBounds } from './services/period.js';
export { bumpQuestProgress, claimQuestReward, ensureQuestSchema, getQuestsState, listAllQuestDefinitionsAdmin, saveQuestDefinitionAdmin } from './services/quest.js';
