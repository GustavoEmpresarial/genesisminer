/** Format helpers for ZERads stats display. */
import type { AppLocale } from '../../../shared/i18n';
import { dateLocaleFor } from '../../../shared/utils/locale-format';
import { ZERADS_USDC_FRACTION_DIGITS, ZERADS_ZER_FRACTION_DIGITS } from './constants';

export function formatZeradsUsdc(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(ZERADS_USDC_FRACTION_DIGITS).replace(/0+$/, '').replace(/\.$/, '');
}

export function formatZeradsZer(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(ZERADS_ZER_FRACTION_DIGITS).replace(/0+$/, '').replace(/\.$/, '');
}

export function formatZeradsTs(ms: number, locale: AppLocale): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    return new Date(ms).toLocaleString(dateLocaleFor(locale), {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return new Date(ms).toISOString();
  }
}
