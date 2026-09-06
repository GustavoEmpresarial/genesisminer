/**
 * Logger estruturado mínimo (JSON numa linha). Sem plataforma externa.
 * Não loga secrets — o caller nunca deve passar passwords/tokens/DATABASE_URL.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = {
  module?: string;
  job?: string;
  requestId?: string;
  durationMs?: number;
  event?: string;
  err?: unknown;
  [key: string]: unknown;
};

type RequestStore = { requestId: string };

const requestAls = new AsyncLocalStorage<RequestStore>();

const SENSITIVE_KEY_RE = /password|passwd|secret|token|cookie|authorization|database_url|redis_url|api[_-]?key/i;

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestAls.run({ requestId }, fn);
}

export function getRequestId(): string | undefined {
  return requestAls.getStore()?.requestId;
}

function serializeError(err: unknown): Record<string, unknown> | undefined {
  if (err == null) return undefined;
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack?.split('\n').slice(0, 8).join('\n') };
  }
  return { message: String(err) };
}

function scrub(value: unknown, keyHint = ''): unknown {
  if (SENSITIVE_KEY_RE.test(keyHint)) return '[redacted]';
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v, i) => scrub(v, String(i)));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = scrub(v, k);
  }
  return out;
}

function write(level: LogLevel, message: string, fields: LogFields = {}): void {
  const { err, requestId, ...rest } = fields;
  const rid = requestId ?? getRequestId();
  const scrubbed = scrub(rest) as Record<string, unknown>;
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(rid ? { requestId: rid } : {}),
    ...scrubbed
  };
  const ser = serializeError(err);
  if (ser) payload.err = ser;

  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: LogFields) => write('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => write('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => write('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => write('error', msg, fields)
};

/** Só para testes — limpa ALS. */
export function resetRequestContextForTests(): void {
  /* ALS is per-async-context; no global to clear */
}
