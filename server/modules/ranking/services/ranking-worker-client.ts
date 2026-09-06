/**
 * Thin HTTP client for `genesis-mining-worker` ranking endpoints.
 *
 * When `GENESIS_MINING_WORKER_URL` is unset, callers keep the TS path.
 * Auth / base URL: shared with `mining-worker-client`.
 * HTTP budget: `opsConfig.jobTimeouts.publicRanking` (mirrors worker job timeout).
 */

import { opsConfig } from '../../../core/ops/config.js';
import {
  MINING_WORKER_AUTH_HEADER,
  miningWorkerAuthToken,
  miningWorkerBaseUrl
} from '../../mining-engine/services/mining-worker-client.js';

const RANKING_PUBLIC_PATH = '/v1/ranking/public';
const RANKING_ME_PATH = '/v1/ranking/me';
const RANKING_ADMIN_PATH = '/v1/ranking/admin';

/** Same budget as the worker’s public-ranking job (`JOB_TIMEOUT_PUBLIC_RANKING_MS`). */
const MINING_WORKER_RANKING_TIMEOUT_MS = opsConfig.jobTimeouts.publicRanking;

export type RankingWorkerCallError = {
  ok: false;
  error: string;
};

/** Wire shapes — keep aligned with `mining-ranking.ts` / Rust serde. */
export type RankingWorkerPublicPayload = {
  timestamp: number;
  ranking: unknown[];
  coins: unknown[];
};

export type RankingWorkerAdminPayload = {
  timestamp: number;
  ranking: unknown[];
  coins: unknown[];
};

export type RankingWorkerMePayload = {
  position: number | null;
  totalRanked: number;
  hash: number;
};

function rankingWorkerHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = miningWorkerAuthToken();
  if (token) {
    headers[MINING_WORKER_AUTH_HEADER] = token;
  }
  return headers;
}

function readWorkerError(body: unknown, status: number): string {
  if (body && typeof body === 'object' && body !== null && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === 'string' && err.trim()) return err;
  }
  return `mining worker ranking HTTP ${status}`;
}

async function rankingWorkerGetJson(url: string): Promise<{ ok: true; body: unknown } | RankingWorkerCallError> {
  if (!miningWorkerBaseUrl()) {
    return { ok: false, error: 'GENESIS_MINING_WORKER_URL unset' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MINING_WORKER_RANKING_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: rankingWorkerHeaders(),
      signal: ctrl.signal
    });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return { ok: false, error: `mining worker ranking non-JSON (${res.status})` };
      }
    }
    if (!res.ok) {
      return { ok: false, error: readWorkerError(body, res.status) };
    }
    if (body === null || typeof body !== 'object') {
      return { ok: false, error: 'mining worker ranking empty body' };
    }
    return { ok: true, body };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `mining worker ranking unreachable: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

function assertPublicPayload(body: unknown): RankingWorkerPublicPayload {
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.ranking) || !Array.isArray(obj.coins) || typeof obj.timestamp !== 'number') {
    throw new Error('mining worker ranking public: invalid payload shape');
  }
  return body as RankingWorkerPublicPayload;
}

function assertAdminPayload(body: unknown): RankingWorkerAdminPayload {
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.ranking) || !Array.isArray(obj.coins) || typeof obj.timestamp !== 'number') {
    throw new Error('mining worker ranking admin: invalid payload shape');
  }
  return body as RankingWorkerAdminPayload;
}

function assertMePayload(body: unknown): RankingWorkerMePayload {
  const obj = body as Record<string, unknown>;
  if (!('position' in obj) || typeof obj.totalRanked !== 'number' || typeof obj.hash !== 'number') {
    throw new Error('mining worker ranking me: invalid payload shape');
  }
  const position = obj.position;
  if (position !== null && typeof position !== 'number') {
    throw new Error('mining worker ranking me: invalid position');
  }
  return {
    position: position === null ? null : position,
    totalRanked: obj.totalRanked,
    hash: obj.hash
  };
}

/**
 * Delegate public ranking to the Rust worker.
 * Caller only invokes when `miningWorkerBaseUrl()` is set.
 */
export async function callRankingPublic(fresh?: boolean): Promise<RankingWorkerPublicPayload> {
  const base = miningWorkerBaseUrl();
  if (!base) {
    throw new Error('GENESIS_MINING_WORKER_URL unset');
  }
  const qs = fresh ? '?fresh=true' : '';
  const result = await rankingWorkerGetJson(`${base}${RANKING_PUBLIC_PATH}${qs}`);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return assertPublicPayload(result.body);
}

/**
 * Delegate "my global rank" to the Rust worker.
 * Caller only invokes when `miningWorkerBaseUrl()` is set.
 */
export async function callRankingMe(userId: number, fresh?: boolean): Promise<RankingWorkerMePayload> {
  const base = miningWorkerBaseUrl();
  if (!base) {
    throw new Error('GENESIS_MINING_WORKER_URL unset');
  }
  const params = new URLSearchParams();
  params.set('userId', String(userId));
  if (fresh) params.set('fresh', 'true');
  const result = await rankingWorkerGetJson(`${base}${RANKING_ME_PATH}?${params.toString()}`);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return assertMePayload(result.body);
}

/**
 * Delegate admin ranking to the Rust worker.
 * Caller only invokes when `miningWorkerBaseUrl()` is set.
 */
export async function callRankingAdmin(): Promise<RankingWorkerAdminPayload> {
  const base = miningWorkerBaseUrl();
  if (!base) {
    throw new Error('GENESIS_MINING_WORKER_URL unset');
  }
  const result = await rankingWorkerGetJson(`${base}${RANKING_ADMIN_PATH}`);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return assertAdminPayload(result.body);
}
