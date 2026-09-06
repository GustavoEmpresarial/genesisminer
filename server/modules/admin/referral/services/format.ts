/**
 * Helpers de parsing/formatação partilhados pelos relatórios admin de referral.
 * Migrado de legacy/backend/controllers/adminReferralController.ts (funções puras).
 */
import { clamp } from '../../../../shared/utils/clamp.js';

const MAX_PAGE = 99_999;
const YMD_DIGITS_RE = /^\d+$/;

// Reexportado para não quebrar consumidores existentes que importam `clamp`
// a partir deste módulo (era uma cópia local idêntica; unificada com
// `shared/utils/clamp.ts`, mesma assinatura e comportamento).
export { clamp };

/**
 * `clamp` especializado em número de página: piso fixo em `MAX_PAGE`
 * (99_999), suficiente para qualquer paginação realista deste relatório.
 */
export function clampPage(n: number, lo: number): number {
  return clamp(n, lo, MAX_PAGE);
}

export function parseDateMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return null;
  if (YMD_DIGITS_RE.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function asNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function toMs(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
