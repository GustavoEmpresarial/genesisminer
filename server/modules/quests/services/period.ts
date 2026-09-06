/**
 * Migrado de legacy/backend/modules/quests/quest.period.ts (verbatim).
 */
import { brtCheckinPeriodStartMs, brtDayFromMs, nextCheckinPeriodEndMs } from '../../checkin/services/checkin.js';
import { utcWeekStartMs } from '../../../shared/utils/utc-week.js';
import { MS_PER_DAY } from '../../../shared/utils/time.js';
import type { QuestPeriod } from './types.js';

const ISO_DATE_LENGTH = 10; // "YYYY-MM-DD"

export type QuestPeriodBounds = {
  key: string;
  startMs: number;
  endMs: number;
};

/** Chave do ciclo diário alinhada ao check-in UTC 00:00→00:00. */
export function questDailyPeriodKey(nowMs: number = Date.now()): string {
  const start = brtCheckinPeriodStartMs(nowMs);
  return `d:${brtDayFromMs(start)}`;
}

/** Chave semanal (segunda 00:00 UTC), alinhada ao account-manager. */
export function questWeeklyPeriodKey(nowMs: number = Date.now()): string {
  const start = utcWeekStartMs(nowMs);
  const ymd = new Date(start).toISOString().slice(0, ISO_DATE_LENGTH);
  return `w:${ymd}`;
}

export function questPeriodKey(period: QuestPeriod, nowMs: number = Date.now()): string {
  return period === 'daily' ? questDailyPeriodKey(nowMs) : questWeeklyPeriodKey(nowMs);
}

/** Início/fim do ciclo diário actual (00:00 UTC → próximo 00:00 UTC). */
export function questDailyPeriodBounds(nowMs: number = Date.now()): QuestPeriodBounds {
  const startMs = brtCheckinPeriodStartMs(nowMs);
  return {
    key: `d:${brtDayFromMs(startMs)}`,
    startMs,
    endMs: nextCheckinPeriodEndMs(startMs)
  };
}

const DAYS_PER_WEEK = 7;

/** Início/fim da semana UTC actual (segunda 00:00 → próxima segunda 00:00). */
export function questWeeklyPeriodBounds(nowMs: number = Date.now()): QuestPeriodBounds {
  const startMs = utcWeekStartMs(nowMs);
  return {
    key: `w:${new Date(startMs).toISOString().slice(0, ISO_DATE_LENGTH)}`,
    startMs,
    endMs: startMs + DAYS_PER_WEEK * MS_PER_DAY
  };
}
