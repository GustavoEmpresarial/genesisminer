/**
 * Proxy admin de tokentx USDC (Polygon) da tesouraria — GET
 * `/api/admin/etherscan/treasury-token-txs`.
 *
 * Migrado de `legacy/backend/server.ts`. Chave: `ETHERSCAN_API_KEY` (já usada
 * em deposit-receipt). Resposta = JSON Etherscan (caller AdminReports).
 * A chave nunca vai no JSON ao cliente nem em logs.
 */
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import { getSettingValue } from '../../../../shared/settings/settings-repository.js';

const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_BAD_GATEWAY = 502;
const FETCH_TIMEOUT_MS = 20_000;
const PAGE_MAX = 100;
const OFFSET_MAX = 1000;
const PAGE_DEFAULT = 1;
const OFFSET_DEFAULT = 20;
const CHAIN_ID = 137;
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const FALLBACK_TREASURY = '0x3D9bDA32f0cbA0E84C332Fd0151D434A4840F38a'.toLowerCase();
const LEGACY_TREASURY = '0x2c386Bf962339B497d5EC6A0EdB255D30004F3B6'.toLowerCase();
const LEGACY_LAUNCH_TREASURY = '0x33d2406707e5e4b314d15784e73bb08f0c46db42'.toLowerCase();
const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const WEB3_DEPOSIT_WALLET_KEY = 'web3_deposit_wallet';
const ADDR_RE = /^0x[a-f0-9]{40}$/;

export type TreasuryTokenTxsQuery = {
  page?: unknown;
  offset?: unknown;
  address?: unknown;
};

export type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  json: () => Promise<unknown>;
}>;

export function clampTreasuryTxPage(raw: unknown): number {
  return Math.min(PAGE_MAX, Math.max(1, parseInt(String(raw ?? String(PAGE_DEFAULT)), 10) || PAGE_DEFAULT));
}

export function clampTreasuryTxOffset(raw: unknown): number {
  return Math.min(OFFSET_MAX, Math.max(1, parseInt(String(raw ?? String(OFFSET_DEFAULT)), 10) || OFFSET_DEFAULT));
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join('[redacted]');
  }
  return out.replace(/apikey=[^&\s"'<>]+/gi, 'apikey=[redacted]');
}

export function sanitizeJsonForClient(data: unknown, secrets: readonly string[]): unknown {
  if (typeof data === 'string') return redactSecrets(data, secrets);
  if (Array.isArray(data)) return data.map((x) => sanitizeJsonForClient(x, secrets));
  if (data && typeof data === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      o[k] = sanitizeJsonForClient(v, secrets);
    }
    return o;
  }
  return data;
}

export function resolveTreasuryAddress(requestedRaw: unknown, configuredTreasury: string): string {
  const primaryTreasury = configuredTreasury || FALLBACK_TREASURY;
  const allowed = new Set([LEGACY_TREASURY, LEGACY_LAUNCH_TREASURY, primaryTreasury]);
  const requested = String(requestedRaw ?? '').trim().toLowerCase();
  if (requested.length === 42 && requested.startsWith('0x') && allowed.has(requested)) {
    return requested;
  }
  return primaryTreasury;
}

async function loadConfiguredTreasury(): Promise<string> {
  try {
    const raw = await getSettingValue(WEB3_DEPOSIT_WALLET_KEY);
    if (typeof raw === 'string') {
      const t = raw.trim().toLowerCase();
      if (ADDR_RE.test(t)) return t;
    }
  } catch {
    console.error('[treasury-token-txs] settings read');
  }
  return '';
}

export function buildEtherscanTokentxUrl(params: {
  apiKey: string;
  treasury: string;
  page: number;
  offset: number;
}): string {
  const q = new URLSearchParams({
    chainid: String(CHAIN_ID),
    module: 'account',
    action: 'tokentx',
    contractaddress: USDC_POLYGON,
    address: params.treasury,
    page: String(params.page),
    offset: String(params.offset),
    startblock: '0',
    endblock: '99999999',
    sort: 'desc',
    apikey: params.apiKey
  });
  return `${ETHERSCAN_V2}?${q.toString()}`;
}

export async function getTreasuryTokenTxs(
  query: TreasuryTokenTxsQuery,
  deps?: { fetchImpl?: FetchLike; apiKey?: string; timeoutMs?: number }
): Promise<unknown> {
  const apiKey = (deps?.apiKey ?? process.env.ETHERSCAN_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new HttpControlledError(HTTP_SERVICE_UNAVAILABLE, {
      error: 'ETHERSCAN_API_KEY não configurada no servidor.'
    });
  }

  const page = clampTreasuryTxPage(query.page);
  const offset = clampTreasuryTxOffset(query.offset);
  const configuredTreasury = await loadConfiguredTreasury();
  const treasury = resolveTreasuryAddress(query.address, configuredTreasury);
  const url = buildEtherscanTokentxUrl({ apiKey, treasury, page, offset });
  const fetchImpl = deps?.fetchImpl ?? (globalThis.fetch as FetchLike);

  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), deps?.timeoutMs ?? FETCH_TIMEOUT_MS);
    let data: unknown;
    try {
      const r = await fetchImpl(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
      data = await r.json();
    } finally {
      clearTimeout(t);
    }
    return sanitizeJsonForClient(data, [apiKey]);
  } catch (e) {
    console.error('[etherscan proxy]', e instanceof Error ? e.name : 'error');
    throw new HttpControlledError(HTTP_BAD_GATEWAY, { error: 'Falha ao contactar Etherscan.' });
  }
}
