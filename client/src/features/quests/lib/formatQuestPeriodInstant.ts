/**
 * Formats a quest period boundary for display (day/month/year HH:mm ZONE).
 */
import type { AppLocale } from '../../../shared/i18n';
import { dateLocaleFor } from '../../../shared/utils/locale-format';

export function formatQuestPeriodInstant(
  ms: number,
  timeZone: string,
  zoneLabel: string,
  locale: AppLocale
): string {
  const parts = new Intl.DateTimeFormat(dateLocaleFor(locale), {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value || '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')} ${zoneLabel}`;
}
