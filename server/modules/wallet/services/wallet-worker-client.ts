/**
 * Thin HTTP client for `genesis-wallet` (exchange / withdraw / deposit / quest / referral / offerwall / admin).
 *
 * Callers always delegate here — no TS SQL money-path fallback.
 * Unset `GENESIS_WALLET_URL` → throw / `{ ok: false, error: 'GENESIS_WALLET_URL unset' }`.
 * Auth: header `x-mining-worker-token` = `MINING_WORKER_AUTH_TOKEN` (same as mining/hardware/auth).
 */

import {
  MINING_WORKER_AUTH_HEADER,
  MINING_WORKER_PROGRESS_TIMEOUT_MS,
  miningWorkerAuthToken
} from '../../mining-engine/services/mining-worker-client.js';
import { MS_PER_SECOND } from '../../../shared/utils/time.js';

/* eslint-disable no-magic-numbers -- Rust genesis-wallet deposit_receipt.rs contracts. */
/** Rust `RPC_RECEIPT_TIMEOUT_MS`. */
export const DEPOSIT_RPC_RECEIPT_TIMEOUT_MS = 12 * MS_PER_SECOND;
/** Rust `FETCH_TIMEOUT_DEFAULT_MS`. */
export const DEPOSIT_EXPLORER_FETCH_TIMEOUT_MS = 22 * MS_PER_SECOND;
/** Primary + 3 fallbacks in Rust `build_deposit_rpc_candidates`. */
export const DEPOSIT_POLYGON_RPC_CANDIDATE_MAX = 4;
/* eslint-enable no-magic-numbers */

/** HTTP budget: Blockscout + explorer + worst-case polygon RPC candidate chain. */
export const WALLET_DEPOSIT_RESOLVE_TIMEOUT_MS =
  DEPOSIT_RPC_RECEIPT_TIMEOUT_MS +
  DEPOSIT_EXPLORER_FETCH_TIMEOUT_MS +
  DEPOSIT_POLYGON_RPC_CANDIDATE_MAX * DEPOSIT_RPC_RECEIPT_TIMEOUT_MS;

const EXCHANGE_LIQUIDATE_PATH = '/v1/wallet/exchange/liquidate';
const WITHDRAW_REQUEST_PATH = '/v1/wallet/withdraw/request';
const DEPOSIT_CREDIT_PATH = '/v1/wallet/deposit/credit';
const DEPOSIT_RESOLVE_RECEIPT_PATH = '/v1/wallet/deposit/resolve-receipt';
const QUEST_CLAIM_PATH = '/v1/wallet/quests/claim';
const REFERRAL_CREDIT_PATH = '/v1/wallet/referral/credit-on-email-verified';
const ZERADS_CREDIT_PATH = '/v1/wallet/offerwall/zerads-credit';
const ADMIN_WITHDRAWAL_STATUS_PATH = '/v1/wallet/admin/withdrawals/status';
const ADMIN_SET_COIN_BALANCE_PATH = '/v1/wallet/admin/coin-balance/set';
const ADMIN_SAVE_GAME_BALANCES_PATH = '/v1/wallet/admin/save-game-balances';
const PARTNER_YOUTUBE_APPROVE_PATH = '/v1/partners/youtube/submissions/approve';
const WALLET_STATE_PATH = '/v1/wallet/state';
const WALLET_HISTORY_PATH = '/v1/wallet/history';
const WITHDRAWALS_HISTORY_PATH = '/v1/withdrawals/history';
const DEPOSITS_HISTORY_PATH = '/v1/deposits/history';
const WEB3_SETTINGS_PATH = '/v1/web3-settings';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;

const WALLET_WORKER_UNSET_ERROR = 'GENESIS_WALLET_URL unset';

/** Domain `ok:false` from `/v1/wallet/*` — map to `HttpControlledError`. */
export class WalletWorkerError extends Error {
  readonly statusCode: number;
  readonly jsonBody: Record<string, unknown>;

  constructor(statusCode: number, jsonBody: Record<string, unknown>) {
    const message = typeof jsonBody.error === 'string' ? jsonBody.error : 'Wallet request failed';
    super(message);
    this.name = 'WalletWorkerError';
    this.statusCode = statusCode;
    this.jsonBody = jsonBody;
  }
}

export function isWalletWorkerError(e: unknown): e is WalletWorkerError {
  return e instanceof WalletWorkerError;
}

function isWalletDomainStatus(status: number): boolean {
  return (
    status === HTTP_BAD_REQUEST ||
    status === HTTP_UNAUTHORIZED ||
    status === HTTP_FORBIDDEN ||
    status === HTTP_NOT_FOUND ||
    status === HTTP_CONFLICT ||
    status === HTTP_UNPROCESSABLE
  );
}

/** Trimmed base URL or `null` when the worker is not configured. */
export function walletWorkerBaseUrl(): string | null {
  const raw = String(process.env.GENESIS_WALLET_URL ?? '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

type WalletRaw = {
  status: number;
  body: Record<string, unknown>;
};

async function postWalletRaw(path: string, payload: unknown, timeoutMs = MINING_WORKER_PROGRESS_TIMEOUT_MS): Promise<WalletRaw> {
  const base = walletWorkerBaseUrl();
  if (!base) {
    throw new Error(WALLET_WORKER_UNSET_ERROR);
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
        throw new Error(`wallet worker non-JSON (${res.status})`);
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(res.ok ? 'wallet worker empty body' : `wallet worker HTTP ${res.status}`);
    }
    return { status: res.status, body: parsed as Record<string, unknown> };
  } catch (e) {
    if (e instanceof Error && (e.message === WALLET_WORKER_UNSET_ERROR || e.message.startsWith('wallet worker'))) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`wallet worker unreachable: ${msg}`, { cause: e });
  } finally {
    clearTimeout(timer);
  }
}

function requireWalletOk(body: Record<string, unknown>, status: number, label: string): void {
  if (status === HTTP_OK && body.ok === true) return;
  if (isWalletDomainStatus(status) && body.ok === false) {
    throw new WalletWorkerError(status, body);
  }
  const err = typeof body.error === 'string' ? body.error : `wallet ${label} failed`;
  throw new Error(err);
}

function readRequiredNumber(body: Record<string, unknown>, key: string, label: string): number {
  const v = body[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new Error(`wallet ${label} missing ${key}`);
}

function readOptionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

export type ExchangeLiquidateWorkerResult = {
  ok: true;
  soldAmount: number;
  grossUsdc: number;
  feeUsdc: number;
  netUsdc: number;
  newUsdc: number;
  newCoinBalance: number;
  idempotentReplay: boolean;
};

export async function callWalletExchangeLiquidate(payload: {
  userId: number;
  coinId: string;
  fraction: number;
  fractionMode: string;
  minUsdc: number;
  feePercent: number;
  idempotencyKey: string | null;
  idempotencyScope: string;
  serverNowMs: number;
  requestFingerprint?: string | null;
}): Promise<ExchangeLiquidateWorkerResult> {
  const { status, body } = await postWalletRaw(EXCHANGE_LIQUIDATE_PATH, payload);
  requireWalletOk(body, status, 'exchange liquidate');
  return {
    ok: true,
    soldAmount: readRequiredNumber(body, 'soldAmount', 'exchange liquidate'),
    grossUsdc: readRequiredNumber(body, 'grossUsdc', 'exchange liquidate'),
    feeUsdc: readRequiredNumber(body, 'feeUsdc', 'exchange liquidate'),
    netUsdc: readRequiredNumber(body, 'netUsdc', 'exchange liquidate'),
    newUsdc: readRequiredNumber(body, 'newUsdc', 'exchange liquidate'),
    newCoinBalance: readRequiredNumber(body, 'newCoinBalance', 'exchange liquidate'),
    idempotentReplay: body.idempotentReplay === true
  };
}

export type WithdrawRequestWorkerResult = {
  ok: true;
  requestId: string;
  message: string;
  idempotentReplay?: boolean;
};

export async function callWalletWithdrawRequest(payload: {
  userId: number;
  coinId: string;
  amount: number;
  walletAddress: string;
  idempotencyKey: string;
  requestFingerprint: string;
  serverNowMs: number;
  withdrawTokensRaw?: string | null;
}): Promise<WithdrawRequestWorkerResult> {
  const { status, body } = await postWalletRaw(WITHDRAW_REQUEST_PATH, payload);
  requireWalletOk(body, status, 'withdraw request');
  const requestId = readOptionalString(body.requestId);
  const message = readOptionalString(body.message);
  if (!requestId || !message) {
    throw new Error('wallet withdraw request missing requestId/message');
  }
  return {
    ok: true,
    requestId,
    message,
    ...(body.idempotentReplay === true ? { idempotentReplay: true } : {})
  };
}

export type DepositCreditWorkerResult = {
  ok: true;
  amount: number;
  newUsdc: number;
  already?: boolean;
};

export async function callWalletDepositCredit(payload: {
  userId: number;
  txHash: string;
  network: string;
  amountUsdc: number;
  walletAddress: string;
  tokenContract?: string | null;
  serverNowMs: number;
}): Promise<DepositCreditWorkerResult> {
  const { status, body } = await postWalletRaw(DEPOSIT_CREDIT_PATH, payload);
  requireWalletOk(body, status, 'deposit credit');
  return {
    ok: true,
    amount: readRequiredNumber(body, 'amount', 'deposit credit'),
    newUsdc: readRequiredNumber(body, 'newUsdc', 'deposit credit'),
    ...(body.already === true ? { already: true } : {})
  };
}

export type DepositResolveReceiptWorkerResult =
  | { ok: true; pending: true }
  | {
      ok: true;
      pending: false;
      network: string;
      amountUsdc: number;
      walletAddress: string;
      tokenContract: string;
    };

/** Fail-closed RPC receipt fetch + ERC-20 parse (no credit). */
export async function callWalletDepositResolveReceipt(payload: {
  txHash: string;
  network: string;
  settings: Record<string, string | undefined>;
}): Promise<DepositResolveReceiptWorkerResult> {
  const { status, body } = await postWalletRaw(
    DEPOSIT_RESOLVE_RECEIPT_PATH,
    payload,
    WALLET_DEPOSIT_RESOLVE_TIMEOUT_MS
  );
  requireWalletOk(body, status, 'deposit resolve-receipt');
  if (body.pending === true) {
    return { ok: true, pending: true };
  }
  const network = readOptionalString(body.network);
  const walletAddress = readOptionalString(body.walletAddress);
  const tokenContract = readOptionalString(body.tokenContract);
  const amountUsdc = body.amountUsdc;
  if (
    !network ||
    !walletAddress ||
    !tokenContract ||
    typeof amountUsdc !== 'number' ||
    !Number.isFinite(amountUsdc)
  ) {
    throw new Error('wallet deposit resolve-receipt missing parsed fields');
  }
  return {
    ok: true,
    pending: false,
    network,
    amountUsdc,
    walletAddress,
    tokenContract
  };
}

export type QuestClaimWorkerResult =
  | { ok: true; rewardUsdc: number; newUsdc: number }
  | { ok: false; error: string; code: string };

/** Fail-closed quest claim (progress claim + USDC credit one TX). Domain `ok:false` returned, not thrown. */
export async function callWalletQuestClaim(payload: {
  userId: number;
  questId: string;
  serverNowMs: number;
}): Promise<QuestClaimWorkerResult> {
  const { status, body } = await postWalletRaw(QUEST_CLAIM_PATH, payload);
  if (status === HTTP_OK && body.ok === true) {
    return {
      ok: true,
      rewardUsdc: readRequiredNumber(body, 'rewardUsdc', 'quest claim'),
      newUsdc: readRequiredNumber(body, 'newUsdc', 'quest claim')
    };
  }
  if (isWalletDomainStatus(status) && body.ok === false) {
    const error = typeof body.error === 'string' ? body.error : 'Quest claim failed';
    const code = typeof body.code === 'string' ? body.code : 'QUEST_CLAIM_FAILED';
    return { ok: false, error, code };
  }
  const err = typeof body.error === 'string' ? body.error : 'wallet quest claim failed';
  throw new Error(err);
}

export type ReferralCreditWorkerResult = {
  ok: true;
  skipped?: boolean;
  creditedUsdc?: number;
};

/** Fail-closed referral USDC on email verify (idempotent via referral_bonus_claimed). */
export async function callWalletReferralCreditOnEmailVerified(payload: {
  verifiedUserId: number;
  serverNowMs?: number;
}): Promise<ReferralCreditWorkerResult> {
  const { status, body } = await postWalletRaw(REFERRAL_CREDIT_PATH, payload);
  requireWalletOk(body, status, 'referral credit');
  return {
    ok: true,
    ...(body.skipped === true ? { skipped: true } : {}),
    ...(typeof body.creditedUsdc === 'number' && Number.isFinite(body.creditedUsdc)
      ? { creditedUsdc: body.creditedUsdc }
      : {})
  };
}

export type ZeradsCreditWorkerResult =
  | {
      ok: true;
      duplicate: false;
      idempotencyKey: string;
      rate: number;
      userSplit: number;
      totalUsdc: number;
      userUsdc: number;
      platformUsdc: number;
    }
  | { ok: true; duplicate: true; idempotencyKey: string };

/** Fail-closed ZERads credit (ledger + USDC). Idempotent via zerads_earnings_ledger. */
export async function callWalletZeradsCredit(payload: {
  userId: number;
  amountZer: number;
  clicks: number;
  serverNowMs?: number;
}): Promise<ZeradsCreditWorkerResult> {
  const { status, body } = await postWalletRaw(ZERADS_CREDIT_PATH, payload);
  requireWalletOk(body, status, 'zerads credit');
  const idempotencyKey = readOptionalString(body.idempotencyKey);
  if (!idempotencyKey) {
    throw new Error('wallet zerads credit missing idempotencyKey');
  }
  if (body.duplicate === true) {
    return { ok: true, duplicate: true, idempotencyKey };
  }
  return {
    ok: true,
    duplicate: false,
    idempotencyKey,
    rate: readRequiredNumber(body, 'rate', 'zerads credit'),
    userSplit: readRequiredNumber(body, 'userSplit', 'zerads credit'),
    totalUsdc: readRequiredNumber(body, 'totalUsdc', 'zerads credit'),
    userUsdc: readRequiredNumber(body, 'userUsdc', 'zerads credit'),
    platformUsdc: readRequiredNumber(body, 'platformUsdc', 'zerads credit')
  };
}

export type AdminWithdrawalStatusWorkerResult = {
  ok: true;
  message: string;
};

/** Fail-closed admin withdrawal status (completed | rejected+refund). */
export async function callWalletAdminWithdrawalStatus(payload: {
  requestId: string;
  status: string;
  txHash?: string | null;
  serverNowMs?: number;
}): Promise<AdminWithdrawalStatusWorkerResult> {
  const { status, body } = await postWalletRaw(ADMIN_WITHDRAWAL_STATUS_PATH, payload);
  requireWalletOk(body, status, 'admin withdrawal status');
  const message = readOptionalString(body.message);
  if (!message) {
    throw new Error('wallet admin withdrawal status missing message');
  }
  return { ok: true, message };
}

export type AdminSetCoinBalanceWorkerResult = { ok: true };

/** Fail-closed admin absolute coin balance SET. */
export async function callWalletAdminSetCoinBalance(payload: {
  userId: number;
  coinId: string;
  amount: number;
}): Promise<AdminSetCoinBalanceWorkerResult> {
  const { status, body } = await postWalletRaw(ADMIN_SET_COIN_BALANCE_PATH, payload);
  requireWalletOk(body, status, 'admin set coin balance');
  return { ok: true };
}

export type AdminSaveGameBalancesWorkerResult = { ok: true };

/** Fail-closed admin save-game USDC + coinBalances writes. */
export async function callWalletAdminSaveGameBalances(payload: {
  userId: number;
  usdc?: number | null;
  coinBalances?: Record<string, number> | null;
  serverNowMs?: number;
}): Promise<AdminSaveGameBalancesWorkerResult> {
  const { status, body } = await postWalletRaw(ADMIN_SAVE_GAME_BALANCES_PATH, payload);
  requireWalletOk(body, status, 'admin save-game balances');
  return { ok: true };
}

export type PartnerYoutubeApproveWorkerResult = { ok: true; updated: number };

/** Fail-closed partner YouTube video submission approve (pending → approved). */
export async function callWalletPartnerYoutubeApprove(payload: {
  id: string;
  adminUserId: number;
  reviewedAt?: number;
}): Promise<PartnerYoutubeApproveWorkerResult> {
  const { status, body } = await postWalletRaw(PARTNER_YOUTUBE_APPROVE_PATH, {
    id: payload.id,
    adminUserId: payload.adminUserId,
    ...(payload.reviewedAt != null ? { reviewedAt: payload.reviewedAt } : {})
  });
  requireWalletOk(body, status, 'partner youtube approve');
  return { ok: true, updated: readRequiredNumber(body, 'updated', 'partner youtube approve') };
}

export async function callWalletState(payload: { userId: number }): Promise<Record<string, unknown>> {
  const { status, body } = await postWalletRaw(WALLET_STATE_PATH, payload);
  requireWalletOk(body, status, 'wallet state');
  return body;
}

export async function callWalletHistory(payload: {
  userId: number;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const { status, body } = await postWalletRaw(WALLET_HISTORY_PATH, payload);
  requireWalletOk(body, status, 'wallet history');
  return body;
}

export async function callWithdrawalsHistory(payload: {
  userId: number;
  limit?: number;
}): Promise<unknown[]> {
  const { status, body } = await postWalletRaw(WITHDRAWALS_HISTORY_PATH, payload);
  if (status !== HTTP_OK) {
    requireWalletOk(body, status, 'withdrawals history');
  }
  return Array.isArray(body) ? body : Array.isArray(body.items) ? body.items : [];
}

export async function callDepositsHistory(payload: {
  userId: number;
  limit?: number;
}): Promise<unknown[]> {
  const { status, body } = await postWalletRaw(DEPOSITS_HISTORY_PATH, payload);
  if (status !== HTTP_OK) {
    requireWalletOk(body, status, 'deposits history');
  }
  return Array.isArray(body) ? body : Array.isArray(body.items) ? body.items : [];
}

export async function callWeb3Settings(): Promise<Record<string, unknown>> {
  const { status, body } = await postWalletRaw(WEB3_SETTINGS_PATH, {});
  if (status !== HTTP_OK) {
    requireWalletOk({ ...body, ok: body.ok === true }, status, 'web3-settings');
  }
  return body;
}
