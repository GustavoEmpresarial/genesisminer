/**
 * Check-in diário.
 *
 * Regras (servidor é a fonte de verdade):
 *  - Ciclo = dia civil **UTC** [00:00 → 00:00+1d). Check-in a qualquer hora.
 *  - Um check-in por dia UTC (idempotente se já fez hoje).
 *  - Mineração activa até **48h** após o último check-in (`CHECKIN_GRACE_MS`);
 *    só depois disso fica frozen.
 *  - Streak: +1 se o período anterior for o dia UTC imediatamente anterior
 *    ou com grace de 1 dia perdido (48h entre inícios de período).
 *  - Math pura opt-in em Rust (`GENESIS_CHECKIN_RUST=1`).
 *
 * Aliases `brt*` mantêm nomes legados (quests) mas usam UTC.
 */
import type { PoolClient } from 'pg';
import db from '../../../core/database/pool.js';
import { CHECKIN_REWARD_EVERY_DAYS } from './reward.js';
import {
  checkinRewardUnitLabel,
  streakRewardDurationConfig,
  type CheckinRewardPolicy,
  type CheckinRewardType
} from './reward-policy.js';
import {
  canPerformPremiumCheckinNow,
  DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS,
  isPremiumWithinActiveWindow,
  nextPremiumCheckinAllowedMs,
  premiumIntervalMs,
  resolveUserCheckinPremiumContext,
  type UserCheckinPremiumContext
} from './premium-policy.js';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import { callCheckinPerform, callCheckinStatus } from '../../mining-engine/services/mining-worker-client.js';
import { CheckinPremiumCooldownError } from './errors.js';
import { formatAsicDurationLabelPt, isTimedAsicDuration } from '../../../shared/utils/lease-duration.js';
import { MS_PER_DAY as SHARED_MS_PER_DAY } from '../../../shared/utils/time.js';
import {
  rustCheckinPeriodStartMs,
  rustCheckinWindow,
  rustUtcDayFromMs
} from './checkin-rust-bridge.js';

export { CHECKIN_PREMIUM_COOLDOWN_CODE, CheckinPremiumCooldownError } from './errors.js';

/** Node / mining-worker premium cooldown HTTP status. */
const HTTP_CONFLICT = 409;

export const CHECKIN_TIMEZONE = 'UTC';
export { CHECKIN_REWARD_EVERY_DAYS };
/** @deprecated use CHECKIN_CYCLE_HOUR_UTC — ciclo passa a UTC 00:00. */
export const CHECKIN_CYCLE_HOUR_BRT = 0;
export const CHECKIN_CYCLE_HOUR_UTC = 0;
/** Duração de um dia UTC (24h). */
export const CHECKIN_WINDOW_MS = SHARED_MS_PER_DAY;
/** Mineração continua até 48h após o último check-in. */
export const CHECKIN_GRACE_MS = 2 * SHARED_MS_PER_DAY;
/** Antecipação desactivada. */
export const CHECKIN_EARLY_WINDOW_MS = 0;


export type CheckinStatus = {
  today: string;
  timezone: string;
  lastCheckinDay: string | null;
  lastCheckinAtMs: number | null;
  streak: number;
  todayCheckedIn: boolean;
  /** Sempre false no fluxo UTC (sem early window). */
  canEarlyCheckin: boolean;
  frozen: boolean;
  /** Quando a mineração congela (último check-in + 48h), ou próximo UTC midnight se sem histórico. */
  nextResetMs: number;
  /**
   * Próximo momento em que o check-in diário volta a estar disponível (próximo 00:00 UTC),
   * ou null se já pode fazer check-in agora. Premium: espelha `nextCheckinAllowedMs` quando em cooldown.
   */
  nextCheckinAtMs: number | null;
  /** Ms restantes até freeze (0 quando frozen). */
  windowRemainingMs: number;
  /** Janela de graça total (48h). */
  windowDurationMs: number;
  rewardCycleProgress: number;
  rewardCycleSize: number;
  checkinBonusHps: number;
  rewardType: CheckinRewardType;
  rewardUnit: string;
  dailyRewardAmount: number;
  weeklyRewardAmount: number;
  streakRewardEnabled: boolean;
  streakRewardItemId: string;
  streakRewardDurationAmount: number;
  streakRewardDurationUnit: string;
  streakRewardDurationLabel: string | null;
  premiumWeeklyCheckin: boolean;
  premiumIntervalDays: number;
  premiumMinUsdc: number;
  nextCheckinAllowedMs: number | null;
  canCheckinNow: boolean;
};

export type CheckinResult = CheckinStatus & {
  performed: boolean;
  rewardGranted: number;
  rewardType: CheckinRewardType;
  rewardUnit: string;
  checkinBonusHps: number;
  streakReset: boolean;
  streakRewardGranted: number;
  streakRewardGrantedItemId: string | null;
  streakRewardGrantedItemName: string | null;
  streakRewardGrantedExpiresAtMs: number | null;
  streakRewardGrantedDurationLabel: string | null;
};

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
/** Comprimento de `YYYY-MM-DD` em ISO (`Date#toISOString().slice`). */
const ISO_YMD_LENGTH = 'YYYY-MM-DD'.length;

/** Dia civil UTC `YYYY-MM-DD`. */
export function utcDayFromMs(ms: number): string {
  const rust = rustUtcDayFromMs(ms);
  if (rust) return rust;
  const safe = Number.isFinite(ms) ? ms : Date.now();
  return new Date(safe).toISOString().slice(0, ISO_YMD_LENGTH);
}

/** @deprecated alias → `utcDayFromMs`. */
export function brtDayFromMs(ms: number): string {
  return utcDayFromMs(ms);
}

export function previousUtcDay(day: string): string {
  if (!DAY_REGEX.test(day)) return day;
  const [y, m, d] = day.split('-').map((p) => parseInt(p, 10));
  const prev = new Date(Date.UTC(y, m - 1, d) - SHARED_MS_PER_DAY);
  return prev.toISOString().slice(0, ISO_YMD_LENGTH);
}

export function nextUtcDay(day: string): string {
  if (!DAY_REGEX.test(day)) return day;
  const [y, m, d] = day.split('-').map((p) => parseInt(p, 10));
  const nxt = new Date(Date.UTC(y, m - 1, d) + SHARED_MS_PER_DAY);
  return nxt.toISOString().slice(0, ISO_YMD_LENGTH);
}

/** @deprecated alias. */
export const previousBrtDay = previousUtcDay;
/** @deprecated alias. */
export const nextBrtDay = nextUtcDay;

/** Início UTC 00:00 do dia `ymd`. */
export function utcDayStartMs(ymd: string): number {
  if (!DAY_REGEX.test(ymd)) return NaN;
  const [ys, mo, ds] = ymd.split('-').map((x) => parseInt(x, 10));
  return Date.UTC(ys, mo - 1, ds, CHECKIN_CYCLE_HOUR_UTC, 0, 0);
}

/** @deprecated alias → `utcDayStartMs` com hora 0. */
export function brtYmdAtWallTimeMs(ymd: string, hour: number, minute = 0, second = 0): number {
  if (!DAY_REGEX.test(ymd)) return NaN;
  const [ys, mo, ds] = ymd.split('-').map((x) => parseInt(x, 10));
  return Date.UTC(ys, mo - 1, ds, hour, minute, second);
}

/** Início do dia UTC que contém `nowMs`. */
export function utcCheckinPeriodStartMs(nowMs: number): number {
  const rust = rustCheckinPeriodStartMs(nowMs);
  if (rust != null && Number.isFinite(rust)) return rust;
  const safe = Number.isFinite(nowMs) ? nowMs : Date.now();
  return utcDayStartMs(utcDayFromMs(safe));
}

/** @deprecated alias → `utcCheckinPeriodStartMs`. */
export function brtCheckinPeriodStartMs(nowMs: number): number {
  return utcCheckinPeriodStartMs(nowMs);
}

export function nextCheckinPeriodEndMs(periodStartMs: number): number {
  return periodStartMs + CHECKIN_WINDOW_MS;
}

export function nextCheckinPeriodStartMs(nowMs: number): number {
  return nextCheckinPeriodEndMs(utcCheckinPeriodStartMs(nowMs));
}

export function isEarlyCheckinTimestamp(_lastCheckinAtMs: number, _nowMs: number): boolean {
  return false;
}

function lastCheckinAtMsNumber(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw === 'bigint') {
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  const v = parseInt(String(raw), 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Já fez check-in no dia UTC actual. */
export function hasCheckedInCurrentPeriod(
  lastCheckinAtMs: number | null | undefined,
  nowMs: number
): boolean {
  const rust = rustCheckinWindow(lastCheckinAtMs, nowMs);
  if (rust) return rust.todayCheckedIn;
  const at = lastCheckinAtMsNumber(lastCheckinAtMs);
  if (at == null) return false;
  return utcCheckinPeriodStartMs(at) === utcCheckinPeriodStartMs(nowMs);
}

/** Mineração activa enquanto `now - last <= 48h`. */
export function isWithinActiveCheckinWindow(
  lastCheckinAtMs: number | null | undefined,
  nowMs: number
): boolean {
  const rust = rustCheckinWindow(lastCheckinAtMs, nowMs);
  if (rust) return rust.withinWindow;
  const at = lastCheckinAtMsNumber(lastCheckinAtMs);
  if (at == null) return false;
  return nowMs - at <= CHECKIN_GRACE_MS;
}

export function canEarlyCheckinForNextPeriod(
  _lastCheckinAtMs: number | null | undefined,
  _nowMs: number
): boolean {
  return false;
}

type GameStateRow = {
  last_checkin_day: string | null;
  last_checkin_at_ms: number | string | bigint | null;
  checkin_streak: number | string | null;
  checkin_bonus_hps: number | string | null;
};

async function _readGameStateForCheckin(client: PoolClient, userId: number, forUpdate: boolean): Promise<GameStateRow | null> {
  const sql = `SELECT last_checkin_day, last_checkin_at_ms, checkin_streak, checkin_bonus_hps
                 FROM game_states
                WHERE user_id = $1
                ${forUpdate ? 'FOR UPDATE' : ''}`;
  const r = await client.query<GameStateRow>(sql, [userId]);
  if (!r.rowCount) return null;
  return r.rows[0];
}

function _streakNumber(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? '0'), 10);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function _checkinBonusHpsNumber(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '0'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function rewardFields(
  rewardPolicy: CheckinRewardPolicy,
  checkinBonusHps: number
): Pick<
  CheckinStatus,
  | 'checkinBonusHps'
  | 'rewardType'
  | 'rewardUnit'
  | 'dailyRewardAmount'
  | 'weeklyRewardAmount'
  | 'streakRewardEnabled'
  | 'streakRewardItemId'
  | 'streakRewardDurationAmount'
  | 'streakRewardDurationUnit'
  | 'streakRewardDurationLabel'
> {
  const streakCfg = streakRewardDurationConfig(rewardPolicy);
  return {
    checkinBonusHps,
    rewardType: rewardPolicy.rewardType,
    rewardUnit: checkinRewardUnitLabel(rewardPolicy.rewardType),
    dailyRewardAmount: rewardPolicy.dailyRewardAmount,
    weeklyRewardAmount: rewardPolicy.weeklyRewardAmount,
    streakRewardEnabled: !!rewardPolicy.streakRewardEnabled && !!rewardPolicy.streakRewardItemId.trim(),
    streakRewardItemId: rewardPolicy.streakRewardItemId,
    streakRewardDurationAmount: rewardPolicy.streakRewardDurationAmount,
    streakRewardDurationUnit: rewardPolicy.streakRewardDurationUnit,
    streakRewardDurationLabel: isTimedAsicDuration(streakCfg) ? formatAsicDurationLabelPt(streakCfg) : null
  };
}

function premiumFields(
  premiumCtx: UserCheckinPremiumContext,
  lastCheckinAtMs: number | null,
  nowMs: number
): Pick<CheckinStatus, 'premiumWeeklyCheckin' | 'premiumIntervalDays' | 'premiumMinUsdc' | 'nextCheckinAllowedMs' | 'canCheckinNow'> {
  const { policy, premiumWeeklyCheckin } = premiumCtx;
  const nextAllowed = premiumWeeklyCheckin ? nextPremiumCheckinAllowedMs(lastCheckinAtMs, policy.intervalDays) : null;
  return {
    premiumWeeklyCheckin,
    premiumIntervalDays: policy.intervalDays,
    premiumMinUsdc: policy.minUsdc,
    nextCheckinAllowedMs: nextAllowed,
    canCheckinNow: premiumWeeklyCheckin ? canPerformPremiumCheckinNow(lastCheckinAtMs, nowMs, policy.intervalDays) : true
  };
}

function buildStatusDaily(
  today: string,
  lastCheckinDay: string | null,
  lastCheckinAtMs: number | null,
  streak: number,
  nowMs: number,
  premiumCtx: UserCheckinPremiumContext,
  rewardPolicy: CheckinRewardPolicy,
  checkinBonusHps: number
): CheckinStatus {
  const withinWindow = isWithinActiveCheckinWindow(lastCheckinAtMs, nowMs);
  const todayCheckedIn = hasCheckedInCurrentPeriod(lastCheckinAtMs, nowMs);
  const frozen = !withinWindow;
  const nextResetMs =
    lastCheckinAtMs != null ? lastCheckinAtMs + CHECKIN_GRACE_MS : nextCheckinPeriodStartMs(nowMs);
  const windowRemainingMs = withinWindow && lastCheckinAtMs != null ? Math.max(0, nextResetMs - nowMs) : 0;
  const cycleSize = CHECKIN_REWARD_EVERY_DAYS;
  const cycleProgress = streak === 0 ? 0 : streak % cycleSize === 0 ? cycleSize : streak % cycleSize;
  const premium = premiumFields(premiumCtx, lastCheckinAtMs, nowMs);
  const canCheckinNow = !todayCheckedIn;
  return {
    today,
    timezone: CHECKIN_TIMEZONE,
    lastCheckinDay,
    lastCheckinAtMs,
    streak,
    todayCheckedIn,
    canEarlyCheckin: false,
    frozen,
    nextResetMs,
    nextCheckinAtMs: todayCheckedIn ? nextCheckinPeriodStartMs(nowMs) : null,
    windowRemainingMs,
    windowDurationMs: CHECKIN_GRACE_MS,
    rewardCycleProgress: cycleProgress,
    rewardCycleSize: cycleSize,
    ...rewardFields(rewardPolicy, checkinBonusHps),
    ...premium,
    canCheckinNow
  };
}

function buildStatusPremium(
  today: string,
  lastCheckinDay: string | null,
  lastCheckinAtMs: number | null,
  streak: number,
  nowMs: number,
  premiumCtx: UserCheckinPremiumContext,
  rewardPolicy: CheckinRewardPolicy,
  checkinBonusHps: number
): CheckinStatus {
  const { policy } = premiumCtx;
  const intervalMs = premiumIntervalMs(policy.intervalDays);
  const withinWindow = isPremiumWithinActiveWindow(lastCheckinAtMs, nowMs, policy.intervalDays);
  const frozen = !withinWindow;
  const nextResetMs = lastCheckinAtMs != null ? lastCheckinAtMs + intervalMs : nowMs + intervalMs;
  const windowRemainingMs = withinWindow ? Math.max(0, nextResetMs - nowMs) : 0;
  const canCheckinNow = canPerformPremiumCheckinNow(lastCheckinAtMs, nowMs, policy.intervalDays);
  const nextCheckinAllowedMs = nextPremiumCheckinAllowedMs(lastCheckinAtMs, policy.intervalDays);
  const cycleSize = CHECKIN_REWARD_EVERY_DAYS;
  const cycleProgress = streak === 0 ? 0 : streak % cycleSize === 0 ? cycleSize : streak % cycleSize;
  return {
    today,
    timezone: CHECKIN_TIMEZONE,
    lastCheckinDay,
    lastCheckinAtMs,
    streak,
    todayCheckedIn: withinWindow,
    canEarlyCheckin: false,
    frozen,
    nextResetMs,
    nextCheckinAtMs: canCheckinNow ? null : nextCheckinAllowedMs,
    windowRemainingMs,
    windowDurationMs: intervalMs,
    rewardCycleProgress: cycleProgress,
    rewardCycleSize: cycleSize,
    ...rewardFields(rewardPolicy, checkinBonusHps),
    premiumWeeklyCheckin: true,
    premiumIntervalDays: policy.intervalDays,
    premiumMinUsdc: policy.minUsdc,
    nextCheckinAllowedMs,
    canCheckinNow
  };
}

function _buildStatus(
  today: string,
  lastCheckinDay: string | null,
  lastCheckinAtMs: number | null,
  streak: number,
  nowMs: number,
  premiumCtx: UserCheckinPremiumContext,
  rewardPolicy: CheckinRewardPolicy,
  checkinBonusHps: number
): CheckinStatus {
  if (premiumCtx.premiumWeeklyCheckin) {
    return buildStatusPremium(today, lastCheckinDay, lastCheckinAtMs, streak, nowMs, premiumCtx, rewardPolicy, checkinBonusHps);
  }
  return buildStatusDaily(today, lastCheckinDay, lastCheckinAtMs, streak, nowMs, premiumCtx, rewardPolicy, checkinBonusHps);
}

/** Snapshot do check-in (para `GET /api/checkin/status`) — I/O em genesis-mining-worker. */
export async function getCheckinStatus(userId: number, nowMs: number = Date.now()): Promise<CheckinStatus> {
  const body = await callCheckinStatus({ userId, nowMs });
  return body as unknown as CheckinStatus;
}

/**
 * Aplica um check-in. Idempotente no mesmo dia UTC. I/O em genesis-mining-worker.
 */
export async function performCheckin(userId: number, nowMs: number = Date.now()): Promise<CheckinResult> {
  try {
    const body = await callCheckinPerform({ userId, nowMs });
    return body as unknown as CheckinResult;
  } catch (e) {
    if (e instanceof HttpControlledError && e.statusCode === HTTP_CONFLICT) {
      const next = Number(e.jsonBody.nextCheckinAllowedMs);
      const days = Number(e.jsonBody.intervalDays);
      throw new CheckinPremiumCooldownError(
        Number.isFinite(next) ? next : 0,
        Number.isFinite(days) && days >= 1 ? days : DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS
      );
    }
    throw e;
  }
}


/**
 * Helper barato (single read) para o cron de mineração descobrir se o
 * utilizador está congelado neste tick. Não usa lock — leitura best-effort.
 */
export async function isCheckinFrozenForUser(userId: number, lastCheckinAtMs: number | null | undefined, nowMs: number = Date.now()): Promise<boolean> {
  const premiumCtx = await resolveUserCheckinPremiumContext(userId);
  if (premiumCtx.premiumWeeklyCheckin) {
    return !isPremiumWithinActiveWindow(lastCheckinAtMs, nowMs, premiumCtx.policy.intervalDays);
  }
  return isCheckinFrozenAtMs(lastCheckinAtMs, nowMs);
}

export async function isUserFrozenForToday(userId: number, nowMs: number = Date.now()): Promise<boolean> {
  const client = await db.connect();
  try {
    const r = await client.query<{ last_checkin_at_ms: number | string | bigint | null }>('SELECT last_checkin_at_ms FROM game_states WHERE user_id = $1', [userId]);
    if (!r.rowCount) return true;
    return isCheckinFrozenForUser(userId, lastCheckinAtMsNumber(r.rows[0].last_checkin_at_ms), nowMs);
  } finally {
    client.release();
  }
}

/** Versão pura para readers (cron, snapshots) — freeze após 48h sem check-in. */
export function isCheckinFrozenAtMs(lastCheckinAtMs: number | null | undefined, nowMs: number): boolean {
  return !isWithinActiveCheckinWindow(lastCheckinAtMs, nowMs);
}
