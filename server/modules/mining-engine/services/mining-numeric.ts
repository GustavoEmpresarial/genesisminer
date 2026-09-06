/**
 * Parsing seguro de números vindos da BD/JSON para evitar NaN silencioso
 * e ambiguidade entre separador decimal "," e "." (locale).
 *
 * Migrado de legacy/backend/cron/miningNumeric.ts (verbatim).
 */
import { sanitizeForLog } from '../../../shared/utils/safe-text.js';

const AMBIGUOUS_CHARS_RE = /[<>'"`;\\]/;
const COMMA_RE = /,/g;
const DOT_RE = /\./g;
const WHITESPACE_RE = /\s/g;
const LOG_VALUE_MAX_LENGTH = 48;
const LOG_ERROR_MESSAGE_MAX_LENGTH = 200;

export class MiningNumericError extends Error {
  constructor(
    readonly context: string | undefined,
    message: string
  ) {
    super(context ? `[${context}] ${message}` : message);
    this.name = 'MiningNumericError';
  }
}

/**
 * Converte string/número para número finito.
 * Aceita "12,34" só quando não ambíguo; rejeita múltiplos separadores estilo milhares.
 */
export function parseFiniteNumber(value: unknown, context?: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MiningNumericError(context, 'número não finito');
    }
    return value;
  }
  if (value == null) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;

  if (AMBIGUOUS_CHARS_RE.test(raw)) {
    throw new MiningNumericError(context, 'caracteres inválidos no valor numérico');
  }

  const commaCount = (raw.match(COMMA_RE) ?? []).length;
  const dotCount = (raw.match(DOT_RE) ?? []).length;
  let norm = raw.replace(WHITESPACE_RE, '');

  if (commaCount > 1 && dotCount === 0) {
    throw new MiningNumericError(context, 'vírgulas múltiplas ambíguas');
  }
  if (dotCount > 1 && commaCount === 0) {
    throw new MiningNumericError(context, 'pontos múltiplos ambíguos');
  }

  if (commaCount === 1 && dotCount === 0) {
    norm = norm.replace(',', '.');
  } else if (commaCount === 1 && dotCount === 1) {
    const lastComma = norm.lastIndexOf(',');
    const lastDot = norm.lastIndexOf('.');
    if (lastComma > lastDot) {
      norm = norm.replace(DOT_RE, '').replace(',', '.');
    } else {
      norm = norm.replace(COMMA_RE, '');
    }
  } else if (commaCount > 0 && dotCount > 0 && commaCount + dotCount > 2) {
    throw new MiningNumericError(context, 'separadores decimais ambíguos');
  }

  const n = Number(norm);
  if (!Number.isFinite(n)) {
    throw new MiningNumericError(context, `valor não numérico: ${sanitizeForLog(raw, LOG_VALUE_MAX_LENGTH)}`);
  }
  return n;
}

/** Para campos opcionais: falha → 0 + nunca lança. */
export function parseFiniteNumberLenient(value: unknown, context?: string): number {
  try {
    return parseFiniteNumber(value, context);
  } catch (e) {
    if (e instanceof MiningNumericError) {
      console.warn('[MiningNumeric]', sanitizeForLog(e.message, LOG_ERROR_MESSAGE_MAX_LENGTH));
    }
    return 0;
  }
}
