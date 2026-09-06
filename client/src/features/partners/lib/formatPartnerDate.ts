import type { AppLocale } from '../../../shared/i18n';
import { dateLocaleFor } from '../../../shared/utils/locale-format';

export function formatPartnerDate(ms: number, locale: AppLocale, fallback = '—'): string {
  if (!ms) return fallback;
  try {
    return new Date(ms).toLocaleDateString(dateLocaleFor(locale), {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  } catch {
    return fallback;
  }
}

export function formatPartnerDateShort(ms: number, locale: AppLocale, fallback = '—'): string {
  if (!ms) return fallback;
  try {
    return new Date(ms).toLocaleDateString(dateLocaleFor(locale), {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  } catch {
    return fallback;
  }
}
