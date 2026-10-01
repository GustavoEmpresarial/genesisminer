/**
 * Política de check-in premium: quem gastou ≥ limite USDC vitalício (loja, merge,
 * passe, upgrades, P2P, wheel) — ou tem `checkin_premium_unlocked` — faz check-in
 * a cada N dias (em vez de diário), configurável via admin.
 *
 * Uma vez desbloqueado, permanece para sempre (1× na vida).
 */
import { prisma } from '../../../core/database/prisma.js';
import { getSettingsRecord, upsertSettingsEntries } from '../../../shared/settings/settings-repository.js';
import { MS_PER_HOUR } from '../../../shared/utils/time.js';

export const CHECKIN_PREMIUM_SETTINGS_KEYS = [
  'checkin_premium_enabled',
  'checkin_premium_min_usdc',
  'checkin_premium_interval_days'
] as const;

export const DEFAULT_CHECKIN_PREMIUM_MIN_USDC = 100;
export const DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS = 7;
const HOURS_PER_DAY = 24;
const UNLOCKED_FLAG = 1;

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

/** Soma gasto USDC vitalício (loja, P2P, wheel, merge, upgrades, passe). */
export async function sumLifetimeUsdcSpent(userId: number): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ spent: number | string | null }>>`
    SELECT COALESCE(SUM(amt), 0)::float8 AS spent
    FROM (
      SELECT total_cost AS amt FROM shop_checkout_idempotency WHERE user_id = ${userId}
      UNION ALL
      SELECT buyer_paid_usdc FROM p2p_market_trade_history WHERE buyer_id = ${userId}
      UNION ALL
      SELECT charged_usdc FROM wheel_spins WHERE user_id = ${userId} AND COALESCE(charged_usdc, 0) > 0
      UNION ALL
      SELECT fee_usdc FROM merge_history WHERE user_id = ${userId} AND COALESCE(fee_usdc, 0) > 0
      UNION ALL
      SELECT COALESCE(u.price_usdc, 0)
      FROM admin_upgrade_purchases p
      JOIN admin_upgrades u ON u.id = p.upgrade_id
      WHERE p.user_id = ${userId}
      UNION ALL
      SELECT COALESCE(pass.price_usdc, 0)
      FROM season_purchases sp
      JOIN season_passes pass ON pass.id = sp.pass_id
      WHERE sp.user_id = ${userId}
    ) s
  `;
  const raw = rows[0]?.spent;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Elegível se já desbloqueado OU gasto vitalício ≥ min.
 * Ao cruzar o limiar, persiste `checkin_premium_unlocked = 1` (1× na vida).
 */
export async function userHasPremiumUsdcSpend(userId: number, minUsdc: number): Promise<boolean> {
  const unlocked = await prisma.$queryRaw<Array<{ ok: number }>>`
    SELECT 1 AS ok
    FROM game_states
    WHERE user_id = ${userId} AND COALESCE(checkin_premium_unlocked, 0) = ${UNLOCKED_FLAG}
    LIMIT 1
  `;
  if (unlocked.length > 0) return true;

  const spent = await sumLifetimeUsdcSpent(userId);
  if (!(spent >= minUsdc)) return false;

  await prisma.$executeRaw`
    UPDATE game_states
    SET checkin_premium_unlocked = ${UNLOCKED_FLAG}
    WHERE user_id = ${userId} AND COALESCE(checkin_premium_unlocked, 0) <> ${UNLOCKED_FLAG}
  `;
  return true;
}

export type UserCheckinPremiumContext = {
  policy: CheckinPremiumPolicy;
  eligible: boolean;
  premiumWeeklyCheckin: boolean;
};

export async function resolveUserCheckinPremiumContext(userId: number): Promise<UserCheckinPremiumContext> {
  const policy = await loadCheckinPremiumPolicy();
  const eligible = policy.enabled ? await userHasPremiumUsdcSpend(userId, policy.minUsdc) : false;
  return { policy, eligible, premiumWeeklyCheckin: policy.enabled && eligible };
}
