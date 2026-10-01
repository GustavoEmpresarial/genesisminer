/**
 * APIs da aba Usuários — mesmos paths do legado `services/api.ts`.
 */
import { apiFetch } from './http';
import {
  parseLedgerEntry,
  WALLET_LEDGER_ENTRY_TYPE_EXCHANGE_LIQUIDATE,
  type ReinvestmentHistoryEntry
} from './wallet';
import { getSession as authGetSession, updateUser as authUpdateUser } from './auth';
import type { User } from '../types/auth';
import type {
  AdminUpgrade,
  GameState,
  LootBox,
  ReferralModel,
  SeasonPass,
  GameUserActivityEntry,
  ActivityEventDisplay
} from '../../features/admin/lib/adminTypes';
import type { PlacedRack, StoredBattery } from '../../features/servers/types';

const base = '/api';

function parseJsonArray<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}

let globalLastLoadTime = 0;
const SAVE_GAME_KEEPALIVE_MAX_BYTES = 61440;

export { authUpdateUser as updateUser };

export async function getSession(): Promise<User | null> {
  return authGetSession();
}

export type AdminUsersListResponse = {
  users: User[];
  total: number;
  pages: number;
  levels: Array<{ id: string; name: string }>;
  rooms: Array<{ id: string; name: string }>;
  error?: string;
  code?: string;
  status?: number;
};

const EMPTY_USERS: AdminUsersListResponse = { users: [], total: 0, pages: 0, levels: [], rooms: [] };
const ADMIN_USERS_RATE_LIMIT_MSG = 'Too many admin users requests.';
const HTTP_TOO_MANY_REQUESTS = 429;

export async function getUsers(
  page: number = 1,
  limit: number = 50,
  search: string = '',
  sortBy: string = 'creation',
  sortDir: 'asc' | 'desc' = 'asc',
  filterStatus: string = 'all',
  filterLevel: string = 'all',
  filterAdminsOnly: boolean = false,
  filterRoom: string = 'all',
  userId?: number
): Promise<AdminUsersListResponse> {
  try {
    const uid =
      userId != null && Number.isFinite(userId) && userId > 0 ? Math.floor(userId) : undefined;
    const query = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      search,
      sortBy,
      sortDir,
      filterStatus,
      filterLevel,
      filterRoom,
      ...(filterAdminsOnly ? { filterAdmins: '1' } : {}),
      ...(uid != null ? { userId: String(uid) } : {})
    }).toString();
    const res = await apiFetch(`${base}/users?${query}`);
    if (!res.ok) {
      let error = `Erro ${res.status}`;
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: unknown; code?: unknown };
        if (typeof j.error === 'string' && j.error.trim()) error = j.error.trim();
        if (typeof j.code === 'string' && j.code.trim()) code = j.code.trim();
      } catch {
        /* ignore */
      }
      if (res.status === HTTP_TOO_MANY_REQUESTS) {
        return {
          ...EMPTY_USERS,
          error: error || ADMIN_USERS_RATE_LIMIT_MSG,
          code: code || 'RATE_LIMIT',
          status: res.status
        };
      }
      return { ...EMPTY_USERS, error, code, status: res.status };
    }
    const data = (await res.json()) as AdminUsersListResponse;
    return {
      users: Array.isArray(data.users) ? data.users : [],
      total: Number(data.total) || 0,
      pages: Number(data.pages) || 0,
      levels: Array.isArray(data.levels) ? data.levels : [],
      rooms: Array.isArray(data.rooms) ? data.rooms : []
    };
  } catch {
    return { ...EMPTY_USERS, error: 'Erro de rede.' };
  }
}

export const getAdminUsersList = getUsers;

export async function toggleUserBlocked(email: string, blocked: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/users/block`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, blocked })
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: data.ok !== false, error: data.error };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export type AdminUserWalletCurrent = {
  address: string;
  network: string;
  connectedAt: string | null;
  status: 'connected';
};

export type AdminUserWalletHistoryEntry = {
  id: string;
  action: string;
  network: string;
  walletAddress: string | null;
  previousWalletAddress: string | null;
  newWalletAddress: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  actorType: string;
  actorUserId: number | null;
  source: string | null;
  notes: string | null;
  createdAt: string;
  metadata?: unknown;
};

export async function getAdminUserWalletHistory(userId: number): Promise<{
  ok: boolean;
  currentWallet: AdminUserWalletCurrent | null;
  history: AdminUserWalletHistoryEntry[];
  error?: string;
}> {
  const id = Math.floor(Number(userId));
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, currentWallet: null, history: [], error: 'ID inválido.' };
  }
  try {
    const res = await apiFetch(`${base}/admin/users/${id}/wallet-history`);
    const raw = await res.json().catch(() => null);
    if (res.status === 403) {
      return { ok: false, currentWallet: null, history: [], error: 'Acesso negado (403).' };
    }
    if (!res.ok || !raw || typeof raw !== 'object') {
      const err =
        raw && typeof raw === 'object' && 'error' in raw
          ? String((raw as { error?: unknown }).error)
          : `Erro ${res.status}`;
      return { ok: false, currentWallet: null, history: [], error: err };
    }
    const d = raw as Record<string, unknown>;
    const cur =
      d.currentWallet && typeof d.currentWallet === 'object'
        ? (d.currentWallet as AdminUserWalletCurrent)
        : null;
    const hist = Array.isArray(d.history) ? (d.history as AdminUserWalletHistoryEntry[]) : [];
    return { ok: true, currentWallet: cur, history: hist };
  } catch {
    return { ok: false, currentWallet: null, history: [], error: 'Erro de rede.' };
  }
}

/** Global admin reports row — exchange liquidations across all users. */
export type AdminReinvestmentHistoryEntry = ReinvestmentHistoryEntry & {
  userId: number;
  username: string;
  email: string;
  coinSymbol: string;
};

export type AdminReinvestmentUserAggregate = {
  userId: number;
  username: string;
  email: string;
  ops: number;
  grossUsdc: number;
  feeUsdc: number;
  netUsdc: number;
  lastAt: number;
};

export type AdminReinvestmentTotals = {
  ops: number;
  users: number;
  grossUsdc: number;
  feeUsdc: number;
  netUsdc: number;
  minAt: number;
  maxAt: number;
};

export type AdminReinvestmentHistoryResult = {
  ok: true;
  totals: AdminReinvestmentTotals;
  byUser: AdminReinvestmentUserAggregate[];
  items: AdminReinvestmentHistoryEntry[];
  itemsTruncated: boolean;
  itemsLimit: number;
};

function parseAdminReinvestmentHistoryRow(raw: unknown): AdminReinvestmentHistoryEntry | null {
  const baseEntry = parseLedgerEntry(raw);
  if (!baseEntry) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const userId = parseNumericField(r.userId ?? r.user_id);
  const username =
    typeof r.username === 'string'
      ? r.username
      : typeof r.userName === 'string'
        ? r.userName
        : '';
  const email = typeof r.email === 'string' ? r.email : '';
  const coinSymbol =
    typeof r.coinSymbol === 'string'
      ? r.coinSymbol
      : typeof r.coin_symbol === 'string'
        ? r.coin_symbol
        : baseEntry.coinSymbol;
  return {
    ...baseEntry,
    entryType: baseEntry.entryType || WALLET_LEDGER_ENTRY_TYPE_EXCHANGE_LIQUIDATE,
    userId: Math.floor(userId),
    username,
    email,
    coinSymbol
  };
}

function parseAdminReinvestmentUserAggregate(raw: unknown): AdminReinvestmentUserAggregate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const userId = Math.floor(parseNumericField(r.userId ?? r.user_id));
  if (!Number.isFinite(userId) || userId <= 0) return null;
  return {
    userId,
    username: typeof r.username === 'string' ? r.username : '',
    email: typeof r.email === 'string' ? r.email : '',
    ops: Math.floor(parseNumericField(r.ops)),
    grossUsdc: parseNumericField(r.grossUsdc ?? r.gross_usdc),
    feeUsdc: parseNumericField(r.feeUsdc ?? r.fee_usdc),
    netUsdc: parseNumericField(r.netUsdc ?? r.net_usdc),
    lastAt: Math.floor(parseNumericField(r.lastAt ?? r.last_at))
  };
}

function parseAdminReinvestmentTotals(raw: unknown): AdminReinvestmentTotals | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    ops: Math.floor(parseNumericField(r.ops)),
    users: Math.floor(parseNumericField(r.users)),
    grossUsdc: parseNumericField(r.grossUsdc ?? r.gross_usdc),
    feeUsdc: parseNumericField(r.feeUsdc ?? r.fee_usdc),
    netUsdc: parseNumericField(r.netUsdc ?? r.net_usdc),
    minAt: Math.floor(parseNumericField(r.minAt ?? r.min_at)),
    maxAt: Math.floor(parseNumericField(r.maxAt ?? r.max_at))
  };
}

function parseNumericField(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** GET /api/admin/reinvestment-history — liquidações desk → USDC (lista global, Relatórios).
 * `null` = falha de rede/API.
 */
export async function getAdminReinvestmentHistory(query: {
  fromMs?: string;
  toMs?: string;
} = {}): Promise<AdminReinvestmentHistoryResult | null> {
  const params = new URLSearchParams();
  const fromMs = query.fromMs?.trim() ?? '';
  const toMs = query.toMs?.trim() ?? '';
  if (fromMs) params.set('fromMs', fromMs);
  if (toMs) params.set('toMs', toMs);
  const qs = params.toString();
  try {
    const res = await apiFetch(`${base}/admin/reinvestment-history${qs ? `?${qs}` : ''}`);
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    // Legacy: bare array of rows.
    if (Array.isArray(raw)) {
      const items: AdminReinvestmentHistoryEntry[] = [];
      for (const row of raw) {
        const e = parseAdminReinvestmentHistoryRow(row);
        if (e) items.push(e);
      }
      const users = new Set(items.map((i) => i.userId)).size;
      let grossUsdc = 0;
      let feeUsdc = 0;
      let netUsdc = 0;
      let minAt = 0;
      let maxAt = 0;
      for (const i of items) {
        grossUsdc += i.grossUsdc;
        feeUsdc += i.feeUsdc;
        netUsdc += i.netUsdc;
        if (i.createdAt > 0 && (minAt === 0 || i.createdAt < minAt)) minAt = i.createdAt;
        if (i.createdAt > maxAt) maxAt = i.createdAt;
      }
      return {
        ok: true,
        totals: { ops: items.length, users, grossUsdc, feeUsdc, netUsdc, minAt, maxAt },
        byUser: [],
        items,
        itemsTruncated: false,
        itemsLimit: items.length
      };
    }
    if (!raw || typeof raw !== 'object') return null;
    const d = raw as Record<string, unknown>;
    const totals = parseAdminReinvestmentTotals(d.totals);
    if (!totals) return null;
    const itemsRaw = Array.isArray(d.items) ? d.items : [];
    const items: AdminReinvestmentHistoryEntry[] = [];
    for (const row of itemsRaw) {
      const e = parseAdminReinvestmentHistoryRow(row);
      if (e) items.push(e);
    }
    const byUserRaw = Array.isArray(d.byUser) ? d.byUser : [];
    const byUser: AdminReinvestmentUserAggregate[] = [];
    for (const row of byUserRaw) {
      const u = parseAdminReinvestmentUserAggregate(row);
      if (u) byUser.push(u);
    }
    return {
      ok: true,
      totals,
      byUser,
      items,
      itemsTruncated: d.itemsTruncated === true,
      itemsLimit: Math.floor(parseNumericField(d.itemsLimit)) || items.length
    };
  } catch {
    return null;
  }
}

export type AdminShopCheckoutLine = {
  id: string;
  name: string;
  qty: number;
};

export type AdminShopCheckoutRow = {
  id: string;
  userId: number;
  username: string;
  email: string;
  totalCost: number;
  newUsdc: number;
  createdAt: number;
  lines: AdminShopCheckoutLine[];
};

export type AdminShopCheckoutsQuery = {
  itemId?: string;
  userId?: string;
  q?: string;
};

export type AdminShopItemTotal = {
  id: string;
  name: string;
  qty: number;
  checkouts: number;
  firstAt: number;
  lastAt: number;
};

export type AdminShopCheckoutsResult = {
  ok: boolean;
  rows: AdminShopCheckoutRow[];
  byItem: AdminShopItemTotal[];
  totalCost: number;
  itemQty: number;
  checkoutCount: number;
  truncated: boolean;
  limit: number;
  error?: string;
};

function parseShopLine(raw: unknown): AdminShopCheckoutLine | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!id) return null;
  const name = typeof r.name === 'string' ? r.name : '';
  const qtyRaw = parseNumericField(r.qty);
  const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.floor(qtyRaw) : 0;
  return { id, name, qty };
}

function parseShopCheckoutRow(raw: unknown): AdminShopCheckoutRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!id) return null;
  const linesRaw = Array.isArray(r.lines) ? r.lines : [];
  const lines: AdminShopCheckoutLine[] = [];
  for (const line of linesRaw) {
    const parsed = parseShopLine(line);
    if (parsed) lines.push(parsed);
  }
  return {
    id,
    userId: Math.floor(parseNumericField(r.userId)),
    username: typeof r.username === 'string' ? r.username : '',
    email: typeof r.email === 'string' ? r.email : '',
    totalCost: parseNumericField(r.totalCost),
    newUsdc: parseNumericField(r.newUsdc),
    createdAt: Math.floor(parseNumericField(r.createdAt)),
    lines
  };
}

const EMPTY_SHOP_CHECKOUTS: AdminShopCheckoutsResult = {
  ok: false,
  rows: [],
  byItem: [],
  totalCost: 0,
  itemQty: 0,
  checkoutCount: 0,
  truncated: false,
  limit: 0
};

function parseShopItemTotal(raw: unknown): AdminShopItemTotal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!id) return null;
  return {
    id,
    name: typeof r.name === 'string' ? r.name : '',
    qty: Math.max(0, Math.floor(parseNumericField(r.qty))),
    checkouts: Math.max(0, Math.floor(parseNumericField(r.checkouts))),
    firstAt: Math.floor(parseNumericField(r.firstAt)),
    lastAt: Math.floor(parseNumericField(r.lastAt))
  };
}

/** Corpo de `GET /api/admin/shop/checkouts` já sem o envelope `ok` do worker. */
export function parseAdminShopCheckoutsBody(raw: unknown): AdminShopCheckoutsResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const rowsRaw = Array.isArray(d.rows) ? d.rows : [];
  const rows: AdminShopCheckoutRow[] = [];
  for (const row of rowsRaw) {
    const parsed = parseShopCheckoutRow(row);
    if (parsed) rows.push(parsed);
  }
  const byRaw = Array.isArray(d.byItem) ? d.byItem : [];
  const byItem: AdminShopItemTotal[] = [];
  for (const row of byRaw) {
    const parsed = parseShopItemTotal(row);
    if (parsed) byItem.push(parsed);
  }
  return {
    ok: true,
    rows,
    byItem,
    totalCost: parseNumericField(d.totalCost),
    itemQty: Math.floor(parseNumericField(d.itemQty)),
    checkoutCount: Math.floor(parseNumericField(d.checkoutCount)),
    truncated: d.truncated === true,
    limit: Math.floor(parseNumericField(d.limit))
  };
}

/** GET /api/admin/shop/checkouts — débitos da loja no saldo USDC do jogo (não OpenSea). */
export async function getAdminShopCheckouts(
  query: AdminShopCheckoutsQuery = {}
): Promise<AdminShopCheckoutsResult> {
  const params = new URLSearchParams();
  const itemId = query.itemId?.trim() ?? '';
  const userId = query.userId?.trim() ?? '';
  const q = query.q?.trim() ?? '';
  if (itemId) params.set('itemId', itemId);
  if (userId) params.set('userId', userId);
  if (q) params.set('q', q);
  const qs = params.toString();
  try {
    const res = await apiFetch(`${base}/admin/shop/checkouts${qs ? `?${qs}` : ''}`);
    const raw = await res.json().catch(() => null);
    if (!res.ok || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      const err =
        raw && typeof raw === 'object' && raw !== null && 'error' in raw
          ? String((raw as { error?: unknown }).error)
          : `Erro ${res.status}`;
      return { ...EMPTY_SHOP_CHECKOUTS, error: err };
    }
    const parsed = parseAdminShopCheckoutsBody(raw);
    if (!parsed) {
      const err =
        raw && typeof raw === 'object' && raw !== null && 'error' in raw
          ? String((raw as { error?: unknown }).error)
          : `Erro ${res.status}`;
      return { ...EMPTY_SHOP_CHECKOUTS, error: err };
    }
    return parsed;
  } catch {
    return { ...EMPTY_SHOP_CHECKOUTS, error: 'Erro de rede.' };
  }
}

export type AdminPurchaseSourceRow = {
  id: string;
  label: string;
  hint: string;
  usdc: number;
  itemQty: number;
  events: number;
  buyers: number;
};

export type AdminPurchaseItemRow = {
  id: string;
  name: string;
  source: string;
  sourceLabel: string;
  qty: number;
  events: number;
  buyers: number;
  usdc: number;
  firstAt: number;
  lastAt: number;
};

export type AdminPurchaseBuyerRow = {
  userId: number;
  username: string;
  email: string;
  usdc: number;
  events: number;
  itemQty: number;
  source: string;
  sourceLabel: string;
};

export type AdminPurchasesReportQuery = {
  itemId?: string;
  userId?: string;
  q?: string;
  fromMs?: string;
  toMs?: string;
};

export type AdminSeasonPurchaseRow = {
  id: string;
  passId: string;
  passName: string;
  seasonId: string;
  priceUsdc: number;
  purchasedAt: number;
  userId: number;
  username: string;
  email: string;
  source: string;
  sourceLabel: string;
};

export type AdminP2pTradeRow = {
  id: string;
  createdAt: number;
  buyerId: number;
  buyerUsername: string;
  buyerEmail: string;
  sellerId: number;
  sellerUsername: string;
  sellerEmail: string;
  itemId: string;
  itemName: string;
  qty: number;
  unitPrice: number;
  buyerPaidUsdc: number;
  sellerReceivedUsdc: number;
  taxUsdc: number;
  role: 'buyer' | 'seller' | 'participant';
  source: string;
  sourceLabel: string;
};

export type AdminPurchasesReportResult = {
  ok: boolean;
  sources: AdminPurchaseSourceRow[];
  byItem: AdminPurchaseItemRow[];
  topBuyersShop: AdminPurchaseBuyerRow[];
  topBuyersP2p: AdminPurchaseBuyerRow[];
  recentShop: AdminShopCheckoutRow[];
  recentSeason: AdminSeasonPurchaseRow[];
  recentP2p: AdminP2pTradeRow[];
  seasonTotals: {
    totalUsdc: number;
    passCount: number;
    buyers: number;
  };
  p2pSalesTotals: {
    totalReceivedUsdc: number;
    totalTaxUsdc: number;
    tradeCount: number;
    itemQty: number;
  };
  shopTruncated: boolean;
  limit: number;
  error?: string;
};

const EMPTY_PURCHASES_REPORT: AdminPurchasesReportResult = {
  ok: false,
  sources: [],
  byItem: [],
  topBuyersShop: [],
  topBuyersP2p: [],
  recentShop: [],
  recentSeason: [],
  recentP2p: [],
  seasonTotals: {
    totalUsdc: 0,
    passCount: 0,
    buyers: 0
  },
  p2pSalesTotals: {
    totalReceivedUsdc: 0,
    totalTaxUsdc: 0,
    tradeCount: 0,
    itemQty: 0
  },
  shopTruncated: false,
  limit: 0
};

function parsePurchaseSource(raw: unknown): AdminPurchaseSourceRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!id) return null;
  return {
    id,
    label: typeof r.label === 'string' ? r.label : id,
    hint: typeof r.hint === 'string' ? r.hint : '',
    usdc: parseNumericField(r.usdc),
    itemQty: Math.floor(parseNumericField(r.itemQty)),
    events: Math.floor(parseNumericField(r.events)),
    buyers: Math.floor(parseNumericField(r.buyers))
  };
}

function parsePurchaseItem(raw: unknown): AdminPurchaseItemRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!id) return null;
  return {
    id,
    name: typeof r.name === 'string' ? r.name : '',
    source: typeof r.source === 'string' ? r.source : '',
    sourceLabel: typeof r.sourceLabel === 'string' ? r.sourceLabel : '',
    qty: Math.floor(parseNumericField(r.qty)),
    events: Math.floor(parseNumericField(r.events)),
    buyers: Math.floor(parseNumericField(r.buyers)),
    usdc: parseNumericField(r.usdc),
    firstAt: Math.floor(parseNumericField(r.firstAt)),
    lastAt: Math.floor(parseNumericField(r.lastAt))
  };
}

function parsePurchaseBuyer(raw: unknown): AdminPurchaseBuyerRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const userId = Math.floor(parseNumericField(r.userId));
  if (userId <= 0) return null;
  return {
    userId,
    username: typeof r.username === 'string' ? r.username : '',
    email: typeof r.email === 'string' ? r.email : '',
    usdc: parseNumericField(r.usdc),
    events: Math.floor(parseNumericField(r.events)),
    itemQty: Math.floor(parseNumericField(r.itemQty)),
    source: typeof r.source === 'string' ? r.source : '',
    sourceLabel: typeof r.sourceLabel === 'string' ? r.sourceLabel : ''
  };
}

function parseSeasonPurchaseRow(raw: unknown): AdminSeasonPurchaseRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const passId = typeof r.passId === 'string' ? r.passId : '';
  if (!passId) return null;
  return {
    id: typeof r.id === 'string' ? r.id : passId,
    passId,
    passName: typeof r.passName === 'string' ? r.passName : passId,
    seasonId: typeof r.seasonId === 'string' ? r.seasonId : '',
    priceUsdc: parseNumericField(r.priceUsdc),
    purchasedAt: Math.floor(parseNumericField(r.purchasedAt)),
    userId: Math.floor(parseNumericField(r.userId)),
    username: typeof r.username === 'string' ? r.username : '',
    email: typeof r.email === 'string' ? r.email : '',
    source: 'season',
    sourceLabel: typeof r.sourceLabel === 'string' ? r.sourceLabel : 'Passe de Temporada'
  };
}

function parseP2pTradeRow(raw: unknown): AdminP2pTradeRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : String(r.id || '');
  if (!id) return null;
  const rawRole = typeof r.role === 'string' ? r.role : 'participant';
  const role = rawRole === 'buyer' || rawRole === 'seller' ? rawRole : 'participant';
  return {
    id,
    createdAt: Math.floor(parseNumericField(r.createdAt)),
    buyerId: Math.floor(parseNumericField(r.buyerId)),
    buyerUsername: typeof r.buyerUsername === 'string' ? r.buyerUsername : '',
    buyerEmail: typeof r.buyerEmail === 'string' ? r.buyerEmail : '',
    sellerId: Math.floor(parseNumericField(r.sellerId)),
    sellerUsername: typeof r.sellerUsername === 'string' ? r.sellerUsername : '',
    sellerEmail: typeof r.sellerEmail === 'string' ? r.sellerEmail : '',
    itemId: typeof r.itemId === 'string' ? r.itemId : '',
    itemName: typeof r.itemName === 'string' ? r.itemName : '',
    qty: Math.floor(parseNumericField(r.qty)),
    unitPrice: parseNumericField(r.unitPrice),
    buyerPaidUsdc: parseNumericField(r.buyerPaidUsdc),
    sellerReceivedUsdc: parseNumericField(r.sellerReceivedUsdc),
    taxUsdc: parseNumericField(r.taxUsdc),
    role,
    source: 'p2p',
    sourceLabel: typeof r.sourceLabel === 'string' ? r.sourceLabel : (role === 'seller' ? 'Venda P2P' : 'Compra P2P')
  };
}

export function parseAdminPurchasesReportBody(raw: unknown): AdminPurchasesReportResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const sources: AdminPurchaseSourceRow[] = [];
  for (const row of Array.isArray(d.sources) ? d.sources : []) {
    const p = parsePurchaseSource(row);
    if (p) sources.push(p);
  }
  const byItem: AdminPurchaseItemRow[] = [];
  for (const row of Array.isArray(d.byItem) ? d.byItem : []) {
    const p = parsePurchaseItem(row);
    if (p) byItem.push(p);
  }
  const top = d.topBuyers && typeof d.topBuyers === 'object' && !Array.isArray(d.topBuyers)
    ? (d.topBuyers as Record<string, unknown>)
    : {};
  const topBuyersShop: AdminPurchaseBuyerRow[] = [];
  for (const row of Array.isArray(top.shop) ? top.shop : []) {
    const p = parsePurchaseBuyer(row);
    if (p) topBuyersShop.push(p);
  }
  const topBuyersP2p: AdminPurchaseBuyerRow[] = [];
  for (const row of Array.isArray(top.p2p) ? top.p2p : []) {
    const p = parsePurchaseBuyer(row);
    if (p) topBuyersP2p.push(p);
  }
  const recentShop: AdminShopCheckoutRow[] = [];
  for (const row of Array.isArray(d.recentShop) ? d.recentShop : []) {
    const p = parseShopCheckoutRow(row);
    if (p) recentShop.push(p);
  }
  const recentSeason: AdminSeasonPurchaseRow[] = [];
  for (const row of Array.isArray(d.recentSeason) ? d.recentSeason : []) {
    const p = parseSeasonPurchaseRow(row);
    if (p) recentSeason.push(p);
  }
  const recentP2p: AdminP2pTradeRow[] = [];
  for (const row of Array.isArray(d.recentP2p) ? d.recentP2p : []) {
    const p = parseP2pTradeRow(row);
    if (p) recentP2p.push(p);
  }

  const rawSeasonTotals = d.seasonTotals && typeof d.seasonTotals === 'object' && !Array.isArray(d.seasonTotals)
    ? (d.seasonTotals as Record<string, unknown>)
    : {};
  const seasonTotals = {
    totalUsdc: parseNumericField(rawSeasonTotals.totalUsdc),
    passCount: Math.floor(parseNumericField(rawSeasonTotals.passCount)),
    buyers: Math.floor(parseNumericField(rawSeasonTotals.buyers))
  };

  const rawP2pSalesTotals = d.p2pSalesTotals && typeof d.p2pSalesTotals === 'object' && !Array.isArray(d.p2pSalesTotals)
    ? (d.p2pSalesTotals as Record<string, unknown>)
    : {};
  const p2pSalesTotals = {
    totalReceivedUsdc: parseNumericField(rawP2pSalesTotals.totalReceivedUsdc),
    totalTaxUsdc: parseNumericField(rawP2pSalesTotals.totalTaxUsdc),
    tradeCount: Math.floor(parseNumericField(rawP2pSalesTotals.tradeCount)),
    itemQty: Math.floor(parseNumericField(rawP2pSalesTotals.itemQty))
  };

  return {
    ok: true,
    sources,
    byItem,
    topBuyersShop,
    topBuyersP2p,
    recentShop,
    recentSeason,
    recentP2p,
    seasonTotals,
    p2pSalesTotals,
    shopTruncated: d.shopTruncated === true,
    limit: Math.floor(parseNumericField(d.limit))
  };
}

/** GET /api/admin/purchases/report — relatório geral loja + compras P2P. */
export async function getAdminPurchasesReport(
  query: AdminPurchasesReportQuery = {}
): Promise<AdminPurchasesReportResult> {
  const params = new URLSearchParams();
  const itemId = query.itemId?.trim() ?? '';
  const userId = query.userId?.trim() ?? '';
  const q = query.q?.trim() ?? '';
  const fromMs = query.fromMs?.trim() ?? '';
  const toMs = query.toMs?.trim() ?? '';
  if (itemId) params.set('itemId', itemId);
  if (userId) params.set('userId', userId);
  if (q) params.set('q', q);
  if (fromMs) params.set('fromMs', fromMs);
  if (toMs) params.set('toMs', toMs);
  const qs = params.toString();
  try {
    const res = await apiFetch(`${base}/admin/purchases/report${qs ? `?${qs}` : ''}`);
    const raw = await res.json().catch(() => null);
    if (!res.ok || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      const err =
        raw && typeof raw === 'object' && raw !== null && 'error' in raw
          ? String((raw as { error?: unknown }).error)
          : `Erro ${res.status}`;
      return { ...EMPTY_PURCHASES_REPORT, error: err };
    }
    const parsed = parseAdminPurchasesReportBody(raw);
    if (!parsed) {
      return { ...EMPTY_PURCHASES_REPORT, error: `Erro ${res.status}` };
    }
    return parsed;
  } catch {
    return { ...EMPTY_PURCHASES_REPORT, error: 'Erro de rede.' };
  }
}

/** GET /api/admin/users/:userId/reinvestment-history — liquidações desk → USDC (admin). */
export async function getAdminUserReinvestmentHistory(userId: number): Promise<{
  ok: boolean;
  history: ReinvestmentHistoryEntry[];
  error?: string;
}> {
  const id = Math.floor(Number(userId));
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, history: [], error: 'ID inválido.' };
  }
  try {
    const res = await apiFetch(`${base}/admin/users/${id}/reinvestment-history`);
    const raw = await res.json().catch(() => null);
    if (res.status === 403) {
      return { ok: false, history: [], error: 'Acesso negado (403).' };
    }
    if (!res.ok || !raw || typeof raw !== 'object') {
      const err =
        raw && typeof raw === 'object' && 'error' in raw
          ? String((raw as { error?: unknown }).error)
          : `Erro ${res.status}`;
      return { ok: false, history: [], error: err };
    }
    const d = raw as Record<string, unknown>;
    const rows = Array.isArray(d.history) ? d.history : [];
    const history: ReinvestmentHistoryEntry[] = [];
    for (const row of rows) {
      const e = parseLedgerEntry(row);
      if (e && e.entryType === WALLET_LEDGER_ENTRY_TYPE_EXCHANGE_LIQUIDATE) history.push(e);
    }
    return { ok: true, history };
  } catch {
    return { ok: false, history: [], error: 'Erro de rede.' };
  }
}

export async function getLootBoxes(): Promise<LootBox[]> {
  try {
    const res = await apiFetch(`${base}/loot-boxes`);
    if (!res.ok) return [];
    return parseJsonArray<LootBox>(await res.json());
  } catch {
    return [];
  }
}

export type SetLootBoxesResult = { ok: true; warnings?: string[] };

export async function setLootBoxes(
  boxes: LootBox[],
  options?: { replaceCatalog?: boolean }
): Promise<SetLootBoxesResult> {
  const replaceCatalog = options?.replaceCatalog === true;
  const res = await apiFetch(`${base}/loot-boxes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boxes, replaceCatalog })
  });
  const text = await res.text();
  if (!res.ok) {
    let parsed: { error?: unknown } = {};
    try {
      parsed = JSON.parse(text) as { error?: unknown };
    } catch {
      /* ignore */
    }
    if (typeof parsed.error === 'string' && parsed.error.trim()) throw new Error(parsed.error);
    throw new Error((text || '').slice(0, 800) || `Erro ao salvar caixas: ${res.status}`);
  }
  let data: SetLootBoxesResult = { ok: true };
  try {
    if (text) data = JSON.parse(text) as SetLootBoxesResult;
  } catch {
    /* ignore */
  }
  return data;
}

export async function deleteUser(email: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/user/${encodeURIComponent(email)}`, { method: 'DELETE' });
    if (!res.ok) {
      try {
        return await res.json();
      } catch {
        return { ok: false, error: 'Delete failed' };
      }
    }
    try {
      return await res.json();
    } catch {
      return { ok: true };
    }
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function bulkDeleteUsers(emails: string[]): Promise<{ ok: boolean; error?: string; count?: number }> {
  try {
    const res = await apiFetch(`${base}/admin/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails })
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function bulkGiftUsers(
  emails: string[],
  gift: { type: string; id?: string; qty: number }
): Promise<{ ok: boolean; error?: string; count?: number }> {
  try {
    const res = await apiFetch(`${base}/admin/bulk-gift`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails, gift })
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getGameState(
  email: string,
  opts?: { adminOverride?: boolean }
): Promise<{ data: GameState | null; status: number; error?: string }> {
  const target = email === 'me' ? 'me' : encodeURIComponent(email);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts?.adminOverride) headers['X-Admin-Edit'] = '1';
    const res = await apiFetch(`${base}/game-state/${target}?t=${Date.now()}`, { headers });
    if (!res.ok) {
      let error: string | undefined;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (typeof j?.error === 'string' && j.error.trim()) error = j.error.trim();
      } catch {
        /* ignore */
      }
      return { data: null, status: res.status, error };
    }
    const data = await res.json();
    if (data && data.serverUpdatedAt) globalLastLoadTime = data.serverUpdatedAt;
    return { data, status: res.status };
  } catch (e) {
    console.error('[APIService] getGameState failed', e);
    return { data: null, status: 500 };
  }
}

export async function saveGameStateAdminOverride(
  targetUserId: number,
  state: Partial<GameState>,
  options?: { reason?: string; keepalive?: boolean }
): Promise<{
  ok: boolean;
  error?: string;
  placedRacks?: PlacedRack[];
  stock?: Record<string, number>;
  storedBatteries?: StoredBattery[];
}> {
  const payload: Record<string, unknown> = {
    changes: { ...state, lastLoadTime: globalLastLoadTime }
  };
  if (options?.reason) payload.reason = options.reason;
  const url = `${base}/admin/users/${encodeURIComponent(String(targetUserId))}/save-game-override`;
  try {
    const body = JSON.stringify(payload);
    const useKeepalive = !!options?.keepalive && body.length < SAVE_GAME_KEEPALIVE_MAX_BYTES;
    const res = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      ...(useKeepalive ? { keepalive: true as const } : {})
    });
    if (!res.ok) {
      try {
        const errBody = await res.json();
        return { ok: false, ...(errBody as object) };
      } catch {
        return { ok: false, error: `HTTP ${res.status}` };
      }
    }
    return (await res.json()) as { ok: boolean };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function saveGameState(
  email: string,
  state: Partial<GameState>,
  options: { adminOverride?: boolean; keepalive?: boolean } = {}
): Promise<{ ok: boolean; error?: string; serverUpdatedAt?: number }> {
  const payload = {
    changes: { ...state, lastLoadTime: globalLastLoadTime },
    adminOverride: options.adminOverride,
    targetEmail: email
  };
  try {
    const body = JSON.stringify(payload);
    const useKeepalive = !!options.keepalive && body.length < SAVE_GAME_KEEPALIVE_MAX_BYTES;
    const res = await apiFetch(`${base}/save-game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      ...(useKeepalive ? { keepalive: true as const } : {})
    });
    if (!res.ok) {
      try {
        return { ok: false, ...(await res.json()) };
      } catch {
        return { ok: false, error: `HTTP ${res.status}` };
      }
    }
    return await res.json();
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function deactivateStreamerRoomByAdmin(
  userId: number,
  currentState: GameState
): Promise<{ ok: boolean; removedRackCount?: number; error?: string }> {
  try {
    const nextPlacedRacks = (currentState.placedRacks || []).filter(
      (rack) => String(rack.roomId || '').trim() !== 'room_1766898636697'
    );
    const removedRackCount = Math.max(0, (currentState.placedRacks || []).length - nextPlacedRacks.length);
    const res = await saveGameStateAdminOverride(userId, { ...currentState, placedRacks: nextPlacedRacks }, {
      reason: 'admin_disable_streamer_room'
    });
    if (!res.ok) return { ok: false, error: res.error || 'Não foi possível devolver os itens da sala streamer.' };
    return { ok: true, removedRackCount };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getAdminUpgrades(): Promise<AdminUpgrade[]> {
  try {
    const res = await apiFetch(`${base}/admin-upgrades`);
    if (!res.ok) return [];
    return parseJsonArray<AdminUpgrade>(await res.json());
  } catch {
    return [];
  }
}

export async function createAdminUpgrade(upgrade: AdminUpgrade): Promise<{ ok: boolean; id?: string }> {
  try {
    const payload = {
      id: upgrade.id,
      name: upgrade.name,
      description: upgrade.description || '',
      priceUsdc: upgrade.priceUsdc || 0,
      grantUsdc: upgrade.grantUsdc || 0,
      grantAccessLevelId: upgrade.grantAccessLevelId || null,
      isActive: upgrade.isActive === false ? false : true,
      items: (upgrade.items || []).map((it) => ({ itemId: it.itemId, qty: it.qty })),
      boxes: (upgrade.boxes || []).map((b) => ({ boxId: b.boxId, qty: b.qty })),
      passes: Array.isArray(upgrade.passes) ? upgrade.passes : [],
      coins: (upgrade.coins || []).map((c) => ({ coinId: c.coinId, amount: c.amount })),
      visibleToAccessLevelIds: upgrade.visibleToAccessLevelIds || []
    };
    const res = await apiFetch(`${base}/admin-upgrades`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return { ok: false };
    try {
      return await res.json();
    } catch {
      return { ok: true };
    }
  } catch {
    return { ok: false };
  }
}

export async function deleteAdminUpgrade(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin-upgrades/${id}`, { method: 'DELETE' });
    if (!res.ok) return { ok: false, error: await res.text() };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Error' };
  }
}

export async function getMiningCoins(): Promise<unknown[]> {
  try {
    const res = await apiFetch(`${base}/mining-coins`);
    if (!res.ok) return [];
    const raw = await res.json();
    if (Array.isArray(raw)) return parseJsonArray(raw);
    if (raw && typeof raw === 'object' && Array.isArray((raw as { coins?: unknown[] }).coins)) {
      return parseJsonArray((raw as { coins: unknown[] }).coins);
    }
    return [];
  } catch {
    return [];
  }
}

export async function getSeasonPasses(): Promise<SeasonPass[]> {
  try {
    const res = await apiFetch(`${base}/season-passes`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function impersonateUser(targetEmail: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/impersonate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetEmail })
    });
    if (!res.ok) {
      try {
        return await res.json();
      } catch {
        return { ok: false, error: 'Impersonation failed' };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** Desbloqueia check-in premium e activa a janela de N dias agora. */
export async function grantPremiumCheckin(
  targetUserId: number
): Promise<{
  ok: boolean;
  error?: string;
  lastCheckinAtMs?: number;
  intervalDays?: number;
  unlocked?: boolean;
}> {
  try {
    const res = await apiFetch(
      `${base}/admin/users/${encodeURIComponent(String(targetUserId))}/grant-premium-checkin`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    );
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      lastCheckinAtMs?: number;
      intervalDays?: number;
      unlocked?: boolean;
    };
    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return {
      ok: true,
      lastCheckinAtMs: data.lastCheckinAtMs,
      intervalDays: data.intervalDays,
      unlocked: data.unlocked ?? true
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function updateAdminPermissions(
  email: string,
  isAdmin: boolean,
  permissions: string[],
  isSuperAdmin?: boolean
): Promise<{ ok: boolean; error?: string }> {
  try {
    const body: Record<string, unknown> = { email, isAdmin, permissions };
    if (isSuperAdmin !== undefined) body.isSuperAdmin = !!isSuperAdmin;
    const res = await apiFetch(`${base}/admin/update-permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export type AdminDormantMiningRow = {
  id: number;
  username: string;
  email: string;
  polygonWallet: string | null;
  startTimeMs: string | null;
  lastActiveAt: string | null;
  rankingExcluded: boolean;
};

export type AdminDormantMiningReport = {
  daysMin: number;
  cutoffMs: string;
  limit: number;
  limitEach: number;
  noMiningPage: number;
  miningNoWalletPage: number;
  noMiningTotal: number;
  miningNoWalletTotal: number;
  note: string;
  noMining: AdminDormantMiningRow[];
  miningNoWallet: AdminDormantMiningRow[];
  error?: string;
};

export async function getAdminDormantMiningAccounts(opts?: {
  daysMin?: number;
  limit?: number;
  noMiningPage?: number;
  miningNoWalletPage?: number;
}): Promise<AdminDormantMiningReport> {
  const empty: AdminDormantMiningReport = {
    daysMin: 30,
    cutoffMs: '',
    limit: 500,
    limitEach: 500,
    noMiningPage: 1,
    miningNoWalletPage: 1,
    noMiningTotal: 0,
    miningNoWalletTotal: 0,
    note: '',
    noMining: [],
    miningNoWallet: []
  };
  const q = new URLSearchParams();
  if (opts?.daysMin != null && opts.daysMin >= 30) q.set('daysMin', String(Math.min(365, Math.floor(opts.daysMin))));
  if (opts?.limit != null && opts.limit > 0) q.set('limit', String(Math.min(500, Math.max(50, Math.floor(opts.limit)))));
  if (opts?.noMiningPage != null && opts.noMiningPage >= 1) q.set('noMiningPage', String(Math.floor(opts.noMiningPage)));
  if (opts?.miningNoWalletPage != null && opts.miningNoWalletPage >= 1) {
    q.set('miningNoWalletPage', String(Math.floor(opts.miningNoWalletPage)));
  }
  const qs = q.toString();
  try {
    const res = await apiFetch(`${base}/admin/accounts-dormant-mining${qs ? `?${qs}` : ''}`);
    if (!res.ok) {
      let msg = `Erro ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      return { ...empty, error: msg };
    }
    const data = (await res.json()) as Partial<AdminDormantMiningReport>;
    const limN = typeof data.limit === 'number' && Number.isFinite(data.limit) ? data.limit : 500;
    return {
      daysMin: typeof data.daysMin === 'number' ? data.daysMin : 30,
      cutoffMs: typeof data.cutoffMs === 'string' ? data.cutoffMs : '',
      limit: limN,
      limitEach: typeof data.limitEach === 'number' && Number.isFinite(data.limitEach) ? data.limitEach : limN,
      noMiningPage: typeof data.noMiningPage === 'number' && Number.isFinite(data.noMiningPage) ? data.noMiningPage : 1,
      miningNoWalletPage:
        typeof data.miningNoWalletPage === 'number' && Number.isFinite(data.miningNoWalletPage)
          ? data.miningNoWalletPage
          : 1,
      noMiningTotal: typeof data.noMiningTotal === 'number' && Number.isFinite(data.noMiningTotal) ? data.noMiningTotal : 0,
      miningNoWalletTotal:
        typeof data.miningNoWalletTotal === 'number' && Number.isFinite(data.miningNoWalletTotal)
          ? data.miningNoWalletTotal
          : 0,
      note: typeof data.note === 'string' ? data.note : '',
      noMining: parseJsonArray<AdminDormantMiningRow>(data.noMining),
      miningNoWallet: parseJsonArray<AdminDormantMiningRow>(data.miningNoWallet)
    };
  } catch {
    return { ...empty, error: 'Erro de rede.' };
  }
}

export type AdminInventoryAuditRow = {
  id: string;
  createdAtMs: number;
  action: string;
  catalogItemId: string | null;
  itemName: string | null;
  instanceId: string | null;
  quantityBefore: number | null;
  quantityAfter: number | null;
  delta: number | null;
  source: string;
  summary: string;
};

export type AdminSessionSnapshotEntry = {
  id: string;
  action: string;
  createdAt: number;
  snapshot: Record<string, unknown>;
  display?: ActivityEventDisplay;
};

export async function getAdminUserActivity(
  email: string,
  opts?: {
    userId?: number;
    limit?: number;
    beforeMs?: number;
    filterId?: string;
    search?: string;
    category?: string;
    severity?: string;
  }
): Promise<{
  logs: GameUserActivityEntry[];
  error?: string;
  activityLogNote?: string;
  accountCreatedAtMs?: number | null;
  hasMore?: boolean;
  nextCursor?: number | null;
}> {
  const q = new URLSearchParams();
  const uid = opts?.userId;
  if (uid != null && Number.isFinite(uid) && uid > 0) q.set('userId', String(Math.floor(uid)));
  else {
    const em = email.trim().toLowerCase();
    if (!em) return { logs: [], error: 'Indique o email ou username do jogador.' };
    q.set('email', em);
  }
  if (opts?.limit != null && opts.limit > 0) q.set('limit', String(Math.min(100, opts.limit)));
  if (opts?.beforeMs != null && opts.beforeMs > 0) q.set('beforeMs', String(Math.floor(opts.beforeMs)));
  if (opts?.filterId) q.set('filterId', opts.filterId);
  if (opts?.search) q.set('search', opts.search);
  if (opts?.category) q.set('category', opts.category);
  if (opts?.severity) q.set('severity', opts.severity);
  try {
    const res = await apiFetch(`${base}/admin/user-activity?${q.toString()}`);
    if (!res.ok) {
      let msg = `Erro ${res.status}`;
      try {
        const j = await res.json();
        if (j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      return { logs: [], error: msg };
    }
    const data = (await res.json()) as {
      logs?: GameUserActivityEntry[];
      activityLogNote?: string;
      accountCreatedAtMs?: number | null;
      hasMore?: boolean;
      nextCursor?: number | null;
    };
    const note = typeof data.activityLogNote === 'string' ? data.activityLogNote : undefined;
    const rawMs = data.accountCreatedAtMs;
    const accountCreatedAtMs =
      typeof rawMs === 'number' && Number.isFinite(rawMs) && rawMs > 0 ? Math.floor(rawMs) : null;
    return {
      logs: Array.isArray(data.logs) ? data.logs : [],
      hasMore: data.hasMore,
      nextCursor: data.nextCursor ?? null,
      ...(note ? { activityLogNote: note } : {}),
      accountCreatedAtMs
    };
  } catch {
    return { logs: [], error: 'Erro de rede.' };
  }
}

export async function getAdminUserInventoryAudit(
  userId: number,
  opts?: { page?: number; limit?: number; fromMs?: number; toMs?: number; lossesOnly?: boolean }
): Promise<{ total: number; page: number; limit: number; rows: AdminInventoryAuditRow[] } | null> {
  const q = new URLSearchParams();
  if (opts?.page) q.set('page', String(opts.page));
  if (opts?.limit) q.set('limit', String(opts.limit));
  if (opts?.fromMs) q.set('from', String(opts.fromMs));
  if (opts?.toMs) q.set('to', String(opts.toMs));
  if (opts?.lossesOnly) q.set('lossesOnly', 'true');
  try {
    const res = await apiFetch(`${base}/admin/users/${userId}/inventory-audit?${q}`);
    if (!res.ok) return null;
    return (await res.json()) as { total: number; page: number; limit: number; rows: AdminInventoryAuditRow[] };
  } catch {
    return null;
  }
}

export async function getAdminUserSessionSnapshots(
  userId: number,
  limit = 20
): Promise<{
  snapshots: AdminSessionSnapshotEntry[];
  diffs: Array<{
    snapshotId: string;
    createdAt: number;
    fingerprintChanged: boolean;
    inventoryDiff: Array<{ itemId: string; before: number; after: number; delta: number }>;
  }>;
} | null> {
  try {
    const res = await apiFetch(`${base}/admin/users/${userId}/session-snapshots?limit=${limit}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export type AdminAccountTraceTimelineEvent = {
  id: string;
  atMs: number;
  source: string;
  kind: string;
  action: string;
  title: string;
  summary: string;
  lines?: string[];
  severity: string;
  category: string;
  meta?: Record<string, unknown>;
};

export type AdminAccountTraceResponse = {
  summary: Record<string, unknown>;
  currentInventory: unknown[];
  currentRigs: unknown[];
  shopPurchases: unknown[];
  boxOpenings: unknown[];
  itemDisposition: unknown[];
  timeline: AdminAccountTraceTimelineEvent[];
  timelineHasMore: boolean;
  timelineNextCursor: number | null;
};

export async function getAdminUserAccountTrace(
  userId: number,
  opts?: { fromMs?: number; toMs?: number; timelineLimit?: number; timelineBeforeMs?: number }
): Promise<{ data: AdminAccountTraceResponse | null; error?: string }> {
  const q = new URLSearchParams();
  if (opts?.fromMs) q.set('fromMs', String(opts.fromMs));
  if (opts?.toMs) q.set('toMs', String(opts.toMs));
  if (opts?.timelineLimit) q.set('timelineLimit', String(opts.timelineLimit));
  if (opts?.timelineBeforeMs) q.set('timelineBeforeMs', String(opts.timelineBeforeMs));
  try {
    const res = await apiFetch(`${base}/admin/users/${userId}/account-trace?${q}`);
    if (!res.ok) {
      let msg = `Erro ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      return { data: null, error: msg };
    }
    return { data: (await res.json()) as AdminAccountTraceResponse };
  } catch {
    return { data: null, error: 'Erro de rede.' };
  }
}

export type AdminSuspiciousEmailReason = string;

export type AdminSuspiciousEmailUserRow = {
  id: number;
  username: string;
  email: string;
  emailDomain: string | null;
  status: 'active' | 'blocked';
  accessLevel: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  walletAddress: string | null;
  emailVerified: boolean | null;
  totalHash: number;
  totalMinedUsd: number;
  totalDepositedUsdc: number;
  hasMinedFlag: boolean;
  referrer: { id: number | null; username: string | null; email: string | null } | null;
  riskScore: number;
  riskLevel: 'minimal' | 'low' | 'medium' | 'high';
  reasons: AdminSuspiciousEmailReason[];
};

export type AdminSuspiciousEmailsReport = {
  ok: boolean;
  summary: {
    totalSuspicious: number;
    domainNotTrusted: number;
    invalidFormat: number;
    temporaryDomains: number;
    fakePatterns: number;
    duplicates: number;
    unverified: number;
    suspiciousDomain: number;
    deadAccounts: number;
    referralOnly: number;
    highRisk: number;
    totalActiveFiltered?: number;
  };
  trustedDomains?: string[];
  domainStats: Array<{ domain: string; count: number; reason: string }>;
  users: AdminSuspiciousEmailUserRow[];
  pagination: { page: number; limit: number; total: number };
  meta?: { note?: string; unverifiedEmailSupported?: boolean };
  error?: string;
};

export async function getAdminSuspiciousEmails(opts?: {
  q?: string;
  reason?: string;
  status?: string;
  domain?: string;
  activity?: string;
  page?: number;
  limit?: number;
  sort?: string;
}): Promise<AdminSuspiciousEmailsReport> {
  const emptySummary = {
    totalSuspicious: 0,
    domainNotTrusted: 0,
    invalidFormat: 0,
    temporaryDomains: 0,
    fakePatterns: 0,
    duplicates: 0,
    unverified: 0,
    suspiciousDomain: 0,
    deadAccounts: 0,
    referralOnly: 0,
    highRisk: 0,
    totalActiveFiltered: 0
  };
  const q = new URLSearchParams();
  if (opts?.q) q.set('q', opts.q.slice(0, 200));
  if (opts?.reason) q.set('reason', opts.reason);
  if (opts?.status) q.set('status', opts.status);
  if (opts?.domain) q.set('domain', opts.domain.slice(0, 200));
  if (opts?.activity) q.set('activity', opts.activity);
  if (opts?.page != null && opts.page >= 1) q.set('page', String(Math.floor(opts.page)));
  if (opts?.limit != null && opts.limit >= 1) q.set('limit', String(Math.min(100, Math.floor(opts.limit))));
  if (opts?.sort) q.set('sort', opts.sort);
  const qs = q.toString();
  try {
    const res = await apiFetch(`${base}/admin/users/suspicious-emails${qs ? `?${qs}` : ''}`);
    if (!res.ok) {
      let msg = `Erro ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        summary: emptySummary,
        domainStats: [],
        users: [],
        pagination: { page: 1, limit: 50, total: 0 },
        error: msg
      };
    }
    const data = (await res.json()) as Partial<AdminSuspiciousEmailsReport>;
    return {
      ok: data.ok !== false,
      summary: { ...emptySummary, ...(data.summary || {}) },
      trustedDomains: data.trustedDomains,
      domainStats: Array.isArray(data.domainStats) ? data.domainStats : [],
      users: Array.isArray(data.users) ? data.users : [],
      pagination: data.pagination || { page: 1, limit: 50, total: 0 },
      meta: data.meta
    };
  } catch {
    return {
      ok: false,
      summary: emptySummary,
      domainStats: [],
      users: [],
      pagination: { page: 1, limit: 50, total: 0 },
      error: 'Erro de rede.'
    };
  }
}

export function getAdminSuspiciousEmailsExportUrl(opts?: {
  q?: string;
  reason?: string;
  status?: string;
  domain?: string;
  activity?: string;
  sort?: string;
}): string {
  const q = new URLSearchParams();
  if (opts?.q) q.set('q', opts.q.slice(0, 200));
  if (opts?.reason) q.set('reason', opts.reason);
  if (opts?.status) q.set('status', opts.status);
  if (opts?.domain) q.set('domain', opts.domain.slice(0, 200));
  if (opts?.activity) q.set('activity', opts.activity);
  if (opts?.sort) q.set('sort', opts.sort);
  const qs = q.toString();
  return `${base}/admin/users/suspicious-emails/export.csv${qs ? `?${qs}` : ''}`;
}

export async function postAdminDeactivateFilteredSuspiciousUsers(opts: {
  q?: string;
  reason?: string;
  status?: string;
  domain?: string;
  activity?: string;
  expectedCount: number;
}): Promise<{ ok: boolean; deactivated?: number; alreadyBlocked?: number; error?: string; code?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/users/suspicious-emails/deactivate-filtered`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: opts.q,
        reason: opts.reason,
        status: opts.status,
        domain: opts.domain,
        activity: opts.activity,
        expectedCount: opts.expectedCount,
        confirm: 'DESATIVAR'
      })
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getReferralModels(): Promise<ReferralModel[]> {
  try {
    const res = await apiFetch(`${base}/admin/referral-models`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function saveReferralModel(model: Partial<ReferralModel>): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/referral-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model)
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: json.error || 'Server error' };
    return { ok: true, ...json };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
  }
}

export async function deleteReferralModel(id: number): Promise<{ ok: boolean }> {
  try {
    const res = await apiFetch(`${base}/admin/referral-models/${id}`, { method: 'DELETE' });
    return await res.json();
  } catch {
    return { ok: false };
  }
}

export async function getAccessLevelReferralAssignments(): Promise<Record<string, number>> {
  try {
    const res = await apiFetch(`${base}/admin/access-level-referral-assignments`);
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

export async function saveAccessLevelReferralAssignments(
  assignments: Record<string, number | null>
): Promise<{ ok: boolean }> {
  try {
    const res = await apiFetch(`${base}/admin/access-level-referral-assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments })
    });
    return await res.json();
  } catch {
    return { ok: false };
  }
}

export async function getAdminRanking(): Promise<unknown> {
  const res = await apiFetch(`${base}/admin/ranking`);
  if (!res.ok) throw new Error('Failed to fetch');
  return await res.json();
}

export async function getPublicRanking(): Promise<unknown> {
  const res = await apiFetch(`${base}/ranking/public`);
  if (!res.ok) throw new Error('Failed to fetch');
  return await res.json();
}

export async function updateCoinBalance(
  userId: number,
  coinId: string,
  amount: number
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/update-coin-balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, coinId, amount })
    });
    return await res.json();
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function bulkUpdateCoinBalance(
  coinId: string,
  amount: number
): Promise<{ ok: boolean; count?: number; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/bulk-update-coin-balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coinId, amount })
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : 'Erro de conexão' };
    }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Erro de rede' };
  }
}

export async function setAccessLevels(levels: unknown[]): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/access-levels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(levels)
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: j.error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}
