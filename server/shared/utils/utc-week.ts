/**
 * Semana UTC (segunda 00:00 → domingo). Partilhado por quests e gerente.
 */
import { MS_PER_DAY } from './time.js';

/** getUTCDay(): domingo = 0. */
export const UTC_WEEKDAY_SUNDAY = 0;
export const UTC_WEEKDAY_MONDAY = 1;
/** Dias a subir de domingo até à segunda anterior. */
export const DAYS_FROM_SUNDAY_TO_MONDAY = 6;
export const DAYS_PER_WEEK = 7;

/** Segunda 00:00 UTC da semana que contém `nowMs`. */
export function utcWeekStartMs(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  const day = d.getUTCDay(); // 0=Sun … 6=Sat
  const diff = day === UTC_WEEKDAY_SUNDAY ? DAYS_FROM_SUNDAY_TO_MONDAY : day - UTC_WEEKDAY_MONDAY;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff, 0, 0, 0, 0);
}

/** Início da semana UTC anterior à actual. */
export function previousUtcWeekStartMs(nowMs: number = Date.now()): number {
  return utcWeekStartMs(nowMs) - DAYS_PER_WEEK * MS_PER_DAY;
}
