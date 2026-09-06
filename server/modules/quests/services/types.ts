/**
 * Tipos e defaults das tarefas diárias / semanais.
 *
 * Migrado de legacy/backend/modules/quests/quest.types.ts (verbatim).
 */
export type QuestPeriod = 'daily' | 'weekly';
export type QuestActionType = 'checkin' | 'merge' | 'offerwall';

export type QuestDefinitionRow = {
  id: string;
  period: QuestPeriod;
  action_type: QuestActionType;
  title: string;
  description: string;
  target_count: number;
  reward_usdc: number;
  sort_order: number;
  enabled: number;
  updated_at: number;
};

export type QuestProgressRow = {
  user_id: number;
  quest_id: string;
  period_key: string;
  progress: number;
  completed_at: number | null;
  claimed_at: number | null;
  updated_at: number;
};

export type QuestStateItem = {
  id: string;
  period: QuestPeriod;
  actionType: QuestActionType;
  title: string;
  description: string;
  targetCount: number;
  rewardUsdc: number;
  sortOrder: number;
  periodKey: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
  canClaim: boolean;
};

/** Catálogo inicial (estilo MinerCore): check-in, merge, offerwall. */
export const DEFAULT_QUEST_DEFINITIONS: Omit<QuestDefinitionRow, 'updated_at'>[] = [
  {
    id: 'daily_checkin',
    period: 'daily',
    action_type: 'checkin',
    title: 'Check-in diário',
    description: 'Faz o check-in do dia (ciclo 00:00 UTC). Com passe premium, conta automaticamente em cada dia da janela activa.',
    target_count: 1,
    reward_usdc: 0.05,
    sort_order: 10,
    enabled: 1
  },
  {
    id: 'daily_merge',
    period: 'daily',
    action_type: 'merge',
    title: 'Forge 1 merge',
    description: 'Completa 1 merge na Merge Station.',
    target_count: 1,
    reward_usdc: 0.1,
    sort_order: 20,
    enabled: 1
  },
  {
    id: 'daily_offerwall',
    period: 'daily',
    action_type: 'offerwall',
    title: 'Offerwall do dia',
    description: 'Recebe 1 crédito do Offerwall (ZERads).',
    target_count: 1,
    reward_usdc: 0.15,
    sort_order: 30,
    enabled: 1
  },
  {
    id: 'weekly_checkin',
    period: 'weekly',
    action_type: 'checkin',
    title: 'Check-in da semana',
    description: 'Faz check-in em 5 dias diferentes nesta semana. Com passe premium, cada dia da janela activa conta 1.',
    target_count: 5,
    reward_usdc: 0.5,
    sort_order: 110,
    enabled: 1
  },
  {
    id: 'weekly_merge',
    period: 'weekly',
    action_type: 'merge',
    title: 'Forge da semana',
    description: 'Completa 10 merges na Merge Station.',
    target_count: 10,
    reward_usdc: 1,
    sort_order: 120,
    enabled: 1
  },
  {
    id: 'weekly_offerwall',
    period: 'weekly',
    action_type: 'offerwall',
    title: 'Offerwall da semana',
    description: 'Recebe 5 créditos do Offerwall nesta semana.',
    target_count: 5,
    reward_usdc: 1,
    sort_order: 130,
    enabled: 1
  }
];
