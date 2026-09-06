/**
 * Lojinha Miner (hardware store) — player view.
 * Ported from `legacy/frontend/components/UpgradeShop.tsx`.
 */
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useT } from '../../../shared/i18n';
import {
  ShoppingCart,
  DollarSign,
  Package,
  Zap,
  Battery,
  Plus,
  Minus,
  Trash2,
  CheckCircle2,
  X,
  Hexagon,
  Clock,
  List,
  Cpu,
  Server,
  Plug,
  Search,
  Filter
} from 'lucide-react';
import {
  getShopState,
  postShopCartItem,
  clearShopCart,
  deleteShopCartLine,
  postShopCheckout,
  type ShopStateV1Ok,
  type ShopProductApi,
  type ShopCartLineApi
} from '../../../shared/api/shop';
import { newWheelIdempotencyKey } from '../../../shared/api/wheel';
import { normalizePublicAssetUrl } from '../../../shared/utils/public-url';
import { UiNoticeModal, type UiNotice } from '../../../shared/ui/UiNoticeModal';
import type { Upgrade } from '../../servers/types';

const UPGRADE_TYPES = new Set(['machine', 'infrastructure', 'battery', 'wiring', 'multiplier']);

function mapShopProductToUpgrade(p: ShopProductApi): Upgrade {
  const upgradeType = UPGRADE_TYPES.has(p.type) ? (p.type as Upgrade['type']) : 'machine';
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    type: upgradeType,
    baseCost: p.baseCost,
    baseProduction: p.baseProduction,
    powerConsumption: p.powerConsumption,
    powerCapacity: p.powerCapacity,
    multiplier: p.multiplier,
    slotsCapacity: p.slotsCapacity,
    aiSlotsCapacity: p.aiSlotsCapacity,
    description: p.description,
    icon: p.icon,
    status: (p.status === 'normal' || p.status === 'legacy' || p.status === 'exclusive' || p.status === 'limited'
      ? p.status
      : 'normal') as Upgrade['status'],
    maxGlobalStock: p.maxGlobalStock,
    totalSold: p.totalSold,
    image: p.image,
    compatibleRacks: p.compatibleRacks,
    sellInHardwareMarket: p.sellInHardwareMarket,
    isActive: p.isActive,
    isNft: p.isNft
  };
}

function qtyOnLines(lines: ShopCartLineApi[], productId: string): number {
  let s = 0;
  for (const ln of lines) {
    if (ln.productId === productId) s += ln.qty;
  }
  return s;
}

export type ShopPageProps = {
  /** Override opcional; preferir `usdc` devolvido pelo estado da loja. */
  usdcBalance?: number;
  onUsdcChange?: (n: number) => void;
  onGoToWallet?: () => void;
  user?: { email?: string; username?: string } | null;
};

const DEBOUNCE_MS = 380;

type RarityFilter = '' | 'normal' | 'limited' | 'exclusive' | 'legacy';

function isEventItem(u: Upgrade): boolean {
  if (u.status === 'limited') return true;
  const cat = String(u.category || '').toLowerCase();
  return cat.includes('evento') || cat.includes('event');
}

/** Nome legível p/ rack: prefer catalog name; senão humaniza id cru (merge_rack_…). */
function rackCompatLabel(rid: string, catalogName?: string): string {
  if (catalogName && catalogName.trim()) return catalogName;
  const cleaned = rid
    .replace(/^merge[_-]?rack[_-]?/i, '')
    .replace(/_[a-f0-9]{6,}$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return cleaned || rid;
}

const SHOP_TAB_BTN =
  'min-h-10 shrink-0 rounded-lg border px-3 py-2 text-xs font-bold uppercase flex items-center gap-2 whitespace-nowrap transition-colors sm:min-h-0';

const SHOP_CHIP_BTN =
  'min-h-9 rounded-md border px-2.5 py-1.5 text-[11px] font-bold uppercase flex items-center gap-1 sm:min-h-0 sm:px-2 sm:py-1 sm:text-[10px]';

export function ShopPage({ usdcBalance, onUsdcChange, onGoToWallet, user }: ShopPageProps) {
  const t = useT();
  const rarityLabel = (status: Upgrade['status']): string => {
    if (status === 'limited') return t('shop.limited');
    if (status === 'exclusive') return t('shop.exclusive');
    if (status === 'legacy') return t('shop.legacy');
    return t('shop.normal');
  };
  const [shop, setShop] = useState<ShopStateV1Ok | null>(null);
  const [shopError, setShopError] = useState<string | null>(null);
  const [shopLoading, setShopLoading] = useState(true);
  const [notice, setNotice] = useState<UiNotice | null>(null);
  const [filterType, setFilterType] = useState<string>('machine');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterNftOnly, setFilterNftOnly] = useState(false);
  const [filterEventOnly, setFilterEventOnly] = useState(false);
  const [filterCategory, setFilterCategory] = useState('');
  const [filterRarity, setFilterRarity] = useState<RarityFilter>('');
  const [filterMinHs, setFilterMinHs] = useState('');
  const [filterMaxHs, setFilterMaxHs] = useState('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [confirmCheckoutOpen, setConfirmCheckoutOpen] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [syncingProductId, setSyncingProductId] = useState<string | null>(null);
  const checkoutIdemKeyRef = useRef<string | null>(null);
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const refreshShop = useCallback(async () => {
    if (!user?.email) {
      setShopLoading(false);
      setShop(null);
      setShopError(t('shop.loginRequired'));
      return;
    }
    setShopLoading(true);
    setShopError(null);
    const out = await getShopState();
    setShopLoading(false);
    if (out.ok !== true) {
      setShop(null);
      setShopError(out.error || t('shop.loadFailed'));
      return;
    }
    setShop(out);
    if (typeof out.usdc === 'number' && Number.isFinite(out.usdc)) {
      onUsdcChange?.(out.usdc);
    }
  }, [user?.email, onUsdcChange, t]);

  useEffect(() => {
    void refreshShop();
  }, [refreshShop]);

  useEffect(() => {
    return () => {
      Object.values(debounceTimers.current).forEach((t) => clearTimeout(t));
    };
  }, []);

  const applyShopFromResponse = useCallback(
    (next?: ShopStateV1Ok) => {
      if (!next) return;
      setShop(next);
      if (typeof next.usdc === 'number' && Number.isFinite(next.usdc)) {
        onUsdcChange?.(next.usdc);
      }
    },
    [onUsdcChange]
  );

  const productNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of shop?.products ?? []) {
      m.set(p.id, p.name);
    }
    return m;
  }, [shop?.products]);

  const displayUpgrades = useMemo(() => {
    if (!shop?.products?.length) return [];
    return shop.products.map((p) => mapShopProductToUpgrade(p));
  }, [shop]);

  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const u of displayUpgrades) {
      if (u.category) set.add(u.category);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [displayUpgrades]);

  const filteredUpgrades = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const minHs = filterMinHs.trim() ? Number(filterMinHs.replace(',', '.')) : NaN;
    const maxHs = filterMaxHs.trim() ? Number(filterMaxHs.replace(',', '.')) : NaN;

    return displayUpgrades
      .filter((u) => {
        if (filterType === 'nft') {
          if (!u.isNft) return false;
        } else if (filterType !== 'all' && u.type !== filterType) {
          return false;
        }
        if (filterNftOnly && !u.isNft) return false;
        if (filterEventOnly && !isEventItem(u)) return false;
        if (filterCategory && u.category !== filterCategory) return false;
        if (filterRarity && u.status !== filterRarity) return false;
        if (Number.isFinite(minHs) && (u.baseProduction || 0) < minHs) return false;
        if (Number.isFinite(maxHs) && (u.baseProduction || 0) > maxHs) return false;
        if (q && !u.name.toLowerCase().includes(q) && !String(u.category || '').toLowerCase().includes(q)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.baseCost - b.baseCost);
  }, [
    displayUpgrades,
    filterType,
    searchQuery,
    filterNftOnly,
    filterEventOnly,
    filterCategory,
    filterRarity,
    filterMinHs,
    filterMaxHs
  ]);

  const cartLines = shop?.cart.lines ?? [];
  const cartTotal = shop?.cart.totalUsdc ?? 0;
  const reserveUsdc = shop?.usdc ?? usdcBalance ?? 0;
  const hardwareOpen = shop?.hardwareMarketEnabled ?? false;

  const getSingleNextCost = (upgradeId: string) => {
    const u = displayUpgrades.find((x) => x.id === upgradeId);
    if (!u) return 0;
    return u.baseCost;
  };

  const flushQtyUpdate = useCallback(
    async (productId: string, quantity: number) => {
      setSyncingProductId(productId);
      const r = await postShopCartItem(productId, quantity);
      setSyncingProductId(null);
      if (r.ok && r.shop) {
        applyShopFromResponse(r.shop);
        return;
      }
      if (r.status === 409 || r.status === 422) {
        await refreshShop();
        setNotice({
          variant: 'error',
          title: t('shop.title'),
          message: r.error || t('shop.cartUpdated')
        });
        return;
      }
      setNotice({
        variant: 'error',
        title: t('shop.title'),
        message: r.error || t('shop.cartUpdateFailed')
      });
      await refreshShop();
    },
    [applyShopFromResponse, refreshShop, t]
  );

  const scheduleQtyUpdate = useCallback(
    (productId: string, quantity: number) => {
      const prev = debounceTimers.current[productId];
      if (prev) clearTimeout(prev);
      debounceTimers.current[productId] = setTimeout(() => {
        delete debounceTimers.current[productId];
        void flushQtyUpdate(productId, quantity);
      }, DEBOUNCE_MS);
    },
    [flushQtyUpdate]
  );

  const handleAddToCart = (id: string, delta: number) => {
    const u = displayUpgrades.find((x) => x.id === id);
    const current = qtyOnLines(cartLines, id);
    const newAmount = Math.max(0, current + delta);
    if (u && u.status === 'limited' && newAmount > 0) {
      const max = u.maxGlobalStock ?? 0;
      const sold = u.totalSold ?? 0;
      const available = Math.max(0, max - sold);
      if (newAmount > available) return;
    }
    void scheduleQtyUpdate(id, newAmount);
  };

  const handleRemoveLine = async (lineId: string) => {
    setSyncingProductId('__line__');
    const r = await deleteShopCartLine(lineId);
    setSyncingProductId(null);
    if (r.ok && r.shop) applyShopFromResponse(r.shop);
    else {
      await refreshShop();
      setNotice({
        variant: 'error',
        title: t('shop.title'),
        message: r.error || t('shop.removeLineFailed')
      });
    }
  };

  const handleClearCart = async () => {
    setSyncingProductId('__clear__');
    const r = await clearShopCart();
    setSyncingProductId(null);
    if (r.ok && r.shop) applyShopFromResponse(r.shop);
    else {
      await refreshShop();
      setNotice({
        variant: 'error',
        title: t('shop.title'),
        message: r.error || t('shop.clearCartFailed')
      });
    }
  };

  const handleCheckoutClick = () => {
    if (cartTotal === 0 || reserveUsdc < cartTotal || !hardwareOpen) return;
    checkoutIdemKeyRef.current = newWheelIdempotencyKey();
    setConfirmCheckoutOpen(true);
  };

  const confirmHardwareCheckout = async () => {
    if (reserveUsdc < cartTotal || checkoutBusy) return;
    const idem = checkoutIdemKeyRef.current;
    if (!idem) return;
    setCheckoutBusy(true);
    const res = await postShopCheckout(idem);
    setCheckoutBusy(false);
    if (res.ok === true) {
      onUsdcChange?.(res.newUsdc);
      if (res.shop) applyShopFromResponse(res.shop);
      else await refreshShop();
      setConfirmCheckoutOpen(false);
      checkoutIdemKeyRef.current = null;
      const orderBit = res.orderId ? ` Pedido: ${res.orderId.slice(0, 8)}…` : '';
      setNotice({
        variant: 'success',
        title: t('shop.title'),
        message: `${t('shop.purchaseDone')}${orderBit}`
      });
      return;
    }
    if (res.status === 409 || res.status === 422) {
      await refreshShop();
      const mismatch =
        res.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH'
          ? 'Esta confirmação já foi tratada ou a chave de idempotência não corresponde ao carrinho atual. Os dados foram atualizados.'
          : res.error ||
            'O carrinho ou o saldo mudou no servidor. Os dados foram atualizados — verifique novamente antes de confirmar.';
      setNotice({
        variant: 'error',
        title: t('shop.title'),
        message: mismatch
      });
      setConfirmCheckoutOpen(false);
      return;
    }
    if (res.missing != null && onGoToWallet) {
      onGoToWallet();
    }
    setNotice({
      variant: 'error',
      title: t('shop.title'),
      message: res.error || t('shop.checkoutFailed')
    });
  };

  useEffect(() => {
    if (!confirmCheckoutOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmCheckoutOpen(false);
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [confirmCheckoutOpen]);

  const formatProduction = (val: number) => {
    if (val < 0.0001) return val.toFixed(8);
    if (val < 1) return val.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(val);
  };

  const formatCost = (val: number) => {
    if (val === 0) return '0.00';
    if (val < 0.0001) return val.toFixed(8);
    if (val < 1) return val.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 4 });
    return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
  };

  const cartItemsList = cartLines
    .map((ln) => {
      const u = displayUpgrades.find((x) => x.id === ln.productId);
      if (!u) return null;
      return { ...u, lineId: ln.lineId, count: ln.qty, cost: ln.lineTotal };
    })
    .filter(Boolean) as (Upgrade & { lineId: string; count: number; cost: number })[];

  const cartCountSum = cartLines.reduce((a, ln) => a + ln.qty, 0);

  return (
    <div className="relative m-2 flex flex-col rounded-xl border border-slate-200 bg-white shadow-xl transition-colors sm:m-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="z-20 flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 p-3 shadow-md sm:p-4 dark:border-slate-800 dark:bg-slate-950">
        <h2 className="flex min-w-0 items-center gap-2 text-lg font-bold text-amber-600 sm:text-xl dark:text-amber-500">
          <Package size={20} className="shrink-0" /> <span className="truncate">{t('shop.title')}</span>
        </h2>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[10px] uppercase tracking-wide text-slate-500 sm:text-xs">{t('shop.usdcReserve')}</span>
          <span className="flex items-center font-mono text-sm font-bold text-green-600 dark:text-green-400">
            <DollarSign size={12} /> {formatCost(reserveUsdc)}
          </span>
          {shopError && <span className="max-w-[140px] text-right text-[10px] text-red-500 sm:max-w-[200px]">{shopError}</span>}
          {shopLoading && <span className="text-[10px] text-slate-500">{t('shop.syncing')}</span>}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col bg-slate-50 dark:bg-slate-900/50">
          <div className="custom-scrollbar flex shrink-0 gap-2 overflow-x-auto overscroll-x-contain border-b border-slate-200 bg-slate-100 p-2 dark:border-slate-800 dark:bg-slate-900/50 [-webkit-overflow-scrolling:touch]">
            <button
              type="button"
              onClick={() => setFilterType('all')}
              className={`${SHOP_TAB_BTN} ${
                filterType === 'all'
                  ? 'border-amber-500 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
                  : 'border-slate-200 bg-white text-slate-500 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:hover:text-slate-300'
              }`}
            >
              <List size={14} /> {t('shop.filterAll')}
            </button>
            <button
              type="button"
              onClick={() => setFilterType('machine')}
              className={`${SHOP_TAB_BTN} ${
                filterType === 'machine'
                  ? 'border-amber-500 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
                  : 'border-slate-200 bg-white text-slate-500 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:hover:text-slate-300'
              }`}
            >
              <Cpu size={14} /> {t('shop.filterGpus')}
            </button>
            <button
              type="button"
              onClick={() => setFilterType('infrastructure')}
              className={`${SHOP_TAB_BTN} ${
                filterType === 'infrastructure'
                  ? 'border-amber-500 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
                  : 'border-slate-200 bg-white text-slate-500 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:hover:text-slate-300'
              }`}
            >
              <Server size={14} /> {t('shop.filterRigs')}
            </button>
            <button
              type="button"
              onClick={() => setFilterType('battery')}
              className={`${SHOP_TAB_BTN} ${
                filterType === 'battery'
                  ? 'border-amber-500 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
                  : 'border-slate-200 bg-white text-slate-500 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:hover:text-slate-300'
              }`}
            >
              <Battery size={14} /> {t('shop.filterBatteries')}
            </button>
            <button
              type="button"
              onClick={() => setFilterType('wiring')}
              className={`${SHOP_TAB_BTN} ${
                filterType === 'wiring'
                  ? 'border-amber-500 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
                  : 'border-slate-200 bg-white text-slate-500 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:hover:text-slate-300'
              }`}
            >
              <Plug size={14} /> {t('shop.filterWiring')}
            </button>
            <button
              type="button"
              onClick={() => setFilterType('multiplier')}
              className={`${SHOP_TAB_BTN} ${
                filterType === 'multiplier'
                  ? 'border-amber-500 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
                  : 'border-slate-200 bg-white text-slate-500 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:hover:text-slate-300'
              }`}
            >
              <Zap size={14} /> {t('shop.filterAiChips')}
            </button>
            <button
              type="button"
              onClick={() => setFilterType('nft')}
              className={`${SHOP_TAB_BTN} ${
                filterType === 'nft'
                  ? 'border-amber-500 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
                  : 'border-slate-200 bg-white text-slate-500 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:hover:text-slate-300'
              }`}
            >
              <Hexagon size={14} /> {t('inventory.nft')}
            </button>
          </div>

          <div className="shrink-0 space-y-2 border-b border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900/80 sm:p-3">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('shop.searchPlaceholder')}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 sm:py-2 sm:text-xs"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowAdvancedFilters((v) => !v)}
                className={`${SHOP_CHIP_BTN} ${
                  showAdvancedFilters
                    ? 'border-amber-500 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
                    : 'border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800'
                }`}
              >
                <Filter size={12} /> {t('shop.filters')}
              </button>
              <button
                type="button"
                onClick={() => setFilterNftOnly((v) => !v)}
                className={`${SHOP_CHIP_BTN} ${
                  filterNftOnly
                    ? 'border-orange-500 bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-400'
                    : 'border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800'
                }`}
              >
                {t('inventory.nft')}
              </button>
              <button
                type="button"
                onClick={() => setFilterEventOnly((v) => !v)}
                className={`${SHOP_CHIP_BTN} ${
                  filterEventOnly
                    ? 'border-yellow-500 bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400'
                    : 'border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800'
                }`}
              >
                {t('shop.event')}
              </button>
              {(filterNftOnly ||
                filterEventOnly ||
                filterCategory ||
                filterRarity ||
                filterMinHs ||
                filterMaxHs ||
                searchQuery) && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setFilterNftOnly(false);
                    setFilterEventOnly(false);
                    setFilterCategory('');
                    setFilterRarity('');
                    setFilterMinHs('');
                    setFilterMaxHs('');
                  }}
                  className={`${SHOP_CHIP_BTN} border-red-200 text-red-500 dark:border-red-900/50`}
                >
                  {t('shop.clear')}
                </button>
              )}
            </div>
            {showAdvancedFilters && (
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <select
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value)}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 sm:py-1.5 sm:text-[10px]"
                >
                  <option value="">{t('shop.categoryAll')}</option>
                  {categoryOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select
                  value={filterRarity}
                  onChange={(e) => setFilterRarity(e.target.value as RarityFilter)}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 sm:py-1.5 sm:text-[10px]"
                >
                  <option value="">{t('shop.rarityAll')}</option>
                  <option value="normal">{t('shop.normal')}</option>
                  <option value="limited">{t('shop.limited')}</option>
                  <option value="exclusive">{t('shop.exclusive')}</option>
                  <option value="legacy">{t('shop.legacy')}</option>
                </select>
                <input
                  type="text"
                  inputMode="decimal"
                  value={filterMinHs}
                  onChange={(e) => setFilterMinHs(e.target.value)}
                  placeholder="H/s mín."
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 sm:py-1.5 sm:text-[10px]"
                />
                <input
                  type="text"
                  inputMode="decimal"
                  value={filterMaxHs}
                  onChange={(e) => setFilterMaxHs(e.target.value)}
                  placeholder="H/s máx."
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 sm:py-1.5 sm:text-[10px]"
                />
              </div>
            )}
          </div>

          <div className="custom-scrollbar space-y-2 p-2 pb-4 sm:p-3" style={{ WebkitOverflowScrolling: 'touch' }}>
            {filteredUpgrades.map((upgrade) => {
              const nextCost = getSingleNextCost(upgrade.id);
              const canAffordOne = reserveUsdc >= cartTotal + nextCost;
              const isMachine = upgrade.type === 'machine';
              const isRack = upgrade.type === 'infrastructure';
              const isBattery = upgrade.type === 'battery';
              const inCart = qtyOnLines(cartLines, upgrade.id);
              const rackNames =
                Array.isArray(upgrade.compatibleRacks) && upgrade.compatibleRacks.length > 0
                  ? upgrade.compatibleRacks.map((rid) =>
                      rackCompatLabel(rid, productNameById.get(rid))
                    )
                  : [];
              const compFull = rackNames.length ? rackNames.join(', ') : t('shop.anyCompatibleRack');
              const compPreview =
                rackNames.length > 4
                  ? `${rackNames.slice(0, 3).join(', ')} +${rackNames.length - 3}`
                  : compFull;
              const rowBusy = syncingProductId === upgrade.id;

              const containerAspectRatio = isRack ? 'aspect-[5/6]' : 'aspect-square';

              return (
                <div
                  key={upgrade.id}
                  className={`
                            relative flex w-full flex-col gap-3 rounded-lg border p-3 text-left transition-all duration-200 sm:flex-row sm:items-stretch
                            ${
                              inCart > 0
                                ? 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20'
                                : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'
                            }
                          `}
                >
                  <div
                    className={`
                            ${containerAspectRatio} relative mx-auto flex w-full max-w-[11rem] shrink-0 items-center justify-center overflow-hidden rounded-md border transition-colors group sm:mx-0 sm:w-28 sm:max-w-none
                            ${
                              inCart > 0
                                ? 'border-amber-200 bg-white dark:border-amber-800 dark:bg-slate-900'
                                : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950'
                            }
                          `}
                  >
                    {upgrade.image ? (
                      <img
                        src={normalizePublicAssetUrl(upgrade.image) || upgrade.image}
                        alt={upgrade.name}
                        className="h-full w-full object-contain p-1"
                      />
                    ) : (
                      <span className="relative z-10 text-3xl">{upgrade.icon}</span>
                    )}
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col">
                          <h3 className="text-sm font-bold leading-snug text-slate-800 dark:text-slate-200 break-words">
                            {upgrade.name}
                          </h3>
                          <span className="text-[10px] uppercase tracking-wider text-slate-400">{upgrade.category}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {upgrade.isNft && (
                            <span className="flex items-center gap-0.5 rounded border border-orange-200 bg-orange-100 px-1 text-[9px] text-orange-600 dark:border-orange-800 dark:bg-orange-900 dark:text-orange-300">
                              <Hexagon size={8} /> {t('inventory.nft')}
                            </span>
                          )}
                          {upgrade.status === 'limited' && (
                            <span className="flex items-center gap-0.5 rounded border border-yellow-200 bg-yellow-100 px-1 text-[9px] text-yellow-600 dark:border-yellow-800 dark:bg-yellow-900 dark:text-yellow-300">
                              <Clock size={8} /> LTD
                            </span>
                          )}
                          <span className="rounded border border-slate-200 bg-slate-100 px-1 text-[9px] text-slate-500 dark:border-slate-700 dark:bg-slate-800">
                            {rarityLabel(upgrade.status)}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end">
                        <div
                          className={`font-mono text-sm font-bold tabular-nums ${
                            canAffordOne ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'
                          }`}
                        >
                          ${formatCost(nextCost)}
                        </div>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-col gap-2 sm:mt-1 sm:flex-row sm:items-end sm:justify-between">
                      <div className="min-w-0 flex-1 space-y-0.5">
                        {upgrade.description ? (
                          <div className="text-[11px] leading-relaxed text-slate-500 break-words dark:text-slate-400 sm:text-[10px]">
                            {upgrade.description}
                          </div>
                        ) : null}
                        {isMachine && (
                          <div className="flex items-center gap-2 font-mono text-[11px] text-slate-500 dark:text-slate-400 sm:text-[10px]">
                            <span className="text-green-600 dark:text-green-500/80">
                              +{formatProduction(upgrade.baseProduction)} H/s
                            </span>
                          </div>
                        )}
                        {upgrade.type === 'multiplier' && (
                          <div className="flex items-center gap-2 font-mono text-[11px] text-orange-600 dark:text-orange-400 sm:text-[10px]">
                            <span>+{(((upgrade.multiplier || 0) * 100).toFixed(1))}%</span>
                          </div>
                        )}
                        {isBattery && (
                          <div className="flex items-center gap-1 font-mono text-[11px] text-yellow-600 dark:text-yellow-500/80 sm:text-[10px]">
                            <Battery size={8} /> {upgrade.powerCapacity === -1 ? '∞' : upgrade.powerCapacity?.toLocaleString()} Wh
                          </div>
                        )}
                        {(upgrade.type === 'machine' ||
                          upgrade.type === 'battery' ||
                          upgrade.type === 'wiring' ||
                          upgrade.type === 'multiplier') && (
                          <div
                            className="flex items-start gap-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400 sm:text-[10px]"
                            title={compFull}
                          >
                            <Server size={10} className="mt-0.5 shrink-0" />
                            <span className="min-w-0 break-words [overflow-wrap:anywhere] line-clamp-2">
                              Compatível: {compPreview}
                            </span>
                          </div>
                        )}

                        {upgrade.status === 'limited' && (
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <div className="flex items-center gap-1 rounded border border-amber-200 bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-600 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-500">
                              <Clock size={8} />
                              ESTOQUE: {Math.max(0, (upgrade.maxGlobalStock || 0) - (upgrade.totalSold || 0))} /{' '}
                              {upgrade.maxGlobalStock}
                            </div>
                            <div className="flex items-center gap-1 text-[9px] text-slate-500">
                              VENDIDOS: {upgrade.totalSold || 0}
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center justify-end gap-2 self-end rounded-lg border border-slate-200 bg-slate-100 p-1 dark:border-slate-800 dark:bg-slate-950">
                        <button
                          type="button"
                          onClick={() => handleAddToCart(upgrade.id, -1)}
                          className="flex h-9 w-9 items-center justify-center rounded bg-white text-slate-600 transition-colors hover:bg-red-100 hover:text-red-500 disabled:opacity-30 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-red-900/50 sm:h-6 sm:w-6"
                          disabled={inCart === 0 || rowBusy || shopLoading || !hardwareOpen}
                        >
                          <Minus size={14} className="sm:h-3 sm:w-3" />
                        </button>
                        <span
                          className={`w-8 text-center font-mono text-sm font-bold sm:w-6 sm:text-xs ${
                            inCart > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'
                          }`}
                        >
                          {inCart}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleAddToCart(upgrade.id, 1)}
                          className="flex h-9 w-9 items-center justify-center rounded bg-white text-slate-600 transition-colors hover:bg-green-100 hover:text-green-500 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-600 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-green-900/50 sm:h-6 sm:w-6"
                          disabled={
                            rowBusy ||
                            shopLoading ||
                            !hardwareOpen ||
                            (upgrade.status === 'limited' &&
                              (upgrade.totalSold || 0) + inCart >= (upgrade.maxGlobalStock || 0))
                          }
                          title={
                            upgrade.status === 'limited' &&
                            (upgrade.totalSold || 0) + inCart >= (upgrade.maxGlobalStock || 0)
                              ? t('shop.soldOut')
                              : t('shop.addToCart')
                          }
                        >
                          <Plus size={14} className="sm:h-3 sm:w-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {filteredUpgrades.length === 0 && (
              <div className="py-10 text-center italic text-slate-500 dark:text-slate-400">
                {shopLoading ? t('shop.loadingCatalog') : t('shop.noSkuMatch')}
              </div>
            )}
          </div>
        </div>

        <div className="w-full lg:w-80 shrink-0 bg-white dark:bg-slate-950 border-t lg:border-t-0 lg:border-l border-slate-200 dark:border-slate-800 flex flex-col z-10 shadow-[-5px_0_15px_rgba(0,0,0,0.05)]">
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 bg-slate-50 dark:bg-slate-900">
            <ShoppingCart size={18} className="text-slate-600 dark:text-slate-400" />
            <h3 className="font-bold text-slate-700 dark:text-slate-300">{t('shop.cartTitle')}</h3>
            <span className="bg-amber-100 dark:bg-amber-900 text-amber-600 dark:text-amber-400 text-xs px-2 py-0.5 rounded-full font-bold ml-auto">
              {cartCountSum}
            </span>
          </div>

          <div className="p-4 space-y-3 custom-scrollbar" style={{ WebkitOverflowScrolling: 'touch' }}>
            {cartItemsList.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-400 dark:text-slate-600 gap-2 opacity-50">
                <ShoppingCart size={48} />
                <span className="text-sm font-bold">{t('shop.cartEmpty')}</span>
              </div>
            ) : (
              cartItemsList.map((item) => (
                <div key={item.lineId} className="flex gap-3 items-start animate-in slide-in-from-right-2 duration-300">
                  <div className="w-10 h-10 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex items-center justify-center text-lg shrink-0 overflow-hidden">
                    {item.image ? (
                      <img
                        src={normalizePublicAssetUrl(item.image) || item.image}
                        className="h-full w-full object-contain p-0.5"
                        alt=""
                      />
                    ) : (
                      item.icon
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start">
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate pr-1">{item.name}</span>
                      <button
                        type="button"
                        onClick={() => void handleRemoveLine(item.lineId)}
                        className="text-slate-400 hover:text-red-500 transition-colors disabled:opacity-40"
                        disabled={syncingProductId === '__line__'}
                      >
                        <X size={12} />
                      </button>
                    </div>
                    <div className="flex justify-between items-end mt-1">
                      <div className="text-xs text-slate-500">x{item.count}</div>
                      <div className="font-mono text-xs font-bold text-slate-800 dark:text-slate-300">${formatCost(item.cost)}</div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="p-4 bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 space-y-3">
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-500 uppercase text-xs font-bold">{t('shop.orderTotal')}</span>
              <span
                className={`font-mono font-bold text-lg ${
                  reserveUsdc >= cartTotal ? 'text-green-600 dark:text-green-400' : 'text-red-500'
                }`}
              >
                ${formatCost(cartTotal)}
              </span>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleClearCart()}
                disabled={cartTotal === 0 || syncingProductId === '__clear__'}
                className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-500 hover:text-red-500 transition-colors disabled:opacity-50"
                title={t('shop.emptyCart')}
              >
                <Trash2 size={18} />
              </button>
              {reserveUsdc < cartTotal && onGoToWallet && (
                <button
                  type="button"
                  onClick={() => onGoToWallet()}
                  className="px-3 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold shadow-md"
                >
                  Cobrir déficit (${formatCost(Math.max(0, cartTotal - reserveUsdc))} USDC)
                </button>
              )}
              <button
                type="button"
                onClick={handleCheckoutClick}
                disabled={cartTotal === 0 || reserveUsdc < cartTotal || !hardwareOpen || checkoutBusy || shopLoading}
                className={`
                                flex-1 py-3 rounded-lg font-bold text-xs flex items-center justify-center gap-2 shadow-lg transition-all active:scale-[0.98]
                                ${
                                  cartTotal === 0 ||
                                  reserveUsdc < cartTotal ||
                                  !hardwareOpen ||
                                  checkoutBusy ||
                                  shopLoading
                                    ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
                                    : 'bg-green-600 hover:bg-green-500 text-white shadow-green-500/30'
                                }
                            `}
              >
                {!hardwareOpen
                  ? t('shop.purchasesPaused')
                  : reserveUsdc < cartTotal
                    ? t('shop.insufficientUsdc')
                    : checkoutBusy
                      ? t('shop.processing')
                      : t('shop.confirmPurchase')}{' '}
                <CheckCircle2 size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {confirmCheckoutOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50 dark:bg-slate-950/80 backdrop-blur-sm"
          role="presentation"
          onClick={() => !checkoutBusy && setConfirmCheckoutOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="hw-checkout-title"
            className="max-w-lg w-full max-h-[85vh] overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="hw-checkout-title" className="text-lg font-bold text-slate-900 dark:text-white">
              {t('shop.confirmTitle')}
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {t('shop.confirmBody')}
            </p>
            <ul className="mt-4 space-y-2 border-y border-slate-200 py-3 dark:border-slate-700">
              {cartItemsList.map((item) => (
                <li key={item.lineId} className="flex justify-between text-sm text-slate-700 dark:text-slate-200">
                  <span className="truncate pr-2">
                    {item.name} <span className="text-slate-400">×{item.count}</span>
                  </span>
                  <span className="shrink-0 font-mono font-bold">${formatCost(item.cost)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex justify-between text-sm text-slate-600 dark:text-slate-400">
              <span>{t('shop.currentBalance')}</span>
              <span className="font-mono">${formatCost(reserveUsdc)}</span>
            </div>
            <div className="mt-1 flex justify-between text-base font-bold text-slate-900 dark:text-white">
              <span>Total</span>
              <span className="font-mono text-green-600 dark:text-green-400">${formatCost(cartTotal)}</span>
            </div>
            <div className="mt-1 flex justify-between text-sm text-slate-600 dark:text-slate-400">
              <span>Saldo após</span>
              <span
                className={`font-mono font-bold ${
                  reserveUsdc - cartTotal < 0 ? 'text-red-500' : 'text-slate-800 dark:text-slate-200'
                }`}
              >
                ${formatCost(reserveUsdc - cartTotal)}
              </span>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => !checkoutBusy && setConfirmCheckoutOpen(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {t('shop.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void confirmHardwareCheckout()}
                disabled={reserveUsdc < cartTotal || checkoutBusy}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-bold text-white hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {checkoutBusy ? t('shop.processing') : t('shop.confirmPurchase')}
              </button>
            </div>
          </div>
        </div>
      )}

      <UiNoticeModal notice={notice} onClose={() => setNotice(null)} overlayZClassName="z-[150]" />
    </div>
  );
}

/** Alias legado — preferir `ShopPage`. */
export const UpgradeShop = ShopPage;
