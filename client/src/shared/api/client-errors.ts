/**
 * Maps compact API / fetch error codes to i18n keys.
 * Feature pages pass `t` and a key prefix (e.g. `checkin`, `support`).
 *
 * Convention for player APIs in `shared/api/*`:
 * - `SESSION` — 401 after refresh failed
 * - `NETWORK` — fetch threw
 * - `INVALID` — ok response but unparseable body
 * - `LOAD_FAILED` — generic load failure without message
 * - `CLAIM_FAILED` — claim/perform mutation failed → `${prefix}.claimError`
 * - otherwise treat as a server-provided human string (shown as-is)
 */
export type ApiErrorCode = 'SESSION' | 'NETWORK' | 'INVALID' | 'LOAD_FAILED' | 'CLAIM_FAILED' | string;

export function mapApiErrorToMessage(
  code: ApiErrorCode,
  t: (key: string) => string,
  i18nPrefix: string
): string {
  if (code === 'SESSION') return t(`${i18nPrefix}.sessionExpired`);
  if (code === 'NETWORK') return t(`${i18nPrefix}.networkError`);
  if (code === 'INVALID') return t(`${i18nPrefix}.invalidResponse`);
  if (code === 'CLAIM_FAILED') return t(`${i18nPrefix}.claimError`);
  if (!code || code === 'LOAD_FAILED') return t(`${i18nPrefix}.loadError`);
  // Server already sent a localized / English message — show as-is.
  return code;
}
