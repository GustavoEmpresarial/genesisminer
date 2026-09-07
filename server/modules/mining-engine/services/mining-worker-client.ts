/**
 * Thin HTTP client for `genesis-mining-worker` (progress credit I/O in Rust).
 *
 * Callers always delegate here — there is no TS fallback in `computeProgressForUser`.
 * Unset `GENESIS_MINING_WORKER_URL` → `{ ok: false, error: 'GENESIS_MINING_WORKER_URL unset' }`.
 * Contract: POST `{base}/v1/mining/progress` body `{ "userId": N }` → `{ ok, … }`.
 * Auth: header `x-mining-worker-token` = `MINING_WORKER_AUTH_TOKEN` (required in prod).
 */

import { opsConfig } from '../../../core/ops/config.js';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import { MS_PER_SECOND } from '../../../shared/utils/time.js';
import type { PlayerCalculatorSnapshot } from '../../player-calculator/services/snapshot-types.js';

/** Default listen port for genesis-mining-worker (Compose / local). Single source for 8091. */
export const MINING_WORKER_DEFAULT_PORT = 8091;

/** Auth header — keep in sync with Rust `MINING_WORKER_AUTH_HEADER`. */
export const MINING_WORKER_AUTH_HEADER = 'x-mining-worker-token';

/** Path for progress credit — fixed contract with the Rust worker. */
const MINING_WORKER_PROGRESS_PATH = '/v1/mining/progress';

/** Path for gerente closed-week payout — fixed contract with the Rust worker. */
const MINING_WORKER_GERENTE_PAYOUT_PATH = '/v1/gerente/payout';

const MINING_WORKER_URL_UNSET = 'GENESIS_MINING_WORKER_URL unset';

/** Path for chat TTL SQL purge batch — fixed contract with the Rust worker. */
const MINING_WORKER_CHAT_PURGE_PATH = '/v1/chat/purge-expired';

/** Chat INSERT — fixed contract with the Rust worker. */
const MINING_WORKER_CHAT_INSERT_PATH = '/v1/chat/insert';
/** Chat body UPDATE — fixed contract with the Rust worker. */
const MINING_WORKER_CHAT_EDIT_PATH = '/v1/chat/edit';
/** Chat soft-delete UPDATE — fixed contract with the Rust worker. */
const MINING_WORKER_CHAT_DELETE_PATH = '/v1/chat/delete';

/** Support ticket submit — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_SUBMIT_PATH = '/v1/support/submit';
/** Support player reply — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_REPLY_PATH = '/v1/support/reply';
/** Support admin reply — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_ADMIN_REPLY_PATH = '/v1/support/admin-reply';
/** Support player list — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_LIST_MINE_PATH = '/v1/support/list-mine';
/** Support player get — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_GET_PATH = '/v1/support/get';
/** Support player state — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_STATE_PATH = '/v1/support/state';
/** Support player archive — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_ARCHIVE_PATH = '/v1/support/archive';
/** Support player reopen — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_REOPEN_PATH = '/v1/support/reopen';
/** Support admin list — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_ADMIN_LIST_PATH = '/v1/support/admin/list';
/** Support admin get — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_ADMIN_GET_PATH = '/v1/support/admin/get';
/** Support admin history — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_ADMIN_HISTORY_PATH = '/v1/support/admin/history';
/** Support admin stats — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_ADMIN_STATS_PATH = '/v1/support/admin/stats';
/** Chat history — fixed contract with the Rust worker. */
const MINING_WORKER_CHAT_HISTORY_PATH = '/v1/chat/history';
/** Chat get-by-id — fixed contract with the Rust worker. */
const MINING_WORKER_CHAT_GET_PATH = '/v1/chat/get';
/** Chat sender — fixed contract with the Rust worker. */
const MINING_WORKER_CHAT_SENDER_PATH = '/v1/chat/sender';
/** Chat AM peers — fixed contract with the Rust worker. */
const MINING_WORKER_CHAT_PEERS_PATH = '/v1/chat/peers';
/** Chat mention search — fixed contract with the Rust worker. */
const MINING_WORKER_CHAT_MENTIONS_SEARCH_PATH = '/v1/chat/mentions-search';
/** Chat mention resolve — fixed contract with the Rust worker. */
const MINING_WORKER_CHAT_MENTIONS_RESOLVE_PATH = '/v1/chat/mentions-resolve';

/** Announcement create — fixed contract with the Rust worker. */
const MINING_WORKER_ANNOUNCEMENT_CREATE_PATH = '/v1/announcements/create';
/** Announcement update — fixed contract with the Rust worker. */
const MINING_WORKER_ANNOUNCEMENT_UPDATE_PATH = '/v1/announcements/update';
/** Announcement delete — fixed contract with the Rust worker. */
const MINING_WORKER_ANNOUNCEMENT_DELETE_PATH = '/v1/announcements/delete';
/** Announcement mark-read upsert — fixed contract with the Rust worker. */
const MINING_WORKER_ANNOUNCEMENT_MARK_READ_PATH = '/v1/announcements/mark-read';
/** Announcement pending list — fixed contract with the Rust worker. */
const MINING_WORKER_ANNOUNCEMENT_PENDING_PATH = '/v1/announcements/pending';
/** Announcement mini-blog list — fixed contract with the Rust worker. */
const MINING_WORKER_ANNOUNCEMENT_MINI_BLOG_PATH = '/v1/announcements/mini-blog';
/** Announcement admin list — fixed contract with the Rust worker. */
const MINING_WORKER_ANNOUNCEMENT_ADMIN_LIST_PATH = '/v1/announcements/admin-list';
/** Announcement get-by-id — fixed contract with the Rust worker. */
const MINING_WORKER_ANNOUNCEMENT_GET_PATH = '/v1/announcements/get';
/** Chat channel access — fixed contract with the Rust worker. */
const MINING_WORKER_CHAT_CAN_ACCESS_PATH = '/v1/chat/can-access';
/** Chat rate-limit Redis — fixed contract with the Rust worker. */
const MINING_WORKER_CHAT_RATE_LIMIT_PATH = '/v1/chat/rate-limit';
/** Chat presence Redis — fixed contract with the Rust worker. */
const MINING_WORKER_CHAT_PRESENCE_PATH = '/v1/chat/presence';
/** Support ticket-for-player — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_TICKET_FOR_PLAYER_PATH = '/v1/support/ticket-for-player';
/** Support attachment referenced — fixed contract with the Rust worker. */
const MINING_WORKER_SUPPORT_ATTACHMENT_REFERENCED_PATH = '/v1/support/attachment-referenced';
/** Active-user gate — fixed contract with the Rust worker. */
const MINING_WORKER_USERS_ASSERT_ACTIVE_PATH = '/v1/users/assert-active';
/** Chat audio disk write — fixed contract with the Rust worker. */
const MINING_WORKER_UPLOAD_CHAT_AUDIO_PATH = '/v1/uploads/chat-audio';
/** Support attachment disk write — fixed contract with the Rust worker. */
const MINING_WORKER_UPLOAD_SUPPORT_ATTACHMENT_PATH = '/v1/uploads/support-attachment';

/** Calculator snapshot I/O + assemble — fixed contract with the Rust worker. */
const MINING_WORKER_CALCULATOR_SNAPSHOT_PATH = '/v1/calculator/snapshot';
const MINING_WORKER_CHECKIN_STATUS_PATH = '/v1/checkin/status';
const MINING_WORKER_CHECKIN_PERFORM_PATH = '/v1/checkin/perform';
const MINING_WORKER_QUESTS_STATE_PATH = '/v1/quests/state';
const MINING_WORKER_HEADER_PATH = '/v1/player-game/header';
const MINING_WORKER_NAV_PATH = '/v1/player-game/nav';
const MINING_WORKER_DISPLAY_LABELS_PATH = '/v1/settings/display-labels';
const MINING_WORKER_PROFILE_STATE_PATH = '/v1/profile/state';
/** Node `snapshot.ts` `HTTP_FORBIDDEN`. */
const HTTP_FORBIDDEN = 403;
/** Node checkin premium cooldown. */
const HTTP_CONFLICT = 409;
const HTTP_OK = 200;
/** Worker `NOT_FOUND` HTTP status. */
const HTTP_NOT_FOUND = 404;
/** Node `snapshot.ts` `HTTP_UNPROCESSABLE_ENTITY`. */
const HTTP_UNPROCESSABLE_ENTITY = 422;
/** 5xx floor — fail-closed (same as auth-worker `HTTP_SERVER_ERROR_FLOOR`). */
const HTTP_SERVER_ERROR_FLOOR = 500;

/** Node `LOCK_TIMEOUT_MS` in support `mutation.ts` — HTTP budget for worker TX. */
export const SUPPORT_LOCK_TIMEOUT_MS = 45_000;

/** Seconds of `SET LOCAL statement_timeout` inside progress TX (mirrors progress-computer). */
export const PROGRESS_TX_TIMEOUT_SEC = 5;
const PROGRESS_TX_TIMEOUT_MS = PROGRESS_TX_TIMEOUT_SEC * MS_PER_SECOND;

/** HTTP budget = TX timeout × headroom for Redis lock + RTT. */
export const WORKER_PROGRESS_TIMEOUT_TX_MULTIPLIER = 6;
export const MINING_WORKER_PROGRESS_TIMEOUT_MS =
  PROGRESS_TX_TIMEOUT_MS * WORKER_PROGRESS_TIMEOUT_TX_MULTIPLIER;

/** Support HTTP budget = lock wait + same RTT slack as other worker HTTP. */
export const MINING_WORKER_SUPPORT_TIMEOUT_MS =
  SUPPORT_LOCK_TIMEOUT_MS + MINING_WORKER_PROGRESS_TIMEOUT_MS;

/** Chat purge HTTP budget — same source as `ttl-cron` / `JOB_TIMEOUT_CHAT_TTL_MS`. */
export const MINING_WORKER_CHAT_PURGE_TIMEOUT_MS = opsConfig.jobTimeouts.chatTtl;

export type MiningWorkerProgressResult = {
  ok: boolean;
  offlineMined?: Record<string, number>;
  error?: string;
  skippedRecent?: boolean;
};

/** Trimmed base URL or `null` when the worker is not configured. */
export function miningWorkerBaseUrl(): string | null {
  const raw = String(process.env.GENESIS_MINING_WORKER_URL ?? '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

/** Trimmed auth token or `null` when unset (dev may allow unauthenticated worker). */
export function miningWorkerAuthToken(): string | null {
  const raw = String(process.env.MINING_WORKER_AUTH_TOKEN ?? '').trim();
  return raw || null;
}

/**
 * Delegate progress credit to the Rust worker.
 * No TS fallback in the caller — unset URL returns `{ ok: false, error: 'GENESIS_MINING_WORKER_URL unset' }`.
 */
export async function callMiningWorkerProgress(userId: number): Promise<MiningWorkerProgressResult> {
  const base = miningWorkerBaseUrl();
  if (!base) {
    return { ok: false, error: MINING_WORKER_URL_UNSET };
  }

  const url = `${base}${MINING_WORKER_PROGRESS_PATH}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MINING_WORKER_PROGRESS_TIMEOUT_MS);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json'
  };
  const token = miningWorkerAuthToken();
  if (token) {
    headers[MINING_WORKER_AUTH_HEADER] = token;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId }),
      signal: ctrl.signal
    });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return { ok: false, error: `mining worker non-JSON (${res.status})` };
      }
    }
    if (!res.ok) {
      const errMsg = readWorkerError(body, res.status);
      return { ok: false, error: errMsg };
    }
    if (!body || typeof body !== 'object') {
      return { ok: false, error: 'mining worker empty body' };
    }
    const obj = body as Record<string, unknown>;
    return {
      ok: obj.ok === true,
      offlineMined: readOfflineMined(obj.offlineMined),
      error: typeof obj.error === 'string' ? obj.error : undefined,
      skippedRecent: obj.skippedRecent === true ? true : undefined
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `mining worker unreachable: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

export type MiningWorkerGerentePayoutResult =
  | { ok: true; paid: number; skipped: number }
  | { ok: false; error: string; paid?: number; skipped?: number };

/**
 * Delegate gerente closed-week payout to the Rust mining worker (fail-closed).
 * Unset URL → `{ ok: false, error: 'GENESIS_MINING_WORKER_URL unset' }`.
 */
export async function callMiningWorkerGerentePayout(args: {
  serverNowMs: number;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<MiningWorkerGerentePayoutResult> {
  const base = miningWorkerBaseUrl();
  if (!base) {
    return { ok: false, error: MINING_WORKER_URL_UNSET };
  }

  const url = `${base}${MINING_WORKER_GERENTE_PAYOUT_PATH}`;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (args.signal) {
    if (args.signal.aborted) {
      return { ok: false, error: 'gerente payout aborted' };
    }
    args.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), args.timeoutMs);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json'
  };
  const token = miningWorkerAuthToken();
  if (token) {
    headers[MINING_WORKER_AUTH_HEADER] = token;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ serverNowMs: args.serverNowMs }),
      signal: ctrl.signal
    });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return { ok: false, error: `mining worker non-JSON (${res.status})` };
      }
    }
    if (!body || typeof body !== 'object') {
      return { ok: false, error: res.ok ? 'mining worker empty body' : `mining worker HTTP ${res.status}` };
    }
    const obj = body as Record<string, unknown>;
    const paid = typeof obj.paid === 'number' && Number.isFinite(obj.paid) ? obj.paid : 0;
    const skipped = typeof obj.skipped === 'number' && Number.isFinite(obj.skipped) ? obj.skipped : 0;
    if (!res.ok || obj.ok !== true) {
      const errMsg =
        typeof obj.error === 'string' && obj.error.trim()
          ? obj.error
          : readWorkerError(body, res.status);
      return { ok: false, error: errMsg, paid, skipped };
    }
    return { ok: true, paid, skipped };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `mining worker unreachable: ${msg}` };
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', onAbort);
  }
}

function readWorkerError(body: unknown, status: number): string {
  if (body && typeof body === 'object' && body !== null && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === 'string' && err.trim()) return err;
  }
  return `mining worker HTTP ${status}`;
}

function readOfflineMined(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

export type MiningWorkerChatPurgeResult = {
  ok: true;
  deleted: number;
  ids: string[];
  channels: string[];
  audioUrls: string[];
  beforeMs: number;
};

const CHAT_PURGE_UNSET_ERROR = MINING_WORKER_URL_UNSET;

/**
 * Fail-closed chat TTL SQL batch via mining worker.
 * No local DELETE fallback — unset URL / transport errors throw.
 */
export async function callMiningWorkerChatPurge(opts?: {
  nowMs?: number;
  limit?: number;
}): Promise<MiningWorkerChatPurgeResult> {
  const base = miningWorkerBaseUrl();
  if (!base) {
    throw new Error(MINING_WORKER_URL_UNSET);
  }

  const url = `${base}${MINING_WORKER_CHAT_PURGE_PATH}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MINING_WORKER_CHAT_PURGE_TIMEOUT_MS);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json'
  };
  const token = miningWorkerAuthToken();
  if (token) {
    headers[MINING_WORKER_AUTH_HEADER] = token;
  }
  const payload: Record<string, number> = {};
  if (opts?.nowMs != null && Number.isFinite(opts.nowMs)) {
    payload.nowMs = Math.floor(opts.nowMs);
  }
  if (opts?.limit != null && Number.isFinite(opts.limit)) {
    payload.limit = Math.floor(opts.limit);
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new Error(`mining worker chat purge non-JSON (${res.status})`);
      }
    }
    if (!body || typeof body !== 'object') {
      throw new Error(res.ok ? 'mining worker chat purge empty body' : `mining worker chat purge HTTP ${res.status}`);
    }
    const obj = body as Record<string, unknown>;
    if (!res.ok || obj.ok !== true) {
      const errMsg =
        typeof obj.error === 'string' && obj.error.trim()
          ? obj.error
          : `mining worker chat purge HTTP ${res.status}`;
      throw new Error(errMsg);
    }
    return {
      ok: true,
      deleted: readRequiredNonNegInt(obj.deleted, 'deleted'),
      ids: readStringArray(obj.ids),
      channels: readStringArray(obj.channels),
      audioUrls: readStringArray(obj.audioUrls),
      beforeMs: readRequiredFiniteNumber(obj.beforeMs, 'beforeMs')
    };
  } catch (e) {
    if (e instanceof Error && (e.message === CHAT_PURGE_UNSET_ERROR || e.message.startsWith('mining worker chat purge'))) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`mining worker chat purge unreachable: ${msg}`, { cause: e });
  } finally {
    clearTimeout(timer);
  }
}

function readRequiredNonNegInt(raw: unknown, key: string): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`mining worker chat purge missing ${key}`);
  }
  return Math.floor(n);
}

function readRequiredFiniteNumber(raw: unknown, key: string): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`mining worker chat purge missing ${key}`);
  }
  return n;
}

function readStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'number' || typeof v === 'bigint') out.push(String(v));
  }
  return out;
}

async function postMiningWorkerJson(
  path: string,
  payload: unknown,
  timeoutMs: number,
  label: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = miningWorkerBaseUrl();
  if (!base) {
    throw new Error(MINING_WORKER_URL_UNSET);
  }
  const url = `${base}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json'
  };
  const token = miningWorkerAuthToken();
  if (token) {
    headers[MINING_WORKER_AUTH_HEADER] = token;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error(`mining worker ${label} non-JSON (${res.status})`);
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(res.ok ? `mining worker ${label} empty body` : `mining worker ${label} HTTP ${res.status}`);
    }
    return { status: res.status, body: parsed as Record<string, unknown> };
  } catch (e) {
    if (e instanceof Error && (e.message === MINING_WORKER_URL_UNSET || e.message.startsWith(`mining worker ${label}`))) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`mining worker ${label} unreachable: ${msg}`, { cause: e });
  } finally {
    clearTimeout(timer);
  }
}

async function postMiningWorkerMultipart(
  path: string,
  form: FormData,
  timeoutMs: number,
  label: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = miningWorkerBaseUrl();
  if (!base) {
    throw new Error(MINING_WORKER_URL_UNSET);
  }
  const url = `${base}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = miningWorkerAuthToken();
  if (token) {
    headers[MINING_WORKER_AUTH_HEADER] = token;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: ctrl.signal
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error(`mining worker ${label} non-JSON (${res.status})`);
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(res.ok ? `mining worker ${label} empty body` : `mining worker ${label} HTTP ${res.status}`);
    }
    return { status: res.status, body: parsed as Record<string, unknown> };
  } catch (e) {
    if (e instanceof Error && (e.message === MINING_WORKER_URL_UNSET || e.message.startsWith(`mining worker ${label}`))) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`mining worker ${label} unreachable: ${msg}`, { cause: e });
  } finally {
    clearTimeout(timer);
  }
}

function readOptionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw : undefined;
}

function readOptionalBool(raw: unknown): boolean | undefined {
  return raw === true ? true : undefined;
}

export type MiningWorkerSupportAttachment = { url: string; originalName: string; mime: string };

export type MiningWorkerSupportSubmitResult =
  | { ok: true; id: string; idempotentReplay?: boolean }
  | { ok: false; error: string; code?: string };

export type MiningWorkerSupportReplyResult =
  | { ok: true; replyId: string; idempotentReplay?: boolean }
  | { ok: false; error: string; code?: string };

export type MiningWorkerSupportAdminReplyResult =
  | { ok: true; id: string }
  | { ok: false; error: string; code?: string };

export async function callMiningWorkerSupportSubmit(args: {
  userId: number;
  subject: string;
  message: string;
  attachments: MiningWorkerSupportAttachment[];
  idempotencyKey?: string;
}): Promise<MiningWorkerSupportSubmitResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_SUBMIT_PATH,
    {
      userId: args.userId,
      subject: args.subject,
      message: args.message,
      attachments: args.attachments,
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {})
    },
    MINING_WORKER_SUPPORT_TIMEOUT_MS,
    'support submit'
  );
  if (body.ok === true && typeof body.id === 'string' && body.id.length > 0) {
    return { ok: true, id: body.id, idempotentReplay: readOptionalBool(body.idempotentReplay) };
  }
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker support submit HTTP ${status}`,
    code: readOptionalString(body.code)
  };
}

export async function callMiningWorkerSupportReply(args: {
  userId: number;
  ticketId: string;
  message: string;
  attachments: MiningWorkerSupportAttachment[];
  idempotencyKey?: string;
}): Promise<MiningWorkerSupportReplyResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_REPLY_PATH,
    {
      userId: args.userId,
      ticketId: args.ticketId,
      message: args.message,
      attachments: args.attachments,
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {})
    },
    MINING_WORKER_SUPPORT_TIMEOUT_MS,
    'support reply'
  );
  if (body.ok === true && typeof body.replyId === 'string' && body.replyId.length > 0) {
    return { ok: true, replyId: body.replyId, idempotentReplay: readOptionalBool(body.idempotentReplay) };
  }
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker support reply HTTP ${status}`,
    code: readOptionalString(body.code)
  };
}

export async function callMiningWorkerSupportAdminReply(args: {
  replyId: string;
  ticketId: string;
  adminUserId: number;
  message: string;
  attachmentsJson: string;
  createdAt: number;
}): Promise<MiningWorkerSupportAdminReplyResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_ADMIN_REPLY_PATH,
    {
      replyId: args.replyId,
      ticketId: args.ticketId,
      adminUserId: args.adminUserId,
      message: args.message,
      attachmentsJson: args.attachmentsJson,
      createdAt: args.createdAt
    },
    MINING_WORKER_SUPPORT_TIMEOUT_MS,
    'support admin reply'
  );
  if (body.ok === true && typeof body.id === 'string' && body.id.length > 0) {
    return { ok: true, id: body.id };
  }
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker support admin reply HTTP ${status}`,
    code: readOptionalString(body.code)
  };
}

export type MiningWorkerChatRow = {
  id: string;
  userId: number;
  usernameSnapshot: string;
  body: string;
  createdAt: number;
  channel: string;
  kind: string | null;
  audioUrl: string | null;
  durationMs: number | null;
  editedAt: number | null;
  deletedAt: number | null;
};

function readOptionalFiniteNumber(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function readChatRow(raw: unknown): MiningWorkerChatRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' && typeof o.id !== 'number' && typeof o.id !== 'bigint') return null;
  const userId = typeof o.userId === 'number' ? o.userId : Number(o.userId);
  const createdAt = typeof o.createdAt === 'number' ? o.createdAt : Number(o.createdAt);
  if (!Number.isFinite(userId) || !Number.isFinite(createdAt)) return null;
  return {
    id: String(o.id),
    userId,
    usernameSnapshot: typeof o.usernameSnapshot === 'string' ? o.usernameSnapshot : '',
    body: typeof o.body === 'string' ? o.body : '',
    createdAt,
    channel: typeof o.channel === 'string' ? o.channel : '',
    kind: typeof o.kind === 'string' ? o.kind : null,
    audioUrl: typeof o.audioUrl === 'string' ? o.audioUrl : null,
    durationMs: readOptionalFiniteNumber(o.durationMs),
    editedAt: readOptionalFiniteNumber(o.editedAt),
    deletedAt: readOptionalFiniteNumber(o.deletedAt)
  };
}

export type MiningWorkerChatInsertResult =
  | { ok: true; row: MiningWorkerChatRow }
  | { ok: false; error: string; code?: string };

export type MiningWorkerChatEditResult =
  | { ok: true; row: MiningWorkerChatRow }
  | { ok: false; error: string; code?: string };

export type MiningWorkerChatDeleteResult =
  | { ok: true; id: string; channel: string; deletedAt: number }
  | { ok: false; error: string; code?: string };

export async function callMiningWorkerChatInsert(args: {
  userId: number;
  username: string;
  body: string;
  channel: string;
  createdAt: number;
  kind: string;
  audioUrl: string | null;
  durationMs: number | null;
}): Promise<MiningWorkerChatInsertResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_CHAT_INSERT_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'chat insert'
  );
  const row = readChatRow(body.row);
  if (body.ok === true && row) return { ok: true, row };
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker chat insert HTTP ${status}`,
    code: readOptionalString(body.code)
  };
}

export async function callMiningWorkerChatEdit(args: {
  messageId: string;
  body: string;
  editedAt: number;
}): Promise<MiningWorkerChatEditResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_CHAT_EDIT_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'chat edit'
  );
  const row = readChatRow(body.row);
  if (body.ok === true && row) return { ok: true, row };
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker chat edit HTTP ${status}`,
    code: readOptionalString(body.code)
  };
}

export async function callMiningWorkerChatDelete(args: {
  messageId: string;
  deletedAt: number;
}): Promise<MiningWorkerChatDeleteResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_CHAT_DELETE_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'chat delete'
  );
  const deletedAt = readOptionalFiniteNumber(body.deletedAt);
  if (body.ok === true && typeof body.id === 'string' && typeof body.channel === 'string' && deletedAt != null) {
    return { ok: true, id: body.id, channel: body.channel, deletedAt };
  }
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker chat delete HTTP ${status}`,
    code: readOptionalString(body.code)
  };
}

export type MiningWorkerAnnouncementRow = {
  id: string;
  title: string;
  message: string;
  link: string | null;
  imageUrl: string | null;
  isActive: number;
  priority: number;
  startsAt: number | null;
  endsAt: number | null;
  createdAt: number;
  createdBy: number | null;
};

function readAnnouncementRow(raw: unknown): MiningWorkerAnnouncementRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.title !== 'string' || typeof o.message !== 'string') return null;
  const createdAt = typeof o.createdAt === 'number' ? o.createdAt : Number(o.createdAt);
  const priority = typeof o.priority === 'number' ? o.priority : Number(o.priority);
  const isActive = typeof o.isActive === 'number' ? o.isActive : Number(o.isActive);
  if (!Number.isFinite(createdAt) || !Number.isFinite(priority) || !Number.isFinite(isActive)) return null;
  const createdByRaw = o.createdBy == null ? null : typeof o.createdBy === 'number' ? o.createdBy : Number(o.createdBy);
  return {
    id: o.id,
    title: o.title,
    message: o.message,
    link: typeof o.link === 'string' ? o.link : null,
    imageUrl: typeof o.imageUrl === 'string' ? o.imageUrl : null,
    isActive,
    priority,
    startsAt: readOptionalFiniteNumber(o.startsAt),
    endsAt: readOptionalFiniteNumber(o.endsAt),
    createdAt,
    createdBy: createdByRaw != null && Number.isFinite(createdByRaw) ? createdByRaw : null
  };
}

export type MiningWorkerAnnouncementWriteResult =
  | { ok: true; row?: MiningWorkerAnnouncementRow; readCount?: number; deleted?: boolean }
  | { ok: false; error: string; code?: string };

export async function callMiningWorkerAnnouncementCreate(args: {
  id: string;
  title: string;
  message: string;
  link: string | null;
  imageUrl: string | null;
  isActive: boolean;
  priority: number;
  startsAt: number | null;
  endsAt: number | null;
  createdAt: number;
  createdBy: number | null;
}): Promise<MiningWorkerAnnouncementWriteResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_ANNOUNCEMENT_CREATE_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'announcement create'
  );
  const row = readAnnouncementRow(body.row);
  if (body.ok === true && row) {
    return { ok: true, row, readCount: 0 };
  }
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker announcement create HTTP ${status}`,
    code: readOptionalString(body.code)
  };
}

export async function callMiningWorkerAnnouncementUpdate(args: {
  id: string;
  title: string;
  message: string;
  link: string | null;
  imageUrl: string | null;
  isActive: boolean;
  priority: number;
  startsAt: number | null;
  endsAt: number | null;
}): Promise<MiningWorkerAnnouncementWriteResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_ANNOUNCEMENT_UPDATE_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'announcement update'
  );
  const row = readAnnouncementRow(body.row);
  const readCount = readOptionalFiniteNumber(body.readCount);
  if (body.ok === true && row) {
    return { ok: true, row, readCount: readCount ?? 0 };
  }
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker announcement update HTTP ${status}`,
    code: readOptionalString(body.code)
  };
}

export async function callMiningWorkerAnnouncementDelete(id: string): Promise<MiningWorkerAnnouncementWriteResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_ANNOUNCEMENT_DELETE_PATH,
    { id },
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'announcement delete'
  );
  if (body.ok === true) {
    return { ok: true, deleted: true };
  }
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker announcement delete HTTP ${status}`,
    code: readOptionalString(body.code)
  };
}

export async function callMiningWorkerAnnouncementMarkRead(args: {
  userId: number;
  announcementId: string;
  readAt: number;
}): Promise<MiningWorkerAnnouncementWriteResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_ANNOUNCEMENT_MARK_READ_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'announcement mark-read'
  );
  if (body.ok === true) {
    return { ok: true };
  }
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker announcement mark-read HTTP ${status}`,
    code: readOptionalString(body.code)
  };
}

function requireOk(body: Record<string, unknown>, status: number, label: string): void {
  if (body.ok === true) return;
  throw new Error(readOptionalString(body.error) ?? `mining worker ${label} HTTP ${status}`);
}

function readRequiredArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

export type MiningWorkerSupportSummary = {
  id: string;
  subject: string;
  status: string;
  createdAt: number;
  adminReplyCount: number;
  lastAdminAt: number;
  lastPlayerAt: number;
};

function readSupportSummary(raw: unknown): MiningWorkerSupportSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.subject !== 'string' || typeof o.status !== 'string') return null;
  return {
    id: o.id,
    subject: o.subject,
    status: o.status,
    createdAt: readFiniteNumber(o.createdAt),
    adminReplyCount: readFiniteNumber(o.adminReplyCount),
    lastAdminAt: readFiniteNumber(o.lastAdminAt),
    lastPlayerAt: readFiniteNumber(o.lastPlayerAt)
  };
}

export type MiningWorkerSupportTicketDetail = {
  id: string;
  userId: number;
  subject: string;
  message: string;
  attachments: unknown;
  status: string;
  createdAt: number;
};

function readSupportTicketDetail(raw: unknown): MiningWorkerSupportTicketDetail | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.subject !== 'string' || typeof o.message !== 'string' || typeof o.status !== 'string') {
    return null;
  }
  const userId = readFiniteNumber(o.userId);
  return {
    id: o.id,
    userId,
    subject: o.subject,
    message: o.message,
    attachments: o.attachments ?? [],
    status: o.status,
    createdAt: readFiniteNumber(o.createdAt)
  };
}

export type MiningWorkerSupportAdminReply = {
  id: string;
  ticketId?: string;
  adminUserId?: number;
  message: string;
  attachments: unknown;
  createdAt: number;
  adminUsername: string;
};

function readSupportAdminReply(raw: unknown): MiningWorkerSupportAdminReply | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.message !== 'string') return null;
  return {
    id: o.id,
    ticketId: typeof o.ticketId === 'string' ? o.ticketId : undefined,
    adminUserId: o.adminUserId == null ? undefined : readFiniteNumber(o.adminUserId),
    message: o.message,
    attachments: o.attachments ?? [],
    createdAt: readFiniteNumber(o.createdAt),
    adminUsername: typeof o.adminUsername === 'string' ? o.adminUsername : ''
  };
}

export type MiningWorkerSupportPlayerReply = {
  id: string;
  ticketId?: string;
  message: string;
  attachments: unknown;
  createdAt: number;
};

function readSupportPlayerReply(raw: unknown): MiningWorkerSupportPlayerReply | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.message !== 'string') return null;
  return {
    id: o.id,
    ticketId: typeof o.ticketId === 'string' ? o.ticketId : undefined,
    message: o.message,
    attachments: o.attachments ?? [],
    createdAt: readFiniteNumber(o.createdAt)
  };
}

export type MiningWorkerSupportAdminTicket = MiningWorkerSupportTicketDetail & {
  username: string;
  email: string;
};

function readSupportAdminTicket(raw: unknown): MiningWorkerSupportAdminTicket | null {
  const base = readSupportTicketDetail(raw);
  if (!base || !raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    ...base,
    username: typeof o.username === 'string' ? o.username : '',
    email: typeof o.email === 'string' ? o.email : ''
  };
}

export type MiningWorkerSupportHistorySummary = {
  id: string;
  subject: string;
  status: string;
  message: string;
  attachments: unknown;
  createdAt: number;
  messageCount: number;
  lastMessageAt: number;
  lastAdminUsername: string | null;
};

function readSupportHistorySummary(raw: unknown): MiningWorkerSupportHistorySummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.subject !== 'string' || typeof o.status !== 'string' || typeof o.message !== 'string') {
    return null;
  }
  return {
    id: o.id,
    subject: o.subject,
    status: o.status,
    message: o.message,
    attachments: o.attachments ?? [],
    createdAt: readFiniteNumber(o.createdAt),
    messageCount: readFiniteNumber(o.messageCount),
    lastMessageAt: readFiniteNumber(o.lastMessageAt),
    lastAdminUsername: typeof o.lastAdminUsername === 'string' ? o.lastAdminUsername : null
  };
}

function mapSummaries(raw: unknown): MiningWorkerSupportSummary[] {
  return readRequiredArray(raw).map(readSupportSummary).filter((r): r is MiningWorkerSupportSummary => r != null);
}

function mapAdminReplies(raw: unknown): MiningWorkerSupportAdminReply[] {
  return readRequiredArray(raw).map(readSupportAdminReply).filter((r): r is MiningWorkerSupportAdminReply => r != null);
}

function mapPlayerReplies(raw: unknown): MiningWorkerSupportPlayerReply[] {
  return readRequiredArray(raw).map(readSupportPlayerReply).filter((r): r is MiningWorkerSupportPlayerReply => r != null);
}

export async function callMiningWorkerSupportListMine(args: {
  userId: number;
  limit?: number;
  cursorCreatedAt?: number;
}): Promise<{ ok: true; summaries: MiningWorkerSupportSummary[] }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_LIST_MINE_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'support list-mine'
  );
  requireOk(body, status, 'support list-mine');
  return { ok: true, summaries: mapSummaries(body.summaries) };
}

export type MiningWorkerSupportGetResult =
  | {
      ok: true;
      ticket: MiningWorkerSupportTicketDetail;
      adminReplies: MiningWorkerSupportAdminReply[];
      playerReplies: MiningWorkerSupportPlayerReply[];
    }
  | { ok: false; error: string; code?: string };

export async function callMiningWorkerSupportGet(args: {
  userId: number;
  ticketId: string;
}): Promise<MiningWorkerSupportGetResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_GET_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'support get'
  );
  if (status === HTTP_NOT_FOUND || readOptionalString(body.code) === 'NOT_FOUND') {
    return {
      ok: false,
      error: readOptionalString(body.error) ?? 'Ticket não encontrado.',
      code: 'NOT_FOUND'
    };
  }
  const ticket = readSupportTicketDetail(body.ticket);
  if (body.ok === true && ticket) {
    return {
      ok: true,
      ticket,
      adminReplies: mapAdminReplies(body.adminReplies),
      playerReplies: mapPlayerReplies(body.playerReplies)
    };
  }
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker support get HTTP ${status}`,
    code: readOptionalString(body.code)
  };
}

export async function callMiningWorkerSupportState(args: {
  userId: number;
  limit?: number;
  cursorCreatedAt?: number;
}): Promise<{ ok: true; email: string | null; username: string | null; summaries: MiningWorkerSupportSummary[] }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_STATE_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'support state'
  );
  requireOk(body, status, 'support state');
  return {
    ok: true,
    email: typeof body.email === 'string' ? body.email : null,
    username: typeof body.username === 'string' ? body.username : null,
    summaries: mapSummaries(body.summaries)
  };
}

export async function callMiningWorkerSupportArchive(args: {
  userId: number;
  ticketId: string;
}): Promise<{ ok: true; updated: number }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_ARCHIVE_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'support archive'
  );
  requireOk(body, status, 'support archive');
  return { ok: true, updated: readFiniteNumber(body.updated) };
}

export async function callMiningWorkerSupportReopen(args: {
  userId: number;
  ticketId: string;
}): Promise<{ ok: true; updated: number }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_REOPEN_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'support reopen'
  );
  requireOk(body, status, 'support reopen');
  return { ok: true, updated: readFiniteNumber(body.updated) };
}

export async function callMiningWorkerSupportAdminList(args: {
  limit?: number;
  ticketIds?: string[];
}): Promise<{
  ok: true;
  tickets: MiningWorkerSupportAdminTicket[];
  adminReplies: MiningWorkerSupportAdminReply[];
  playerReplies: MiningWorkerSupportPlayerReply[];
}> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_ADMIN_LIST_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'support admin list'
  );
  requireOk(body, status, 'support admin list');
  return {
    ok: true,
    tickets: readRequiredArray(body.tickets)
      .map(readSupportAdminTicket)
      .filter((r): r is MiningWorkerSupportAdminTicket => r != null),
    adminReplies: mapAdminReplies(body.adminReplies),
    playerReplies: mapPlayerReplies(body.playerReplies)
  };
}

export type MiningWorkerSupportAdminGetResult =
  | {
      ok: true;
      ticket: MiningWorkerSupportAdminTicket;
      adminReplies: MiningWorkerSupportAdminReply[];
      playerReplies: MiningWorkerSupportPlayerReply[];
    }
  | { ok: false; error: string; code?: string };

export async function callMiningWorkerSupportAdminGet(ticketId: string): Promise<MiningWorkerSupportAdminGetResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_ADMIN_GET_PATH,
    { ticketId },
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'support admin get'
  );
  if (status === HTTP_NOT_FOUND || readOptionalString(body.code) === 'NOT_FOUND') {
    return {
      ok: false,
      error: readOptionalString(body.error) ?? 'Ticket não encontrado.',
      code: 'NOT_FOUND'
    };
  }
  const ticket = readSupportAdminTicket(body.ticket);
  if (body.ok === true && ticket) {
    return {
      ok: true,
      ticket,
      adminReplies: mapAdminReplies(body.adminReplies),
      playerReplies: mapPlayerReplies(body.playerReplies)
    };
  }
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker support admin get HTTP ${status}`,
    code: readOptionalString(body.code)
  };
}

export async function callMiningWorkerSupportAdminHistory(args: {
  userId: number;
  limit?: number;
  offset?: number;
}): Promise<{ ok: true; summaries: MiningWorkerSupportHistorySummary[] }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_ADMIN_HISTORY_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'support admin history'
  );
  requireOk(body, status, 'support admin history');
  return {
    ok: true,
    summaries: readRequiredArray(body.summaries)
      .map(readSupportHistorySummary)
      .filter((r): r is MiningWorkerSupportHistorySummary => r != null)
  };
}

export async function callMiningWorkerSupportAdminStats(userId: number): Promise<{
  ok: true;
  total: number;
  openCount: number;
  archivedCount: number;
  lastTicketAt: number;
}> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_ADMIN_STATS_PATH,
    { userId },
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'support admin stats'
  );
  requireOk(body, status, 'support admin stats');
  return {
    ok: true,
    total: readFiniteNumber(body.total),
    openCount: readFiniteNumber(body.openCount),
    archivedCount: readFiniteNumber(body.archivedCount),
    lastTicketAt: readFiniteNumber(body.lastTicketAt)
  };
}

export async function callMiningWorkerChatHistory(args: {
  channel: string;
  limit?: number;
  nowMs?: number;
}): Promise<{ ok: true; rows: MiningWorkerChatRow[] }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_CHAT_HISTORY_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'chat history'
  );
  requireOk(body, status, 'chat history');
  const rows: MiningWorkerChatRow[] = [];
  for (const raw of readRequiredArray(body.rows)) {
    const row = readChatRow(raw);
    if (row) rows.push(row);
  }
  return { ok: true, rows };
}

export type MiningWorkerChatGetRow = {
  id: string;
  userId: number;
  channel: string;
  kind: string | null;
  deletedAt: number | null;
};

export async function callMiningWorkerChatGet(messageId: string): Promise<{ ok: true; row: MiningWorkerChatGetRow | null }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_CHAT_GET_PATH,
    { messageId },
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'chat get'
  );
  requireOk(body, status, 'chat get');
  if (body.row == null) return { ok: true, row: null };
  if (!body.row || typeof body.row !== 'object') {
    throw new Error('mining worker chat get invalid row');
  }
  const o = body.row as Record<string, unknown>;
  if (typeof o.id !== 'string' && typeof o.id !== 'number' && typeof o.id !== 'bigint') {
    throw new Error('mining worker chat get invalid row');
  }
  return {
    ok: true,
    row: {
      id: String(o.id),
      userId: readFiniteNumber(o.userId),
      channel: typeof o.channel === 'string' ? o.channel : '',
      kind: typeof o.kind === 'string' ? o.kind : null,
      deletedAt: readOptionalFiniteNumber(o.deletedAt)
    }
  };
}

export async function callMiningWorkerChatSender(
  userId: number
): Promise<{ ok: true; username: string; isBlocked: boolean } | { ok: true; username: null; isBlocked: null }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_CHAT_SENDER_PATH,
    { userId },
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'chat sender'
  );
  requireOk(body, status, 'chat sender');
  if (typeof body.username !== 'string') {
    return { ok: true, username: null, isBlocked: null };
  }
  return { ok: true, username: body.username, isBlocked: body.isBlocked === true };
}

export type MiningWorkerChatPeerRow = {
  ownerUserId: number;
  managerUserId: number;
  ownerUsername: string | null;
  managerUsername: string | null;
};

export async function callMiningWorkerChatPeers(userId: number): Promise<{ ok: true; rows: MiningWorkerChatPeerRow[] }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_CHAT_PEERS_PATH,
    { userId },
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'chat peers'
  );
  requireOk(body, status, 'chat peers');
  const rows: MiningWorkerChatPeerRow[] = [];
  for (const raw of readRequiredArray(body.rows)) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    rows.push({
      ownerUserId: readFiniteNumber(o.ownerUserId),
      managerUserId: readFiniteNumber(o.managerUserId),
      ownerUsername: typeof o.ownerUsername === 'string' ? o.ownerUsername : null,
      managerUsername: typeof o.managerUsername === 'string' ? o.managerUsername : null
    });
  }
  return { ok: true, rows };
}

export type MiningWorkerChatMentionUser = { userId: number; username: string };

function readMentionUsers(raw: unknown): MiningWorkerChatMentionUser[] {
  const out: MiningWorkerChatMentionUser[] = [];
  for (const item of readRequiredArray(raw)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const userId = readFiniteNumber(o.userId);
    const username = typeof o.username === 'string' ? o.username : '';
    if (userId > 0 && username) out.push({ userId, username });
  }
  return out;
}

export async function callMiningWorkerChatMentionsSearch(args: {
  query: string;
  limit?: number;
  excludeUserId?: number;
}): Promise<{ ok: true; users: MiningWorkerChatMentionUser[] }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_CHAT_MENTIONS_SEARCH_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'chat mentions-search'
  );
  requireOk(body, status, 'chat mentions-search');
  return { ok: true, users: readMentionUsers(body.users) };
}

export async function callMiningWorkerChatMentionsResolve(
  tokens: string[]
): Promise<{ ok: true; users: MiningWorkerChatMentionUser[] }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_CHAT_MENTIONS_RESOLVE_PATH,
    { tokens },
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'chat mentions-resolve'
  );
  requireOk(body, status, 'chat mentions-resolve');
  return { ok: true, users: readMentionUsers(body.users) };
}

export async function callMiningWorkerAnnouncementPending(args: {
  userId: number;
  nowMs?: number;
}): Promise<{ ok: true; rows: MiningWorkerAnnouncementRow[] }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_ANNOUNCEMENT_PENDING_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'announcement pending'
  );
  requireOk(body, status, 'announcement pending');
  const rows: MiningWorkerAnnouncementRow[] = [];
  for (const raw of readRequiredArray(body.rows)) {
    const row = readAnnouncementRow(raw);
    if (row) rows.push(row);
  }
  return { ok: true, rows };
}

export async function callMiningWorkerAnnouncementMiniBlog(args: {
  userId: number;
  nowMs?: number;
}): Promise<{ ok: true; rows: MiningWorkerAnnouncementRow[] }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_ANNOUNCEMENT_MINI_BLOG_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'announcement mini-blog'
  );
  requireOk(body, status, 'announcement mini-blog');
  const rows: MiningWorkerAnnouncementRow[] = [];
  for (const raw of readRequiredArray(body.rows)) {
    const row = readAnnouncementRow(raw);
    if (row) rows.push(row);
  }
  return { ok: true, rows };
}

export type MiningWorkerAnnouncementAdminListItem = MiningWorkerAnnouncementRow & { readCount: number };

export async function callMiningWorkerAnnouncementAdminList(): Promise<{
  ok: true;
  rows: MiningWorkerAnnouncementAdminListItem[];
}> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_ANNOUNCEMENT_ADMIN_LIST_PATH,
    {},
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'announcement admin-list'
  );
  requireOk(body, status, 'announcement admin-list');
  const rows: MiningWorkerAnnouncementAdminListItem[] = [];
  for (const raw of readRequiredArray(body.rows)) {
    const row = readAnnouncementRow(raw);
    if (!row || !raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    rows.push({ ...row, readCount: readFiniteNumber(o.readCount) });
  }
  return { ok: true, rows };
}

export async function callMiningWorkerAnnouncementGet(id: string): Promise<MiningWorkerAnnouncementWriteResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_ANNOUNCEMENT_GET_PATH,
    { id },
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'announcement get'
  );
  const row = readAnnouncementRow(body.row);
  const readCount = readOptionalFiniteNumber(body.readCount);
  if (body.ok === true && row) {
    return { ok: true, row, readCount: readCount ?? 0 };
  }
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker announcement get HTTP ${status}`,
    code: readOptionalString(body.code)
  };
}

export async function callMiningWorkerChatCanAccess(args: {
  userId: number;
  channel: string;
}): Promise<{ allowed: boolean }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_CHAT_CAN_ACCESS_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'chat can-access'
  );
  requireOk(body, status, 'chat can-access');
  return { allowed: body.allowed === true };
}

export async function callMiningWorkerChatRateLimit(args: {
  userId: number;
  nowMs?: number;
}): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_CHAT_RATE_LIMIT_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'chat rate-limit'
  );
  if (body.ok === true) return { ok: true };
  const retry = readOptionalFiniteNumber(body.retryAfterMs);
  if (status >= HTTP_SERVER_ERROR_FLOOR) {
    throw new Error(readOptionalString(body.error) ?? `mining worker chat rate-limit HTTP ${status}`);
  }
  return { ok: false, retryAfterMs: retry != null && retry > 0 ? retry : 1 };
}

export async function callMiningWorkerChatPresence(args: {
  action: 'join' | 'leave' | 'count';
  channel: string;
  socketId?: string;
}): Promise<{ online: number }> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_CHAT_PRESENCE_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'chat presence'
  );
  if (body.ok !== true) {
    if (readOptionalString(body.code) === 'UNAVAILABLE') {
      return { online: 0 };
    }
    throw new Error(readOptionalString(body.error) ?? `mining worker chat presence HTTP ${status}`);
  }
  const online = readOptionalFiniteNumber(body.online);
  return { online: online != null && online >= 0 ? online : 0 };
}

export async function callMiningWorkerSupportTicketForPlayer(ticketId: string): Promise<{
  id: string;
  user_id: number;
  status: string;
} | null> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_TICKET_FOR_PLAYER_PATH,
    { ticketId },
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'support ticket-for-player'
  );
  requireOk(body, status, 'support ticket-for-player');
  if (!body.ticket || typeof body.ticket !== 'object') return null;
  const t = body.ticket as Record<string, unknown>;
  const userId = typeof t.userId === 'number' ? t.userId : Number(t.userId);
  if (typeof t.id !== 'string' || !Number.isFinite(userId) || typeof t.status !== 'string') return null;
  return { id: t.id, user_id: userId, status: t.status };
}

export async function callMiningWorkerSupportAttachmentReferenced(args: {
  ticketId: string;
  storedName: string;
}): Promise<boolean> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_SUPPORT_ATTACHMENT_REFERENCED_PATH,
    args,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'support attachment-referenced'
  );
  requireOk(body, status, 'support attachment-referenced');
  return body.referenced === true;
}

export type MiningWorkerAssertActiveResult =
  | { ok: true }
  | { ok: false; status: number; error: string; code: string };

export async function callMiningWorkerAssertActiveUser(userId: number): Promise<MiningWorkerAssertActiveResult> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_USERS_ASSERT_ACTIVE_PATH,
    { userId },
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'users assert-active'
  );
  if (body.ok === true) return { ok: true };
  return {
    ok: false,
    status,
    error: readOptionalString(body.error) ?? 'Account check failed.',
    code: readOptionalString(body.code) ?? 'FORBIDDEN'
  };
}

export type MiningWorkerUploadResult =
  | { ok: true; storedName: string; publicUrl: string }
  | { ok: false; error: string; code?: string; status: number };

function readUploadResult(status: number, body: Record<string, unknown>, label: string): MiningWorkerUploadResult {
  if (body.ok === true && typeof body.storedName === 'string' && typeof body.publicUrl === 'string') {
    return { ok: true, storedName: body.storedName, publicUrl: body.publicUrl };
  }
  return {
    ok: false,
    error: readOptionalString(body.error) ?? `mining worker ${label} HTTP ${status}`,
    code: readOptionalString(body.code),
    status
  };
}

function uint8ToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function appendUploadFile(form: FormData, field: string, bytes: Uint8Array, filename: string): void {
  form.append(field, new Blob([uint8ToArrayBuffer(bytes)]), filename);
}

export async function callMiningWorkerUploadChatAudio(args: {
  buffer: Uint8Array;
  originalName: string;
  mime: string;
}): Promise<MiningWorkerUploadResult> {
  const form = new FormData();
  appendUploadFile(form, 'audio', args.buffer, args.originalName || 'audio.webm');
  form.append('originalName', args.originalName);
  form.append('mime', args.mime);
  const { status, body } = await postMiningWorkerMultipart(
    MINING_WORKER_UPLOAD_CHAT_AUDIO_PATH,
    form,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'upload chat-audio'
  );
  return readUploadResult(status, body, 'upload chat-audio');
}

export async function callMiningWorkerUploadSupportAttachment(args: {
  buffer: Uint8Array;
  originalName: string;
  mime: string;
  userId: number;
  namePrefix: 'support' | 'support-reply';
}): Promise<MiningWorkerUploadResult> {
  const form = new FormData();
  appendUploadFile(form, 'file', args.buffer, args.originalName || 'file.bin');
  form.append('originalName', args.originalName);
  form.append('mime', args.mime);
  form.append('userId', String(args.userId));
  form.append('namePrefix', args.namePrefix);
  const { status, body } = await postMiningWorkerMultipart(
    MINING_WORKER_UPLOAD_SUPPORT_ATTACHMENT_PATH,
    form,
    MINING_WORKER_SUPPORT_TIMEOUT_MS,
    'upload support-attachment'
  );
  return readUploadResult(status, body, 'upload support-attachment');
}

function readFiniteNumber(raw: unknown, fallback = 0): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readCalculatorRows(raw: unknown): PlayerCalculatorSnapshot['coins'][number]['rows'] {
  if (!Array.isArray(raw)) return [];
  const out: PlayerCalculatorSnapshot['coins'][number]['rows'] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const label = typeof o.label === 'string' ? o.label : '';
    if (!label) continue;
    out.push({
      label,
      coins: readFiniteNumber(o.coins),
      usd: readFiniteNumber(o.usd)
    });
  }
  return out;
}

function readCalculatorSnapshot(body: Record<string, unknown>): PlayerCalculatorSnapshot | null {
  if (typeof body.scope !== 'string' || !body.scope.trim()) return null;
  if (!Array.isArray(body.scopesUi) || !Array.isArray(body.coinComparisons) || !Array.isArray(body.coins)) {
    return null;
  }
  const scopesUi: PlayerCalculatorSnapshot['scopesUi'] = [];
  for (const x of body.scopesUi) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (id && name) scopesUi.push({ id, name });
  }
  const coinComparisons: PlayerCalculatorSnapshot['coinComparisons'] = [];
  for (const x of body.coinComparisons) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!id) continue;
    coinComparisons.push({
      id,
      symbol: typeof o.symbol === 'string' ? o.symbol : id,
      name: typeof o.name === 'string' ? o.name : id,
      priceUSD: readFiniteNumber(o.priceUSD),
      isActivelyMining: o.isActivelyMining === true,
      dailyCoins: readFiniteNumber(o.dailyCoins),
      dailyUsd: readFiniteNumber(o.dailyUsd),
      projection30Usd: readFiniteNumber(o.projection30Usd),
      rows: readCalculatorRows(o.rows)
    });
  }
  const coins: PlayerCalculatorSnapshot['coins'] = [];
  for (const x of body.coins) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!id) continue;
    const blockHistory: PlayerCalculatorSnapshot['coins'][number]['blockHistory'] = [];
    if (Array.isArray(o.blockHistory)) {
      for (const h of o.blockHistory) {
        if (!h || typeof h !== 'object') continue;
        const item = h as Record<string, unknown>;
        const entryId =
          typeof item.id === 'string'
            ? item.id
            : typeof item.id === 'number' || typeof item.id === 'bigint'
              ? String(item.id)
              : '';
        if (!entryId) continue;
        blockHistory.push({
          id: entryId,
          roomId: typeof item.roomId === 'string' && item.roomId.trim() ? item.roomId.trim() : null,
          windowStartMs: readFiniteNumber(item.windowStartMs),
          windowEndMs: readFiniteNumber(item.windowEndMs),
          creditedBlocks: readFiniteNumber(item.creditedBlocks),
          amountCoins: readFiniteNumber(item.amountCoins),
          amountUsd: readFiniteNumber(item.amountUsd),
          userHashHps: readFiniteNumber(item.userHashHps),
          networkHashrate: readFiniteNumber(item.networkHashrate),
          blockReward: readFiniteNumber(item.blockReward),
          blockTime: readFiniteNumber(item.blockTime)
        });
      }
    }
    coins.push({
      id,
      symbol: typeof o.symbol === 'string' ? o.symbol : id,
      name: typeof o.name === 'string' ? o.name : id,
      priceUSD: readFiniteNumber(o.priceUSD),
      networkHashrate: readFiniteNumber(o.networkHashrate),
      blockReward: readFiniteNumber(o.blockReward),
      blockTime: readFiniteNumber(o.blockTime),
      userPowerHps: readFiniteNumber(o.userPowerHps),
      dailyCoins: readFiniteNumber(o.dailyCoins),
      dailyUsd: readFiniteNumber(o.dailyUsd),
      projection30Usd: readFiniteNumber(o.projection30Usd),
      nftRoomOnly: o.nftRoomOnly === true,
      independentPool: o.independentPool === true,
      rows: readCalculatorRows(o.rows),
      blockHistory
    });
  }
  return {
    scope: body.scope.trim(),
    scopesUi,
    generalPowerHps: readFiniteNumber(body.generalPowerHps),
    coinComparisons,
    coins
  };
}

/**
 * Fail-closed calculator snapshot via mining worker (`POST /v1/calculator/snapshot`).
 * Unset URL throws (same as chat/support). 403 FORBIDDEN_SCOPE / 422 INVALID_SCOPE
 * rethrow as `HttpControlledError` — same contract as GET `/api/calculator/me`.
 */
export async function callMiningWorkerCalculatorSnapshot(
  userId: number,
  scope?: string
): Promise<PlayerCalculatorSnapshot> {
  const { status, body } = await postMiningWorkerJson(
    MINING_WORKER_CALCULATOR_SNAPSHOT_PATH,
    { userId, ...(scope != null ? { scope } : {}) },
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    'calculator snapshot'
  );
  const code = readOptionalString(body.code);
  if (status === HTTP_UNPROCESSABLE_ENTITY || code === 'INVALID_SCOPE') {
    throw new HttpControlledError(HTTP_UNPROCESSABLE_ENTITY, {
      error: readOptionalString(body.error) ?? 'Invalid scope parameter.',
      code: 'INVALID_SCOPE'
    });
  }
  if (status === HTTP_FORBIDDEN || code === 'FORBIDDEN_SCOPE') {
    throw new HttpControlledError(HTTP_FORBIDDEN, {
      error: readOptionalString(body.error) ?? 'No access to this room.',
      code: 'FORBIDDEN_SCOPE'
    });
  }
  if (body.ok !== true) {
    throw new Error(
      readOptionalString(body.error) ?? `mining worker calculator snapshot HTTP ${status}`
    );
  }
  const snap = readCalculatorSnapshot(body);
  if (!snap) {
    throw new Error('mining worker calculator snapshot invalid body');
  }
  return snap;
}

async function callMiningRead(
  path: string,
  payload: unknown,
  label: string
): Promise<Record<string, unknown>> {
  const { status, body } = await postMiningWorkerJson(
    path,
    payload,
    MINING_WORKER_PROGRESS_TIMEOUT_MS,
    label
  );
  if (status === HTTP_OK && body.ok === true) return body;
  if (status === HTTP_CONFLICT || body.code === 'PREMIUM_COOLDOWN' || body.code === 'CHECKIN_PREMIUM_COOLDOWN') {
    throw new HttpControlledError(HTTP_CONFLICT, body);
  }
  if (status === HTTP_NOT_FOUND) {
    throw new HttpControlledError(HTTP_NOT_FOUND, body);
  }
  throw new Error(readOptionalString(body.error) ?? `mining worker ${label} HTTP ${status}`);
}

export async function callCheckinStatus(payload: {
  userId: number;
  nowMs?: number;
}): Promise<Record<string, unknown>> {
  return callMiningRead(MINING_WORKER_CHECKIN_STATUS_PATH, payload, 'checkin status');
}

export async function callCheckinPerform(payload: {
  userId: number;
  nowMs?: number;
}): Promise<Record<string, unknown>> {
  return callMiningRead(MINING_WORKER_CHECKIN_PERFORM_PATH, payload, 'checkin perform');
}

export async function callQuestsState(payload: {
  userId: number;
  nowMs?: number;
}): Promise<Record<string, unknown>> {
  return callMiningRead(MINING_WORKER_QUESTS_STATE_PATH, payload, 'quests state');
}

export async function callPlayerGameHeader(payload: { userId: number }): Promise<Record<string, unknown>> {
  return callMiningRead(MINING_WORKER_HEADER_PATH, payload, 'player-game header');
}

export async function callPlayerGameNav(payload: {
  userId: number;
  managing?: boolean;
}): Promise<Record<string, unknown>> {
  return callMiningRead(MINING_WORKER_NAV_PATH, payload, 'player-game nav');
}

export async function callDisplayLabels(): Promise<Record<string, unknown>> {
  return callMiningRead(MINING_WORKER_DISPLAY_LABELS_PATH, {}, 'display-labels');
}

export async function callProfileState(payload: {
  userId: number;
  inviteBaseUrl?: string;
}): Promise<Record<string, unknown>> {
  return callMiningRead(MINING_WORKER_PROFILE_STATE_PATH, payload, 'profile state');
}
