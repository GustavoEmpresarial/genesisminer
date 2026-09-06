/**
 * Concessão da recompensa do check-in (hashrate/bateria/item) e do prémio de
 * sequência de 7 dias (máquina temporária, via `player_asic_leases`).
 *
 * Migrado de legacy/backend/modules/checkin/checkinReward.ts.
 */
import type { PoolClient } from 'pg';
import { MS_PER_DAY } from '../../../shared/utils/time.js';
import { formatAsicDurationLabelPt, isTimedAsicDuration } from '../../../shared/utils/lease-duration.js';
import { callHardwareCredit } from '../../hardware/services/hardware-client.js';
import { checkinRewardUnitLabel, streakRewardDurationConfig, type CheckinRewardPolicy, type CheckinRewardType } from './reward-policy.js';

/** Ciclo do troféu / prémio de sequência (7 dias seguidos). */
export const CHECKIN_REWARD_EVERY_DAYS = 7;

/** Mesma fonte de `CHECKIN_WINDOW_MS` de `checkin.ts` (`shared/utils/time.ts`) — evita duas fórmulas divergentes pro mesmo conceito de "1 dia". */
const CHECKIN_WINDOW_MS = MS_PER_DAY;
/** Até 48h entre check-ins diários preserva a sequência (1 ciclo perdido). */
export const CHECKIN_STREAK_GRACE_MS = 2 * CHECKIN_WINDOW_MS;

export type CheckinGrantResult = {
  rewardGranted: number;
  rewardType: CheckinRewardType;
  rewardUnit: string;
  batteryId: string | null;
  checkinBonusHps: number;
};

export function computeNextDailyCheckinStreak(
  prevStreak: number,
  prevPeriod: number | null,
  streakAnchorPeriod: number
): { nextStreak: number; streakReset: boolean } {
  if (prevPeriod == null) {
    return { nextStreak: 1, streakReset: false };
  }
  const periodGap = streakAnchorPeriod - prevPeriod;
  if (periodGap === CHECKIN_WINDOW_MS || periodGap === CHECKIN_STREAK_GRACE_MS) {
    return { nextStreak: prevStreak + 1, streakReset: false };
  }
  return { nextStreak: 1, streakReset: prevStreak !== 0 };
}

export function computeNextPremiumCheckinStreak(
  prevStreak: number,
  prevAtMs: number | null,
  nowMs: number,
  intervalMs: number
): { nextStreak: number; streakReset: boolean } {
  if (prevAtMs != null && nowMs - prevAtMs <= intervalMs + CHECKIN_WINDOW_MS) {
    return { nextStreak: prevStreak + 1, streakReset: false };
  }
  return { nextStreak: 1, streakReset: prevStreak !== 0 || prevAtMs !== null };
}

/**
 * Recompensa em cada check-in válido (diário ou premium). Sempre `true` hoje — mantido
 * como função nomeada (em vez de inline `true` nos 2 call-sites, `checkin.ts`) porque
 * é ponto de extensão idêntico ao legado (`checkinReward.ts`, verbatim: mesmos
 * parâmetros ignorados), pra permitir no futuro condicionar a recompensa por streak/tier
 * premium sem mexer no chamador.
 */
export function shouldGrantCheckinReward(_nextStreak: number, _premiumWeeklyCheckin: boolean): boolean {
  return true;
}

/** Prémio de ciclo: 7, 14, 21… dias de check-in diário seguidos. */
export function shouldGrantStreakMilestoneReward(nextStreak: number): boolean {
  const n = Math.floor(Number(nextStreak) || 0);
  return n > 0 && n % CHECKIN_REWARD_EVERY_DAYS === 0;
}

export type CheckinStreakGrantResult = {
  granted: number;
  itemId: string | null;
  itemName: string | null;
  expiresAtMs: number | null;
  durationLabel: string | null;
};

const EMPTY_STREAK_GRANT: CheckinStreakGrantResult = {
  granted: 0,
  itemId: null,
  itemName: null,
  expiresAtMs: null,
  durationLabel: null
};

/**
 * Prémio de 7 dias seguidos: concede 1 unidade temporizada (`player_asic_leases`)
 * do item configurado — só se `streakRewardEnabled`, o item existir/estar activo
 * e for `type = 'machine'` (só máquinas têm validade neste sistema).
 *
 * Sempre `callHardwareCredit` com override de duração da policy
 * (`durationAmount`/`durationUnit`) — o worker cria leases com essa cfg,
 * não a do catálogo. Fail-closed.
 */
export async function grantCheckinStreakTemporaryItem(client: PoolClient, userId: number, policy: CheckinRewardPolicy, nowMs: number): Promise<CheckinStreakGrantResult> {
  if (!policy.streakRewardEnabled) return EMPTY_STREAK_GRANT;
  const itemId = String(policy.streakRewardItemId || '').trim();
  if (!itemId) return EMPTY_STREAK_GRANT;

  const cfg = streakRewardDurationConfig(policy);
  if (!isTimedAsicDuration(cfg)) return EMPTY_STREAK_GRANT;

  const up = await client.query<{ id: string; name: string | null; type: string | null }>(
    `SELECT id, name, type FROM upgrades WHERE id = $1 AND COALESCE(is_active, 1) <> 0 LIMIT 1`,
    [itemId]
  );
  const row = up.rows[0];
  if (!row) {
    console.error('[checkin] Streak reward — upgrade ausente ou inactivo', { userId, itemId });
    return EMPTY_STREAK_GRANT;
  }
  if (String(row.type ?? '') !== 'machine') {
    console.error('[checkin] Streak reward — só máquinas (type=machine) com validade', { userId, itemId, type: row.type });
    return EMPTY_STREAK_GRANT;
  }

  const streakQty = 1;
  await callHardwareCredit({
    userId,
    itemId,
    qty: streakQty,
    durationAmount: cfg.amount,
    durationUnit: cfg.unit ?? undefined
  });

  const lease = await client.query<{ expires_at: string | number | bigint }>(
    `SELECT expires_at FROM player_asic_leases
      WHERE user_id = $1 AND item_id = $2 AND status = 'stock' AND expires_at > $3
      ORDER BY expires_at DESC
      LIMIT 1`,
    [userId, itemId, nowMs]
  );
  const expiresRaw = lease.rows[0]?.expires_at;
  const expiresAtMs = expiresRaw != null && Number.isFinite(Number(expiresRaw)) ? Number(expiresRaw) : null;

  return {
    granted: streakQty,
    itemId,
    itemName: row.name != null ? String(row.name) : itemId,
    expiresAtMs,
    durationLabel: formatAsicDurationLabelPt(cfg)
  };
}

/**
 * Concede N unidades em `stock` (baterias e outros itens de check-in).
 * Inventário jogável é stock-only; não cria linhas warehouse em `stored_batteries`.
 */
async function grantCheckinInventoryItem(
  client: PoolClient,
  userId: number,
  itemId: string,
  quantity: number
): Promise<{ granted: number; batteryId: string | null }> {
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (qty <= 0) return { granted: 0, batteryId: null };

  const up = await client.query<{ id: string }>(
    `SELECT id FROM upgrades WHERE id = $1 AND COALESCE(is_active, 1) <> 0 LIMIT 1`,
    [itemId]
  );
  if (!up.rows[0]) {
    console.error('[checkin] Falha ao conceder item de recompensa — upgrade ausente ou inactivo', { userId, itemId });
    return { granted: 0, batteryId: null };
  }

  await callHardwareCredit({ userId, itemId, qty });
  return { granted: qty, batteryId: null };
}

export async function grantCheckinReward(
  client: PoolClient,
  userId: number,
  amount: number,
  policy: CheckinRewardPolicy
): Promise<CheckinGrantResult> {
  const rewardType = policy.rewardType;
  const rewardUnit = checkinRewardUnitLabel(rewardType);
  const qty = Number(amount);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { rewardGranted: 0, rewardType, rewardUnit, batteryId: null, checkinBonusHps: 0 };
  }

  if (rewardType === 'hashrate') {
    const upd = await client.query(
      `UPDATE game_states
          SET checkin_bonus_hps = COALESCE(checkin_bonus_hps, 0) + $2
        WHERE user_id = $1
        RETURNING checkin_bonus_hps`,
      [userId, qty]
    );
    const bonusRaw = upd.rows[0]?.checkin_bonus_hps;
    const checkinBonusHps = Number(bonusRaw);
    return {
      rewardGranted: qty,
      rewardType,
      rewardUnit,
      batteryId: null,
      checkinBonusHps: Number.isFinite(checkinBonusHps) ? checkinBonusHps : qty
    };
  }

  const itemGrant = await grantCheckinInventoryItem(client, userId, policy.rewardItemId, qty);
  return { rewardGranted: itemGrant.granted, rewardType, rewardUnit, batteryId: itemGrant.batteryId, checkinBonusHps: 0 };
}
