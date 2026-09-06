/**
 * Política de check-in premium: quem comprou upgrade acima de um limite USDC pode
 * fazer check-in a cada N dias (em vez de diário), configurável via admin.
 *
 * Migrado de legacy/backend/modules/checkin/checkinPremiumPolicy.ts.
 */
import { prisma } from '../../../core/database/prisma.js';
import { getSettingsRecord, upsertSettingsEntries } from '../../../shared/settings/settings-repository.js';
import { MS_PER_HOUR } from '../../../shared/utils/time.js';

export const CHECKIN_PREMIUM_SETTINGS_KEYS = [
  'checkin_premium_enabled',
  'checkin_premium_min_usdc',
  'checkin_premium_interval_days'
] as const;

export const DEFAULT_CHECKIN_PREMIUM_MIN_USDC = 195;
export const DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS = 7;
const HOURS_PER_DAY = 24;

export type CheckinPremiumPolicy = {
  enabled: boolean;
  minUsdc: number;
  intervalDays: number;
};

export function premiumIntervalMs(intervalDays: number): number {
  const d = Number.isFinite(intervalDays) && intervalDays >= 1 ? Math.floor(intervalDays) : DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS;
  return d * HOURS_PER_DAY * MS_PER_HOUR;
}

/** Mineração activa na janela semanal premium. */
export function isPremiumWithinActiveWindow(lastCheckinAtMs: number | null | undefined, nowMs: number, intervalDays: number): boolean {
  const at = typeof lastCheckinAtMs === 'number' && Number.isFinite(lastCheckinAtMs) && lastCheckinAtMs > 0 ? lastCheckinAtMs : null;
  if (at == null) return false;
  return nowMs - at < premiumIntervalMs(intervalDays);
}

export function nextPremiumCheckinAllowedMs(lastCheckinAtMs: number | null | undefined, intervalDays: number): number | null {
  const at = typeof lastCheckinAtMs === 'number' && Number.isFinite(lastCheckinAtMs) && lastCheckinAtMs > 0 ? lastCheckinAtMs : null;
  if (at == null) return null;
  return at + premiumIntervalMs(intervalDays);
}

export function canPerformPremiumCheckinNow(lastCheckinAtMs: number | null | undefined, nowMs: number, intervalDays: number): boolean {
  const at = typeof lastCheckinAtMs === 'number' && Number.isFinite(lastCheckinAtMs) && lastCheckinAtMs > 0 ? lastCheckinAtMs : null;
  if (at == null) return true;
  return nowMs >= at + premiumIntervalMs(intervalDays);
}

export async function loadCheckinPremiumPolicy(): Promise<CheckinPremiumPolicy> {
  const s = await getSettingsRecord([...CHECKIN_PREMIUM_SETTINGS_KEYS]);
  const enabledRaw = s.checkin_premium_enabled;
  const enabled = enabledRaw === undefined || enabledRaw === '' ? true : enabledRaw === '1';
  const minParsed = parseFloat(String(s.checkin_premium_min_usdc ?? DEFAULT_CHECKIN_PREMIUM_MIN_USDC));
  const minUsdc = Number.isFinite(minParsed) && minParsed >= 0 ? minParsed : DEFAULT_CHECKIN_PREMIUM_MIN_USDC;
  const daysParsed = parseInt(String(s.checkin_premium_interval_days ?? DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS), 10);
  const intervalDays = Number.isFinite(daysParsed) && daysParsed >= 1 ? daysParsed : DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS;
  return { enabled, minUsdc, intervalDays };
}

export async function saveCheckinPremiumPolicy(input: Partial<CheckinPremiumPolicy>): Promise<CheckinPremiumPolicy> {
  const current = await loadCheckinPremiumPolicy();
  const next: CheckinPremiumPolicy = {
    enabled: input.enabled !== undefined ? !!input.enabled : current.enabled,
    minUsdc: input.minUsdc !== undefined && Number.isFinite(input.minUsdc) && input.minUsdc >= 0 ? input.minUsdc : current.minUsdc,
    intervalDays:
      input.intervalDays !== undefined && Number.isFinite(input.intervalDays) && input.intervalDays >= 1
        ? Math.floor(input.intervalDays)
        : current.intervalDays
  };
  await upsertSettingsEntries([
    { key: 'checkin_premium_enabled', value: next.enabled ? '1' : '0' },
    { key: 'checkin_premium_min_usdc', value: String(next.minUsdc) },
    { key: 'checkin_premium_interval_days', value: String(next.intervalDays) }
  ]);
  return next;
}

export async function userHasPremiumUpgradePurchase(userId: number, minUsdc: number): Promise<boolean> {
  const row = await prisma.$queryRaw<Array<{ ok: number }>>`
    SELECT 1 AS ok
    FROM admin_upgrade_purchases p
    INNER JOIN admin_upgrades u ON u.id = p.upgrade_id
    WHERE p.user_id = ${userId} AND u.price_usdc >= ${minUsdc}
    LIMIT 1
  `;
  return row.length > 0;
}

export type UserCheckinPremiumContext = {
  policy: CheckinPremiumPolicy;
  eligible: boolean;
  premiumWeeklyCheckin: boolean;
};

export async function resolveUserCheckinPremiumContext(userId: number): Promise<UserCheckinPremiumContext> {
  const policy = await loadCheckinPremiumPolicy();
  const eligible = policy.enabled ? await userHasPremiumUpgradePurchase(userId, policy.minUsdc) : false;
  return { policy, eligible, premiumWeeklyCheckin: policy.enabled && eligible };
}
