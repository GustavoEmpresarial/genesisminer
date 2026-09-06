/**
 * Política de recompensa do check-in: tipo (hashrate/battery/item), quantidade
 * diária/premium, e prémio de sequência de 7 dias.
 *
 * Migrado de legacy/backend/modules/checkin/checkinRewardPolicy.ts.
 */
import { getSettingsRecord, upsertSettingsEntries } from '../../../shared/settings/settings-repository.js';
import { normalizeAsicDurationConfig, normalizeAsicDurationUnit, type AsicDurationUnit } from '../../../shared/utils/lease-duration.js';

export const CHECKIN_REWARD_SETTINGS_KEYS = [
  'checkin_reward_type',
  'checkin_daily_reward_amount',
  'checkin_weekly_reward_amount',
  'checkin_reward_item_id',
  'checkin_streak_reward_enabled',
  'checkin_streak_reward_item_id',
  'checkin_streak_reward_duration_amount',
  'checkin_streak_reward_duration_unit'
] as const;

/** Tipo de recompensa do check-in — extensível no painel admin. */
export type CheckinRewardType = 'hashrate' | 'battery' | 'item';

export type CheckinRewardPolicy = {
  rewardType: CheckinRewardType;
  /** Quantidade por check-in diário (ex.: 1 H/s). */
  dailyRewardAmount: number;
  /** Quantidade por check-in premium semanal (ex.: 7 H/s). */
  weeklyRewardAmount: number;
  /** Id de `upgrades` quando `rewardType` é `battery` ou `item`. */
  rewardItemId: string;
  /** Prémio ao completar N dias seguidos (7) — item temporário no stock. */
  streakRewardEnabled: boolean;
  streakRewardItemId: string;
  streakRewardDurationAmount: number;
  streakRewardDurationUnit: AsicDurationUnit;
};

export const DEFAULT_CHECKIN_REWARD_TYPE: CheckinRewardType = 'hashrate';
export const DEFAULT_CHECKIN_DAILY_REWARD_AMOUNT = 1;
export const DEFAULT_CHECKIN_WEEKLY_REWARD_AMOUNT = 7;
export const DEFAULT_CHECKIN_REWARD_ITEM_ID = 'battery_estelar';
export const DEFAULT_CHECKIN_STREAK_REWARD_ENABLED = false;
export const DEFAULT_CHECKIN_STREAK_REWARD_ITEM_ID = '';
export const DEFAULT_CHECKIN_STREAK_REWARD_DURATION_AMOUNT = 7;
export const DEFAULT_CHECKIN_STREAK_REWARD_DURATION_UNIT: AsicDurationUnit = 'day';

function parseRewardType(raw: unknown): CheckinRewardType {
  const t = String(raw ?? DEFAULT_CHECKIN_REWARD_TYPE).trim().toLowerCase();
  if (t === 'battery' || t === 'item' || t === 'hashrate') return t;
  return DEFAULT_CHECKIN_REWARD_TYPE;
}

function parsePositiveAmount(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function parseBool(raw: unknown, fallback: boolean): boolean {
  if (raw === true || raw === 1 || raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === false || raw === 0 || raw === '0' || raw === 'false' || raw === 'no') return false;
  return fallback;
}

export function checkinRewardUnitLabel(rewardType: CheckinRewardType): string {
  if (rewardType === 'hashrate') return 'H/s';
  if (rewardType === 'battery') return 'bateria';
  return 'item';
}

export function streakRewardDurationConfig(policy: CheckinRewardPolicy) {
  return normalizeAsicDurationConfig({ amount: policy.streakRewardDurationAmount, unit: policy.streakRewardDurationUnit });
}

export async function loadCheckinRewardPolicy(): Promise<CheckinRewardPolicy> {
  const s = await getSettingsRecord([...CHECKIN_REWARD_SETTINGS_KEYS]);
  const rewardType = parseRewardType(s.checkin_reward_type);
  const dailyRewardAmount = parsePositiveAmount(s.checkin_daily_reward_amount, DEFAULT_CHECKIN_DAILY_REWARD_AMOUNT);
  const weeklyRewardAmount = parsePositiveAmount(s.checkin_weekly_reward_amount, DEFAULT_CHECKIN_WEEKLY_REWARD_AMOUNT);
  const rewardItemId = String(s.checkin_reward_item_id ?? DEFAULT_CHECKIN_REWARD_ITEM_ID).trim() || DEFAULT_CHECKIN_REWARD_ITEM_ID;
  const streakRewardEnabled = parseBool(s.checkin_streak_reward_enabled, DEFAULT_CHECKIN_STREAK_REWARD_ENABLED);
  const streakRewardItemId = String(s.checkin_streak_reward_item_id ?? '').trim();
  const streakRewardDurationAmount = parsePositiveInt(s.checkin_streak_reward_duration_amount, DEFAULT_CHECKIN_STREAK_REWARD_DURATION_AMOUNT);
  const streakRewardDurationUnit = normalizeAsicDurationUnit(s.checkin_streak_reward_duration_unit) || DEFAULT_CHECKIN_STREAK_REWARD_DURATION_UNIT;
  return {
    rewardType,
    dailyRewardAmount,
    weeklyRewardAmount,
    rewardItemId,
    streakRewardEnabled,
    streakRewardItemId,
    streakRewardDurationAmount,
    streakRewardDurationUnit
  };
}

export async function saveCheckinRewardPolicy(input: Partial<CheckinRewardPolicy>): Promise<CheckinRewardPolicy> {
  const current = await loadCheckinRewardPolicy();
  const next: CheckinRewardPolicy = {
    rewardType: input.rewardType !== undefined ? parseRewardType(input.rewardType) : current.rewardType,
    dailyRewardAmount:
      input.dailyRewardAmount !== undefined ? parsePositiveAmount(input.dailyRewardAmount, current.dailyRewardAmount) : current.dailyRewardAmount,
    weeklyRewardAmount:
      input.weeklyRewardAmount !== undefined ? parsePositiveAmount(input.weeklyRewardAmount, current.weeklyRewardAmount) : current.weeklyRewardAmount,
    rewardItemId:
      input.rewardItemId !== undefined && String(input.rewardItemId).trim() ? String(input.rewardItemId).trim() : current.rewardItemId,
    streakRewardEnabled:
      input.streakRewardEnabled !== undefined ? parseBool(input.streakRewardEnabled, current.streakRewardEnabled) : current.streakRewardEnabled,
    streakRewardItemId: input.streakRewardItemId !== undefined ? String(input.streakRewardItemId ?? '').trim() : current.streakRewardItemId,
    streakRewardDurationAmount:
      input.streakRewardDurationAmount !== undefined
        ? parsePositiveInt(input.streakRewardDurationAmount, current.streakRewardDurationAmount)
        : current.streakRewardDurationAmount,
    streakRewardDurationUnit:
      input.streakRewardDurationUnit !== undefined
        ? normalizeAsicDurationUnit(input.streakRewardDurationUnit) || current.streakRewardDurationUnit
        : current.streakRewardDurationUnit
  };
  await upsertSettingsEntries([
    { key: 'checkin_reward_type', value: next.rewardType },
    { key: 'checkin_daily_reward_amount', value: String(next.dailyRewardAmount) },
    { key: 'checkin_weekly_reward_amount', value: String(next.weeklyRewardAmount) },
    { key: 'checkin_reward_item_id', value: next.rewardItemId },
    { key: 'checkin_streak_reward_enabled', value: next.streakRewardEnabled ? '1' : '0' },
    { key: 'checkin_streak_reward_item_id', value: next.streakRewardItemId },
    { key: 'checkin_streak_reward_duration_amount', value: String(next.streakRewardDurationAmount) },
    { key: 'checkin_streak_reward_duration_unit', value: next.streakRewardDurationUnit }
  ]);
  return next;
}
