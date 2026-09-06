/**
 * Migrado de legacy/backend/validation/roletaValidation.ts — só as funções
 * usadas pelos controllers portados (`parseWonItemId` também é usado, pela
 * rota `/api/roleta/claim`). `RoletaAppError` foi substituída por
 * `HttpControlledError` (padrão já usado no resto de `current/server`).
 *
 * `parseIdempotencyKey` NÃO é definida aqui — reexportada de
 * `shared/validation/idempotency-key.ts` (extraída antes, na migração de
 * `modules/upgrades`; este arquivo tinha uma cópia local idêntica que foi
 * removida ao notar a duplicação — ver docs/architecture/DECISIONS.md).
 */
const PROMO_CODE_MAX_LENGTH = 120;
const PROMO_CODE_MIN_LENGTH = 1;
const PROMO_CODE_MAX_LENGTH_UPPER = 80;
const SAFE_ITEM_ID_RE = /^[a-zA-Z0-9_.-]{1,200}$/;
const DISPLAY_NAME_FALLBACK = 'Prêmio';

// eslint-disable-next-line no-control-regex -- uso deliberado: rejeita códigos com bytes de controlo.
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
// eslint-disable-next-line no-control-regex -- uso deliberado: sanitiza nomes de exibição contra XSS em texto plano.
const CONTROL_AND_ANGLE_BRACKETS_RE = /[\x00-\x1f<>]/g;

export { parseIdempotencyKey } from '../../../shared/validation/idempotency-key.js';

export function normalizePromoCode(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > PROMO_CODE_MAX_LENGTH) return null;
  if (CONTROL_CHARS_RE.test(trimmed)) return null;
  const upper = trimmed.toUpperCase();
  if (upper.length < PROMO_CODE_MIN_LENGTH || upper.length > PROMO_CODE_MAX_LENGTH_UPPER) return null;
  return upper;
}

export function parseWonItemId(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'string') return null;
  const s = raw.trim();
  return s && SAFE_ITEM_ID_RE.test(s) ? s : null;
}

/** Nome de caixa exibido — limita tamanho e remove caracteres típicos de XSS em texto plano. */
export function sanitizeDisplayName(raw: string, maxLen: number): string {
  let s = String(raw).replace(CONTROL_AND_ANGLE_BRACKETS_RE, '').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s || DISPLAY_NAME_FALLBACK;
}
