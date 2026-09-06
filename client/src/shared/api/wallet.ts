/**
 * Carteira do jogador — estado, histórico, liquidação (desk) e settings Web3 públicos.
 */
import { apiFetch } from './http';

const base = '/api';

export type WalletMinedBalanceRow = {
  coinId: string;
  name: string;
  symbol: string;
  usdcRate: number;
  showInExchange: boolean;
  minedBalance: number;
  grossUsdcEstimate: number;
  feeUsdcEstimate: number;
  netUsdcEstimate: number;
};

export type WalletStatePayload = {
  ok: true;
  usdcBalance: number;
  polygonWallet: string | null;
  exchange: {
    minUsdc: number;
    feePercent: number;
    networkUsdcHint: string;
  };
  minedBalances: WalletMinedBalanceRow[];
  withdrawTokens: unknown[];
  ledger: WalletLedgerEntry[];
  withdrawals: WalletWithdrawalRow[];
  notice?: string;
};

export type WalletStateLite = {
  ok: true;
  usdcBalance: number;
};

export type WalletLedgerEntry = {
  id: string;
  coin_id: string;
  sold_crypto: string;
  gross_usdc: string;
  fee_usdc: string;
  net_usdc: string;
  created_at: string;
  entry_type: string;
};

export type WalletWithdrawalRow = {
  id: string;
  coin_id: string;
  amount_crypto: string;
  fee_amount: string;
  net_amount: string;
  status: string;
  wallet_address?: string;
  tx_hash?: string;
  created_at: string;
};

export type WalletHistoryPayload = {
  ok: true;
  ledger: WalletLedgerEntry[];
  withdrawals: WalletWithdrawalRow[];
};

export type WalletExchangeLiquidateOk = {
  ok: true;
  soldAmount?: number;
  netUsdc?: number;
  feeUsdc?: number;
  grossUsdc?: number;
  newUsdc?: number;
  newCoinBalance?: number;
  idempotentReplay?: boolean;
};

export type WalletExchangeLiquidateErr = {
  ok: false;
  error?: string;
  status?: number;
};

export type WalletExchangeLiquidateResult = WalletExchangeLiquidateOk | WalletExchangeLiquidateErr;

export type Web3WithdrawToken = {
  name?: string;
  symbol?: string;
  coinId?: string;
  network?: 'polygon' | 'bnb' | 'base';
  contract?: string;
  payoutWallet?: string;
  minAmount?: number;
  minWithdrawalUsdc?: number;
  feePercent?: number;
  disabled?: boolean;
};

export type Web3Settings = {
  depositWallet?: string;
  payoutWallet?: string;
  depositTokenContract?: string;
  depositTokenContractBnb?: string;
  depositTokenContractBase?: string;
  withdrawTokenName?: string;
  withdrawTokenContract?: string;
  withdrawTokens?: Web3WithdrawToken[];
  minDepositUsdc?: number;
  depositPolygonDisabled?: boolean;
  depositBnbDisabled?: boolean;
  depositBaseDisabled?: boolean;
};

export function web3DepositFlagDisabled(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    return t === '1' || t === 'true' || t === 'yes' || t === 'on';
  }
  return false;
}

export type WithdrawalHistoryEntry = {
  id: string;
  userId: number;
  username: string;
  email: string;
  coinId: string;
  coinSymbol: string;
  amountCrypto: number;
  amountUsdc: number;
  feeAmount: number;
  netAmount: number;
  walletAddress: string;
  status: string;
  txHash: string | null;
  createdAt: number;
  processedAt: number | null;
};

export type DepositHistoryEntry = {
  id: string;
  userId: number;
  txHash: string;
  network: string;
  amountUsdc: number | null;
  walletAddress: string;
  tokenContract: string | null;
  createdAt: number;
};

function parseWithdrawalEntry(raw: unknown): WithdrawalHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : String(r.id ?? '');
  if (!id) return null;
  return {
    id,
    userId: Number(r.userId) || 0,
    username: typeof r.username === 'string' ? r.username : '',
    email: typeof r.email === 'string' ? r.email : '',
    coinId: typeof r.coinId === 'string' ? r.coinId : '',
    coinSymbol: typeof r.coinSymbol === 'string' ? r.coinSymbol : '',
    amountCrypto: Number(r.amountCrypto) || 0,
    amountUsdc: Number(r.amountUsdc) || 0,
    feeAmount: Number(r.feeAmount) || 0,
    netAmount: Number(r.netAmount) || 0,
    walletAddress: typeof r.walletAddress === 'string' ? r.walletAddress : '',
    status: typeof r.status === 'string' ? r.status : '',
    txHash: typeof r.txHash === 'string' && r.txHash.trim() ? r.txHash.trim() : null,
    createdAt: Number(r.createdAt) || 0,
    processedAt: r.processedAt != null ? Number(r.processedAt) : null
  };
}

function parseDepositEntry(raw: unknown): DepositHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : String(r.id ?? '');
  if (!id) return null;
  const amountRaw = r.amountUsdc;
  const amountNum = amountRaw == null ? null : Number(amountRaw);
  return {
    id,
    userId: Number(r.userId) || 0,
    txHash: typeof r.txHash === 'string' ? r.txHash : '',
    network: typeof r.network === 'string' ? r.network : 'polygon',
    amountUsdc:
      amountNum != null && Number.isFinite(amountNum) && amountNum > 0
        ? amountNum
        : amountNum === 0
          ? 0
          : null,
    walletAddress: typeof r.walletAddress === 'string' ? r.walletAddress : '',
    tokenContract:
      typeof r.tokenContract === 'string' && r.tokenContract.trim() ? r.tokenContract.trim() : null,
    createdAt: Number(r.createdAt) || 0
  };
}

/** Histórico de saques — `GET /api/withdrawals/history` (legado). */
export async function getMyWithdrawalHistory(): Promise<WithdrawalHistoryEntry[]> {
  try {
    const res = await apiFetch(`${base}/withdrawals/history?limit=300`);
    if (!res.ok) return [];
    const raw = await res.json().catch(() => []);
    if (!Array.isArray(raw)) return [];
    const out: WithdrawalHistoryEntry[] = [];
    for (const row of raw) {
      const e = parseWithdrawalEntry(row);
      if (e) out.push(e);
    }
    return out;
  } catch {
    return [];
  }
}

/** Histórico de depósitos — `GET /api/deposits/history` (legado). */
export async function getMyDepositHistory(): Promise<DepositHistoryEntry[]> {
  try {
    const res = await apiFetch(`${base}/deposits/history?limit=300`);
    if (!res.ok) return [];
    const raw = await res.json().catch(() => []);
    if (!Array.isArray(raw)) return [];
    const out: DepositHistoryEntry[] = [];
    for (const row of raw) {
      const e = parseDepositEntry(row);
      if (e) out.push(e);
    }
    return out;
  } catch {
    return [];
  }
}

/** Leitura leve — seed USDC no shell (GameShell). Prefer `getWalletState` for full payload. */
export async function getWalletUsdcBalance(): Promise<number | null> {
  const state = await getWalletState();
  return state?.ok ? state.usdcBalance : null;
}

/** Estado consolidado da carteira (servidor é fonte da verdade). */
export async function getWalletState(): Promise<WalletStatePayload | null> {
  try {
    const res = await apiFetch(`${base}/wallet/state`);
    if (!res.ok) return null;
    const j = (await res.json()) as WalletStatePayload;
    return j && j.ok ? j : null;
  } catch {
    return null;
  }
}

export async function getWalletHistory(limit = 15): Promise<WalletHistoryPayload | null> {
  try {
    const lim = Math.min(50, Math.max(1, Math.floor(limit)));
    const res = await apiFetch(`${base}/wallet/history?limit=${lim}`);
    if (!res.ok) return null;
    const j = (await res.json()) as WalletHistoryPayload;
    if (!j || j.ok !== true) return null;
    return {
      ok: true,
      ledger: Array.isArray(j.ledger) ? j.ledger : [],
      withdrawals: Array.isArray(j.withdrawals) ? j.withdrawals : []
    };
  } catch {
    return null;
  }
}

/** Liquidação pelo desk (atalhos 10/50/100) com idempotência obrigatória. */
export async function postExchangeLiquidate(params: {
  coinId: string;
  mode: 'PERCENTAGE';
  percentage: 10 | 50 | 100;
  idempotencyKey: string;
}): Promise<WalletExchangeLiquidateResult> {
  try {
    const res = await apiFetch(`${base}/wallet/exchange/liquidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coinId: params.coinId,
        mode: params.mode,
        percentage: params.percentage,
        idempotencyKey: params.idempotencyKey
      })
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return { ok: false, error: 'Resposta inválida do servidor.', status: res.status };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: typeof json.error === 'string' ? json.error : 'Pedido rejeitado.',
        status: res.status
      };
    }
    return {
      ok: true,
      soldAmount: typeof json.soldAmount === 'number' ? json.soldAmount : undefined,
      netUsdc: typeof json.netUsdc === 'number' ? json.netUsdc : undefined,
      feeUsdc: typeof json.feeUsdc === 'number' ? json.feeUsdc : undefined,
      grossUsdc: typeof json.grossUsdc === 'number' ? json.grossUsdc : undefined,
      newUsdc: typeof json.newUsdc === 'number' ? json.newUsdc : undefined,
      newCoinBalance: typeof json.newCoinBalance === 'number' ? json.newCoinBalance : undefined,
      idempotentReplay: json.idempotentReplay === true
    };
  } catch {
    return { ok: false, error: 'Erro de rede' };
  }
}

export type WithdrawRequestResult = {
  ok: boolean;
  requestId?: string;
  message?: string;
  error?: string;
  code?: string;
  idempotentReplay?: boolean;
  status?: number;
};

export async function requestWithdrawal(
  coinId: string,
  amount: number,
  walletAddress: string,
  idempotencyKey: string
): Promise<WithdrawRequestResult> {
  try {
    const res = await apiFetch(`${base}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coinId, amount, walletAddress, idempotencyKey })
    });
    let body: {
      ok?: boolean;
      requestId?: string;
      message?: string;
      error?: string;
      code?: string;
      idempotentReplay?: boolean;
    } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = { ok: false, error: res.ok ? undefined : 'Resposta inesperada do servidor.' };
    }
    return {
      ok: !!body.ok,
      requestId: body.requestId,
      message: body.message,
      error: body.error,
      code: body.code,
      idempotentReplay: body.idempotentReplay,
      status: res.status
    };
  } catch {
    return { ok: false, error: 'Erro de rede. Verifica a conexão.' };
  }
}

export type VerifyDepositResult = {
  ok: boolean;
  pending?: boolean;
  already?: boolean;
  amount?: number;
  newUsdc?: number;
  error?: string;
  message?: string;
  status?: number;
};

export async function verifyDeposit(params: {
  txHash: string;
  network: string;
}): Promise<VerifyDepositResult> {
  try {
    const res = await apiFetch(`${base}/deposit/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        txHash: params.txHash,
        network: params.network
      })
    });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, error: 'Resposta inválida do servidor.', status: res.status };
    }
    if (res.ok && body.ok === true) {
      return {
        ok: true,
        already: body.already === true,
        amount: typeof body.amount === 'number' ? body.amount : undefined,
        newUsdc: typeof body.newUsdc === 'number' ? body.newUsdc : undefined,
        status: res.status
      };
    }
    if (body.pending === true) {
      return {
        ok: false,
        pending: true,
        message: typeof body.message === 'string' ? body.message : undefined,
        status: res.status
      };
    }
    return {
      ok: false,
      error:
        typeof body.error === 'string'
          ? body.error
          : !res.ok
            ? 'Pedido rejeitado pelo servidor.'
            : 'Falha na validação.',
      status: res.status
    };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

/** Settings Web3 públicos (carteira de depósito, flags de rede, tokens de saque). */
export async function getWeb3Settings(): Promise<Web3Settings | null> {
  try {
    const res = await apiFetch(`${base}/web3-settings?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    return {
      ...(raw as Web3Settings),
      depositPolygonDisabled: web3DepositFlagDisabled(o.depositPolygonDisabled),
      depositBnbDisabled: web3DepositFlagDisabled(o.depositBnbDisabled),
      depositBaseDisabled: web3DepositFlagDisabled(o.depositBaseDisabled)
    };
  } catch {
    return null;
  }
}

/** Admin write — same public settings keys as GET. */
export async function setWeb3Settings(settings: Web3Settings): Promise<void> {
  const res = await apiFetch(`${base}/web3-settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Erro ao salvar configurações Web3: ${res.status}`);
  }
}
