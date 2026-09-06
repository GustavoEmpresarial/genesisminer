/**
 * Mercado Negro P2P — self-fetch via `/api/black-market/*`.
 * Ported from `legacy/frontend/components/BlackMarket.tsx`.
 */
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Skull, DollarSign, PlusCircle, Package, Tag, Trash2, ArrowRight, Lock, ShieldCheck, History, Search } from 'lucide-react';
import {
  getBlackMarketState,
  getBlackMarketListingsPage,
  getBlackMarketEscrow,
  postBlackMarketSell,
  postBlackMarketCancel,
  postBlackMarketReserve,
  postBlackMarketCancelReserve,
  postBlackMarketBuy,
  postBlackMarketClaim,
  postBlackMarketClaimAll,
  postBlackMarketClaimItem,
  type BlackMarketListing,
  type BlackMarketHistoryEntry
} from '../../../shared/api/black-market';
import { subscribeMarketLive } from '../lib/marketLiveSocket';
import { getShopState, type ShopProductApi } from '../../../shared/api/shop';
import { getInventoryState, type InventoryStackableRow } from '../../../shared/api/inventory';
import { normalizePublicAssetUrl } from '../../../shared/utils/public-url';
import { handleImageError } from '../../../shared/utils/image-fallback';
import { UiNoticeModal, type UiNotice } from '../../../shared/ui/UiNoticeModal';
import type { Upgrade } from '../../servers/types';
import { UpgradeMarketSpecLine } from './UpgradeMarketSpecLine';
import { useT } from '../../../shared/i18n';

const UPGRADE_TYPES = new Set(['machine', 'infrastructure', 'battery', 'wiring', 'multiplier']);

const P2P_TYPE_OPTION_KEYS: { value: '' | Upgrade['type']; labelKey: string }[] = [
  { value: '', labelKey: 'blackMarket.typeAll' },
  { value: 'machine', labelKey: 'blackMarket.typeGpus' },
  { value: 'infrastructure', labelKey: 'blackMarket.typeRacks' },
  { value: 'battery', labelKey: 'blackMarket.typeBatteries' },
  { value: 'wiring', labelKey: 'blackMarket.typeWiring' },
  { value: 'multiplier', labelKey: 'blackMarket.typeMultipliers' }
];

function mapShopProductToUpgrade(p: ShopProductApi): Upgrade {
  const t = UPGRADE_TYPES.has(p.type) ? (p.type as Upgrade['type']) : 'machine';
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    type: t,
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
    sellInBlackMarket: true,
    isActive: p.isActive,
    isNft: p.isNft
  };
}

function mapInventoryRowToUpgrade(row: InventoryStackableRow): Upgrade {
  const t = UPGRADE_TYPES.has(row.type) ? (row.type as Upgrade['type']) : 'machine';
  return {
    id: row.catalogItemId,
    name: row.name,
    category: row.category,
    type: t,
    baseCost: 0,
    baseProduction: row.baseProduction,
    powerConsumption: row.powerConsumption,
    powerCapacity: row.powerCapacity,
    slotsCapacity: row.slotsCapacity,
    aiSlotsCapacity: row.aiSlotsCapacity,
    description: row.description,
    icon: row.icon,
    status: 'normal',
    image: row.image ?? undefined,
    compatibleRacks: [],
    sellInBlackMarket: true,
    isActive: true,
    isNft: row.isNft
  };
}

/** Fallback quando o anúncio existe no livro mas o item não está no catálogo local (shop∪inventário). */
function resolveListingCatalogItem(upgrades: Upgrade[], itemId: string): Upgrade {
  const found = upgrades.find((u) => u.id === itemId);
  if (found) return found;
  return {
    id: itemId,
    name: itemId,
    category: 'unknown',
    type: 'machine',
    baseCost: 0,
    baseProduction: 0,
    description: '',
    icon: '📦',
    status: 'normal',
    compatibleRacks: [],
    sellInBlackMarket: true,
    isActive: true
  };
}

function listingImageSrc(item: Pick<Upgrade, 'image' | 'icon'>): string | undefined {
  const raw = item.image?.trim();
  if (!raw) return undefined;
  return normalizePublicAssetUrl(raw) || raw;
}

/** Preço USDC digitado (ex.: "0,1" em PT). `parseFloat("0,1")` dá 0 — evitar isso. */
function parseUsdcInput(raw: string): number {
  const t = String(raw ?? '').trim().replace(/\s/g, '');
  if (!t) return NaN;
  const normalized = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

/** Cofre P2P: API pode enviar buyerPaidUsdc antes de types.ts global ter o campo. */
type CustodyListingRow = BlackMarketListing & { buyerPaidUsdc?: number };

/** Total USDC do lote (preço unit. × qty). Compatível com respostas sem `lineTotal`. */
function p2pLineTotal(l: Pick<BlackMarketListing, 'price' | 'qty' | 'lineTotal'>): number {
  if (l.lineTotal != null && Number.isFinite(l.lineTotal) && l.lineTotal >= 0) return l.lineTotal;
  const q = Math.max(1, Number(l.qty) || 1);
  const u = Number(l.price);
  return (Number.isFinite(u) ? u : 0) * q;
}

function formatSellerLabel(listing: Pick<BlackMarketListing, 'sellerId' | 'sellerName'>): string {
  const name = listing.sellerName?.trim() || '—';
  const sid = listing.sellerId;
  if (sid != null && Number.isFinite(sid) && sid > 0) {
    return `#${sid} · ${name}`;
  }
  return name;
}

function isOwnListing(
  listing: Pick<BlackMarketListing, 'sellerId' | 'sellerName'>,
  currentUserId?: number,
  currentUserName?: string,
  currentUserEmail?: string
): boolean {
  if (currentUserId != null && listing.sellerId != null && listing.sellerId > 0) {
    return listing.sellerId === currentUserId;
  }
  const sn = listing.sellerName?.trim();
  if (!sn) return false;
  return sn === (currentUserName?.trim() || '') || sn === (currentUserEmail?.trim() || '');
}

export type BlackMarketPageProps = {
  user: { id?: string; username: string; email: string };
  onUsdcChange?: (n: number) => void;
};

export function BlackMarketPage({ user, onUsdcChange }: BlackMarketPageProps) {
  const t = useT();
  const currentUserEmail = user.email;
  const currentUserName = user.username;
  const currentUserId = useMemo(() => {
    const raw = user.id?.trim();
    if (!raw || !/^\d+$/.test(raw)) return undefined;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }, [user.id]);

  const [catalogLoading, setCatalogLoading] = useState(true);
  const [upgrades, setUpgrades] = useState<Upgrade[]>([]);
  const [stockMap, setStockMap] = useState<Record<string, number>>({});
  const [isEnabled, setIsEnabled] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [bmPriceBandPercent, setBmPriceBandPercent] = useState<number | null>(null);
  const [mode, setMode] = useState<'buy' | 'sell' | 'vault' | 'history'>('buy');
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const [marketListings, setMarketListings] = useState<BlackMarketListing[]>([]);
  const [myActiveListings, setMyActiveListings] = useState<BlackMarketListing[]>([]);
  const [listingsTotal, setListingsTotal] = useState(0);
  const [buyFilterCategoriesServer, setBuyFilterCategoriesServer] = useState<string[]>([]);
  const [bmSnapshotUsdc, setBmSnapshotUsdc] = useState<number | null>(null);
  const [bmSnapshotBmb, setBmSnapshotBmb] = useState<number | null>(null);
  const [custodyListings, setCustodyListings] = useState<CustodyListingRow[]>([]);
  const [historyPurchases, setHistoryPurchases] = useState<BlackMarketHistoryEntry[]>([]);
  const [historySales, setHistorySales] = useState<BlackMarketHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyTab, setHistoryTab] = useState<'purchases' | 'sales'>('purchases');
  const [historyReloadNonce, setHistoryReloadNonce] = useState(0);
  const [confirmListing, setConfirmListing] = useState<BlackMarketListing | null>(null);
  const [buyQtyDraft, setBuyQtyDraft] = useState('1');
  const [notice, setNotice] = useState<UiNotice | null>(null);
  const [isBuying, setIsBuying] = useState(false);
  const [isClaimingAll, setIsClaimingAll] = useState(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [buySearch, setBuySearch] = useState('');
  const [buyCategory, setBuyCategory] = useState('');
  const [buyType, setBuyType] = useState<'' | Upgrade['type']>('');
  const [buyPriceSort, setBuyPriceSort] = useState<'asc' | 'desc'>('asc');
  const [sellFilterSearch, setSellFilterSearch] = useState('');
  const [sellFilterCategory, setSellFilterCategory] = useState('');
  const [sellFilterType, setSellFilterType] = useState<'' | Upgrade['type']>('');
  const [sellItemId, setSellItemId] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [sellQty, setSellQty] = useState('1');

  const band = Math.min(90, Math.max(1, Number(bmPriceBandPercent ?? 20) || 20));
  const minFactor = 1 - band / 100;
  const maxFactor = 1 + band / 100;

  const syncUsdc = useCallback(
    (n: number) => {
      setBmSnapshotUsdc(n);
      onUsdcChange?.(n);
    },
    [onUsdcChange]
  );

  const bumpRefresh = useCallback(() => {
    setRefreshTrigger((t) => t + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setCatalogLoading(true);
      const [shop, inv] = await Promise.all([getShopState(), getInventoryState()]);
      if (cancelled) return;
      const byId = new Map<string, Upgrade>();
      if (shop.ok) {
        for (const p of shop.products) byId.set(p.id, mapShopProductToUpgrade(p));
      }
      if (inv.ok && inv.data) {
        for (const cat of inv.data.stackableCategories) {
          for (const row of cat.items) {
            if (!byId.has(row.catalogItemId)) {
              byId.set(row.catalogItemId, mapInventoryRowToUpgrade(row));
            }
          }
        }
      }
      setUpgrades([...byId.values()]);
      setCatalogLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const buyFiltersRef = useRef({ buySearch, buyCategory, buyType, buyPriceSort });
  useEffect(() => {
    buyFiltersRef.current = { buySearch, buyCategory, buyType, buyPriceSort };
  }, [buySearch, buyCategory, buyType, buyPriceSort]);

  const buyIdempotencyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    buyIdempotencyKeyRef.current = null;
  }, [confirmListing?.id]);

  const useServerBuyBook = true;
  const walletUsdcDisplay = bmSnapshotUsdc ?? 0;
  const vaultProceedsDisplay = bmSnapshotBmb ?? 0;

  useEffect(() => {
    if (confirmListing) setBuyQtyDraft('1');
  }, [confirmListing]);

  const getMarketPrice = (upgradeId: string) => {
    const def = upgrades.find((u) => u.id === upgradeId);
    if (!def) return 0;
    return def.baseCost;
  };

  const getBandReferencePrice = (upgradeId: string) => {
    const base = getMarketPrice(upgradeId);
    if (base > 0) return base;
    const prices = marketListings
      .filter((l) => l.itemId === upgradeId && (!l.status || l.status === 'active'))
      .map((l) => Number(l.price))
      .filter((p) => Number.isFinite(p) && p > 0);
    const minAsk = prices.length > 0 ? Math.min(...prices) : null;
    return minAsk ?? 0;
  };

  useEffect(() => {
    if (!sellItemId) return;
    const suggest = getBandReferencePrice(sellItemId);
    setSellPrice(suggest > 0 ? String(suggest) : '');
  }, [sellItemId, upgrades, marketListings]);

  const refreshBuyListings = useCallback(async () => {
    const f = buyFiltersRef.current;
    const pg = await getBlackMarketListingsPage({
      search: f.buySearch,
      category: f.buyCategory,
      type: f.buyType,
      sort: f.buyPriceSort,
      limit: 60,
      offset: 0
    });
    if (pg.ok) {
      setMarketListings(pg.items);
      setListingsTotal(pg.total);
    }
  }, []);

  const refreshBuyListingsRef = useRef(refreshBuyListings);
  useEffect(() => {
    refreshBuyListingsRef.current = refreshBuyListings;
  }, [refreshBuyListings]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (mode === 'history') setHistoryLoading(true);
      const st = await getBlackMarketState();
      if (cancelled) return;

      if (st.ok) {
        setIsEnabled(st.enabled);
        syncUsdc(st.usdc);
        setBmSnapshotBmb(st.blackMarketBalance);
        setBmPriceBandPercent(st.priceBandPercent);
        setBuyFilterCategoriesServer(st.buyFilterCategories);
        setMyActiveListings(st.myActiveListings);
        const nextStock: Record<string, number> = {};
        for (const row of st.sellableStock) nextStock[row.itemId] = row.qty;
        setStockMap(nextStock);
        setUpgrades((prev) => {
          const byId = new Map(prev.map((u) => [u.id, u]));
          for (const row of st.sellableStock) {
            const bc = row.baseCost;
            if (!(typeof bc === 'number' && Number.isFinite(bc) && bc > 0)) continue;
            const existing = byId.get(row.itemId);
            if (existing) {
              if (!(existing.baseCost > 0)) {
                byId.set(row.itemId, { ...existing, baseCost: bc });
              }
            } else {
              byId.set(row.itemId, {
                id: row.itemId,
                name: row.itemId,
                category: 'unknown',
                type: 'machine',
                baseCost: bc,
                baseProduction: 0,
                description: '',
                icon: '📦',
                status: 'normal',
                compatibleRacks: [],
                sellInBlackMarket: true,
                isActive: true
              });
            }
          }
          return [...byId.values()];
        });

        if (mode === 'buy') {
          const f = buyFiltersRef.current;
          const pg = await getBlackMarketListingsPage({
            search: f.buySearch,
            category: f.buyCategory,
            type: f.buyType,
            sort: f.buyPriceSort,
            limit: 60,
            offset: 0
          });
          if (cancelled) return;
          if (pg.ok) {
            setMarketListings(pg.items);
            setListingsTotal(pg.total);
          } else {
            setMarketListings(st.listings.items);
            setListingsTotal(st.listings.total);
          }
        } else if (mode === 'vault') {
          setCustodyListings(st.custody as CustodyListingRow[]);
        } else if (mode === 'history') {
          setHistoryPurchases(st.history.purchases);
          setHistorySales(st.history.sales);
          setHistoryLoading(false);
        }
      } else if (mode === 'history') {
        setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, refreshTrigger, historyReloadNonce, syncUsdc]);

  useEffect(() => {
    if (mode !== 'buy') return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        const f = buyFiltersRef.current;
        const pg = await getBlackMarketListingsPage({
          search: f.buySearch,
          category: f.buyCategory,
          type: f.buyType,
          sort: f.buyPriceSort,
          limit: 60,
          offset: 0
        });
        if (cancelled) return;
        if (pg.ok) {
          setMarketListings(pg.items);
          setListingsTotal(pg.total);
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [buySearch, buyCategory, buyType, buyPriceSort, mode]);

  useEffect(() => {
    let stopped = false;
    let debounceTimer: number | null = null;

    const scheduleGameSync = () => {
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        bumpRefresh();
      }, 450);
    };

    let listingsRefreshTimer: number | null = null;
    const refresh = async () => {
      await refreshBuyListingsRef.current();
      if (modeRef.current === 'vault') {
        const custody = await getBlackMarketEscrow();
        setCustodyListings(custody as CustodyListingRow[]);
      }
    };

    const scheduleListingsRefresh = () => {
      if (listingsRefreshTimer !== null) window.clearTimeout(listingsRefreshTimer);
      listingsRefreshTimer = window.setTimeout(() => {
        listingsRefreshTimer = null;
        void refresh();
      }, 400);
    };

    const unsub = subscribeMarketLive({
      onEvent: (payload) => {
        if (stopped) return;
        if (payload.type != null && payload.type !== 'market') return;
        scheduleListingsRefresh();
        if (payload.event && payload.event !== 'hello') scheduleGameSync();
      },
      onConnected: () => {
        if (!stopped) void refresh();
      }
    });

    const onVis = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVis);
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      if (listingsRefreshTimer !== null) window.clearTimeout(listingsRefreshTimer);
      unsub();
    };
  }, [bumpRefresh]);

  const handleSellSubmit = async () => {
    const price = parseUsdcInput(sellPrice);
    const qty = parseInt(sellQty, 10);
    if (!(price > 0 && qty > 0 && sellItemId)) return;

    const res = await postBlackMarketSell(sellItemId, price, qty);
    if (res.ok) {
      setSellPrice('');
      setSellQty('1');
      bumpRefresh();
      setNotice({ variant: 'success', title: t('blackMarket.offerPublished'), message: t('blackMarket.offerLockedHint') });
    } else {
      setNotice({
        variant: 'error',
        title: t('blackMarket.publishFailed'),
        message: res.error || 'Tente novamente em instantes.'
      });
    }
  };

  const handleCancelListing = async (listingId: string) => {
    const res = await postBlackMarketCancel(listingId);
    if (res.ok) {
      bumpRefresh();
      setNotice({ variant: 'success', title: t('blackMarket.offerCancelled'), message: t('blackMarket.stockReturned') });
    } else {
      setNotice({
        variant: 'error',
        title: t('blackMarket.cancelFailed'),
        message: res.error || 'Tente novamente.'
      });
    }
  };

  const formatCost = (val: number) => {
    if (val < 0.0001) return val.toFixed(8);
    if (val < 1) return val.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 4 });
    return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  const sellableItems = useMemo(
    () => upgrades.filter((u) => (stockMap[u.id] || 0) > 0 && u.sellInBlackMarket !== false),
    [upgrades, stockMap]
  );

  const sellableFiltered = useMemo(() => {
    return sellableItems.filter((u) => {
      if (sellFilterCategory && u.category !== sellFilterCategory) return false;
      if (sellFilterType && u.type !== sellFilterType) return false;
      if (sellFilterSearch.trim()) {
        const q = sellFilterSearch.toLowerCase().trim();
        if (!`${u.name} ${u.id} ${u.category}`.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [sellableItems, sellFilterCategory, sellFilterType, sellFilterSearch]);

  useEffect(() => {
    if (sellableFiltered.length > 0) {
      if (!sellableFiltered.some((u) => u.id === sellItemId)) {
        setSellItemId(sellableFiltered[0].id);
      }
    } else if (sellItemId !== '') {
      setSellItemId('');
    }
  }, [sellableFiltered, sellItemId]);

  const buyCategoryOptions = useMemo(() => {
    const set = new Set<string>(buyFilterCategoriesServer);
    for (const l of marketListings) {
      const u = upgrades.find((x) => x.id === l.itemId);
      if (u?.category) set.add(u.category);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'pt'));
  }, [buyFilterCategoriesServer, marketListings, upgrades]);

  const sellCategoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const u of sellableItems) {
      if (u.category) set.add(u.category);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'pt'));
  }, [sellableItems]);

  const buyListingsFromOthers = useMemo(() => {
    return marketListings.filter((listing) => {
      const item = resolveListingCatalogItem(upgrades, listing.itemId);
      if (item.sellInBlackMarket === false) return false;
      if (!useServerBuyBook && isOwnListing(listing, currentUserId, currentUserName, currentUserEmail)) {
        return false;
      }
      return true;
    });
  }, [marketListings, upgrades, currentUserId, currentUserName, currentUserEmail, useServerBuyBook]);

  const filteredBuyListings = useMemo(() => {
    if (useServerBuyBook) return buyListingsFromOthers;
    return buyListingsFromOthers.filter((listing) => {
      const item = resolveListingCatalogItem(upgrades, listing.itemId);
      if (buyCategory && item.category !== buyCategory) return false;
      if (buyType && item.type !== buyType) return false;
      if (buySearch.trim()) {
        const q = buySearch.toLowerCase().trim();
        const hay = `${item.name} ${item.id} ${item.category} ${listing.sellerName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [buyListingsFromOthers, useServerBuyBook, upgrades, buySearch, buyCategory, buyType]);

  const sortedBuyListings = useMemo(() => {
    if (useServerBuyBook) return filteredBuyListings;
    const arr = [...filteredBuyListings];
    arr.sort((a, b) => {
      const pa = Number(a.price);
      const pb = Number(b.price);
      const ua = Number.isFinite(pa) ? pa : 0;
      const ub = Number.isFinite(pb) ? pb : 0;
      const d = ua - ub;
      return buyPriceSort === 'asc' ? d : -d;
    });
    return arr;
  }, [filteredBuyListings, buyPriceSort, useServerBuyBook]);

  const hasActiveBuyFilters = Boolean(buySearch.trim() || buyCategory || buyType);

  const selectedSellItem = upgrades.find(u => u.id === sellItemId);
  const marketPrice = selectedSellItem ? getMarketPrice(selectedSellItem.id) : 0;
  const refPrice = getBandReferencePrice(sellItemId);
  const minAllowed = refPrice * minFactor;
  const maxAllowed = refPrice * maxFactor;
  const parsedSellPrice = parseUsdcInput(sellPrice);
  const parsedSellQty = parseInt(sellQty);
  const publishDisabled = (!sellableItems.length || !sellItemId || !sellPrice || !sellQty || isNaN(parsedSellPrice) || parsedSellPrice <= 0 || isNaN(parsedSellQty) || parsedSellQty <= 0 || parsedSellPrice < minAllowed || parsedSellPrice > maxAllowed);

  /** Configuração das tabs principais (Comprar/Vender/Cofre/Histórico) — declarativo para
   *  manter consistência visual e suportar scroll horizontal em ecrãs pequenos. */
  const tabConfig: { id: 'buy' | 'sell' | 'vault' | 'history'; labelKey: string; badge?: number; icon?: React.ReactNode }[] = [
    { id: 'buy', labelKey: 'blackMarket.tabBuy' },
    { id: 'sell', labelKey: 'blackMarket.tabSell' },
    { id: 'vault', labelKey: 'blackMarket.tabVault', badge: custodyListings.length || 0 },
    { id: 'history', labelKey: 'blackMarket.tabHistory', icon: <History size={14} /> }
  ];

  if (catalogLoading || upgrades.length === 0) {
    return <div className="p-8 text-center text-slate-500 animate-pulse">{t('blackMarket.syncing')}</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col p-2 sm:p-4">
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-2xl transition-colors">
      {/* Background Texture */}
      <div className="pointer-events-none absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/dark-matter.png')] opacity-40"></div>

      {/* Header */}
      <div className="relative z-10 shrink-0 border-b border-slate-800 bg-gradient-to-b from-slate-950 to-slate-950 px-4 pb-3 pt-4 sm:px-6 sm:pt-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-bold text-red-500 sm:text-xl">
              <Skull size={22} /> {t('blackMarket.title')}
            </h2>
            <p className="mt-1 text-[10px] uppercase tracking-widest text-slate-500 sm:text-[11px]">
              {t('blackMarket.subtitle')}
            </p>
          </div>
          {vaultProceedsDisplay > 0 && (
            <div className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-yellow-700/60 bg-yellow-900/30 px-3 py-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-yellow-500">{t('blackMarket.proceeds')}</span>
              <span className="font-mono text-sm font-bold text-yellow-300">${formatCost(vaultProceedsDisplay)}</span>
              <span className="hidden text-[10px] text-yellow-600 sm:inline">{t('blackMarket.liquidateInVault')}</span>
            </div>
          )}
        </div>

        {/* Tabs estilo pill com scroll horizontal em mobile */}
        <div className="scrollbar-thin scrollbar-thumb-slate-700 mt-4 -mx-1 flex touch-pan-x gap-1.5 overflow-x-auto pb-1 sm:gap-2 sm:overflow-visible sm:pb-0">
          {tabConfig.map((tabItem) => {
            const active = mode === tabItem.id;
            return (
              <button
                key={tabItem.id}
                type="button"
                onClick={() => setMode(tabItem.id)}
                className={[
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-4 py-2 text-[11px] font-black uppercase tracking-wide transition-all sm:text-xs',
                  active
                    ? 'border-red-500/60 bg-red-600/20 text-red-300 shadow-inner shadow-red-900/40'
                    : 'border-slate-700/60 bg-slate-900/60 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                ].join(' ')}
              >
                {tabItem.icon}
                {t(tabItem.labelKey)}
                {tabItem.badge && tabItem.badge > 0 ? (
                  <span className={[
                    'inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 font-mono text-[10px] font-bold',
                    active ? 'bg-red-500 text-white' : 'bg-amber-600/80 text-white'
                  ].join(' ')}>{tabItem.badge}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* CONTENT — scroll interno neste painel; header fica fixo */}
      <div className="custom-scrollbar relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden bg-slate-900/80 px-4 py-4 sm:px-6 sm:py-5">

        {/* HISTORY */}
        {mode === 'history' && (
          <div className="space-y-3">
            <div className="flex gap-2 border-b border-slate-800 pb-2">
              <button
                type="button"
                onClick={() => setHistoryTab('purchases')}
                className={`px-3 py-1.5 rounded text-xs font-bold border transition-colors ${historyTab === 'purchases' ? 'bg-slate-800 border-red-600 text-red-300' : 'border-slate-700 text-slate-500 hover:text-slate-300'}`}
              >
                {t('blackMarket.myPurchases')}
              </button>
              <button
                type="button"
                onClick={() => setHistoryTab('sales')}
                className={`px-3 py-1.5 rounded text-xs font-bold border transition-colors ${historyTab === 'sales' ? 'bg-slate-800 border-red-600 text-red-300' : 'border-slate-700 text-slate-500 hover:text-slate-300'}`}
              >
                {t('blackMarket.mySales')}
              </button>
            </div>
            <p className="text-[10px] text-slate-500">
              {historyTab === 'purchases'
                ? 'Itens que compraste a outros jogadores: vendedor, quantidade e total em USDC que pagaste.'
                : 'Itens que vendeste: comprador, quantidade e líquido creditado no cofre P2P (após taxa do mercado).'}
            </p>
            {historyLoading ? (
              <div className="py-12 text-center text-slate-500 text-sm animate-pulse">{t('blackMarket.loadingHistory')}</div>
            ) : (
              (() => {
                const rows = historyTab === 'purchases' ? historyPurchases : historySales;
                if (rows.length === 0) {
                  return (
                    <div className="text-center py-10 text-slate-500 border border-dashed border-slate-800 rounded-lg text-sm">
                      Sem registos nesta secção.
                    </div>
                  );
                }
                return (
                  <div className="rounded-lg border border-slate-800 overflow-hidden">
                    <table className="w-full text-left text-[11px]">
                      <thead>
                        <tr className="bg-slate-950/80 text-slate-500 uppercase tracking-wider border-b border-slate-800">
                          <th className="p-2 font-bold">Data</th>
                          <th className="p-2 font-bold">{historyTab === 'purchases' ? 'De' : 'Para'}</th>
                          <th className="p-2 font-bold">Item</th>
                          <th className="p-2 font-bold text-right">Qtd</th>
                          <th className="p-2 font-bold text-right">{historyTab === 'purchases' ? 'Paguei' : 'Recebi'}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, idx) => {
                          const def = upgrades.find((u) => u.id === row.itemId);
                          const label = def?.name || row.itemId;
                          const when =
                            row.at > 0
                              ? new Date(row.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
                              : '—';
                          const mainAmount =
                            historyTab === 'purchases' ? row.buyerPaidUsdc : row.sellerReceivedUsdc;
                          return (
                            <tr key={`${row.at}-${row.itemId}-${idx}`} className="border-b border-slate-800/80 hover:bg-slate-800/30">
                              <td className="p-2 text-slate-400 whitespace-nowrap font-mono">{when}</td>
                              <td className="p-2 text-slate-300 max-w-[120px] truncate" title={row.counterpartName}>
                                {row.counterpartName}
                              </td>
                              <td className="p-2 text-slate-200 max-w-[140px] truncate" title={label}>
                                {label}
                              </td>
                              <td className="p-2 text-right font-mono text-amber-400/90">{row.qty}</td>
                              <td className="p-2 text-right font-mono text-green-400">${formatCost(mainAmount)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {historyTab === 'sales' && (
                      <p className="text-[9px] text-slate-600 p-2 bg-slate-950/50 border-t border-slate-800">
                        O valor “Recebi” é o líquido no cofre P2P. O comprador pagou o total bruto (inclui taxa à plataforma quando aplicável).
                      </p>
                    )}
                  </div>
                );
              })()
            )}
          </div>
        )}

        {/* BUY MODE */}
        {mode === 'buy' && (
          <div className="space-y-3">
            <div className="sticky top-0 z-20 flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/95 p-3 backdrop-blur">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[160px] flex-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    type="search"
                    value={buySearch}
                    onChange={(e) => setBuySearch(e.target.value)}
                    placeholder={t('blackMarket.searchPlaceholder')}
                    className="w-full rounded border border-slate-700 bg-slate-900 py-2 pl-8 pr-2 text-xs text-slate-200 outline-none focus:border-red-600"
                  />
                </div>
                <select
                  value={buyCategory}
                  onChange={(e) => setBuyCategory(e.target.value)}
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-slate-200 outline-none focus:border-red-600"
                  title="Categoria (catálogo)"
                >
                  <option value="">{t('blackMarket.allCategories')}</option>
                  {buyCategoryOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select
                  value={buyType}
                  onChange={(e) => setBuyType((e.target.value || '') as '' | Upgrade['type'])}
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-slate-200 outline-none focus:border-red-600"
                  title="Tipo de peça"
                >
                  {P2P_TYPE_OPTION_KEYS.map((o) => (
                    <option key={o.labelKey} value={o.value}>
                      {t(o.labelKey)}
                    </option>
                  ))}
                </select>
                <select
                  value={buyPriceSort}
                  onChange={(e) => setBuyPriceSort(e.target.value as 'asc' | 'desc')}
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-slate-200 outline-none focus:border-red-600"
                  title="Ordenar por preço unitário (USDC)"
                >
                  <option value="asc">{t('blackMarket.priceAsc')}</option>
                  <option value="desc">{t('blackMarket.priceDesc')}</option>
                </select>
              </div>
              <p className="text-[10px] text-slate-500">
                {filteredBuyListings.length} de{' '}
                {useServerBuyBook ? listingsTotal : buyListingsFromOthers.length} ofertas (filtro aplicado; as tuas
                não aparecem na compra).
              </p>
            </div>
            {marketListings.length === 0 && (!useServerBuyBook || listingsTotal === 0) && !hasActiveBuyFilters ? (
              <div className="text-center py-8 text-slate-400 border border-dashed border-slate-800 rounded-lg">
                Nenhuma oferta aberta neste instante.
              </div>
            ) : marketListings.length === 0 || filteredBuyListings.length === 0 ? (
              <div className="text-center py-8 text-amber-200/80 border border-dashed border-amber-900/40 rounded-lg text-sm">
                Nenhuma oferta coincide com os filtros. Limpa a pesquisa ou muda categoria/tipo.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {sortedBuyListings.map(listing => {
                  const item = resolveListingCatalogItem(upgrades, listing.itemId);
                  if (item.sellInBlackMarket === false) return null;
                  if (isOwnListing(listing, currentUserId, currentUserName, currentUserEmail)) {
                    return null;
                  }

                  const lineTotal = p2pLineTotal(listing);
                  const unitPrice = Number(listing.price);
                  const canAffordFull = walletUsdcDisplay >= lineTotal;
                  const canAffordAny =
                    Number.isFinite(unitPrice) && unitPrice > 0 && walletUsdcDisplay >= unitPrice;
                  const isReservedForOther =
                    listing.reservedBy &&
                    listing.reservedBy !== (currentUserName?.trim() || '') &&
                    listing.reservedBy !== (currentUserEmail?.trim() || '');
                  const imgSrc = listingImageSrc(item);
                  return (
                    <div key={listing.id} className="bg-slate-900/70 border border-slate-800 hover:border-red-600/40 hover:shadow-lg hover:shadow-red-900/10 rounded-xl p-4 flex items-center justify-between gap-3 group transition-all">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-14 h-14 shrink-0 bg-slate-950 rounded-lg border border-slate-700 flex items-center justify-center text-2xl text-slate-400 overflow-hidden">
                          {imgSrc ? <img src={imgSrc} alt="" onError={(e) => handleImageError(e)} className="w-full h-full object-cover" /> : item.icon}
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-bold text-slate-100 text-sm group-hover:text-red-300 transition-colors flex items-center gap-2 flex-wrap">
                            <span className="truncate max-w-[10rem] sm:max-w-[14rem]">{item.name}</span>
                            {(listing.qty && listing.qty > 1) && (
                              <span className="text-[10px] bg-red-900/50 text-red-300 px-2 py-0.5 rounded-full border border-red-800 font-mono">
                                x{listing.qty}
                              </span>
                            )}
                          </h3>
                          <div
                            className="mt-1 text-[11px] text-slate-500 truncate"
                            title={formatSellerLabel(listing)}
                          >
                            Vendedor: <span className="text-slate-400">{formatSellerLabel(listing)}</span>
                          </div>
                          <UpgradeMarketSpecLine item={item} catalog={upgrades} className="mt-1" />
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div
                          className={`font-mono font-bold text-sm ${
                            canAffordFull ? 'text-green-400' : canAffordAny ? 'text-amber-400' : 'text-red-500'
                          }`}
                          title={canAffordFull ? t('blackMarket.canBuyFull') : canAffordAny ? t('blackMarket.canBuyPartial') : t('blackMarket.insufficientUsdc')}
                        >
                          ${formatCost(lineTotal)}
                        </div>
                        {(listing.qty && listing.qty > 1) && (
                          <div className="text-[10px] font-mono text-slate-500">${formatCost(listing.price)}/un.</div>
                        )}
                        <button
                          onClick={async () => {
                            const r = await postBlackMarketReserve(listing.id);
                            if (r && r.ok) {
                              setConfirmListing(listing);
                              await refreshBuyListings();
                            }
                          }}
                          disabled={!canAffordAny || isReservedForOther || !isEnabled}
                          className={[
                            'mt-2 px-4 py-1.5 rounded-lg text-xs font-bold inline-flex items-center justify-center gap-1 ml-auto transition-colors min-w-[5.5rem]',
                            (!canAffordAny || isReservedForOther || !isEnabled)
                              ? 'bg-slate-800 text-slate-600 cursor-not-allowed border border-slate-800'
                              : 'bg-red-900/60 text-red-200 border border-red-700/70 hover:bg-red-700'
                          ].join(' ')}
                        >
                          {!isEnabled ? 'Offline' : 'Comprar'}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

      {/* VAULT MODE */}
      {mode === 'vault' && (
        <div className="space-y-4">
          {/* CLAIM FUNDS UI */}
          {vaultProceedsDisplay > 0 && (
            <div className="bg-yellow-900/20 border border-yellow-800/50 p-4 rounded-lg flex items-center justify-between">
              <div>
                <div className="text-yellow-500 font-bold text-sm uppercase mb-1">{t('blackMarket.saleProceeds')}</div>
                <div className="text-2xl font-mono text-yellow-400 font-bold">${formatCost(vaultProceedsDisplay)}</div>
              </div>
              <button
                onClick={async () => {
                  const res = await postBlackMarketClaim();
                  if (res && res.ok) {
                    bumpRefresh();
                  }
                }}
                className="bg-yellow-600 hover:bg-yellow-500 text-black font-bold px-6 py-2 rounded shadow-lg transition-colors border border-yellow-400"
              >
                Liquidar proventos
              </button>
            </div>
          )}

          {/* Cabeçalho do Cofre + botão Resgatar tudo */}
          <div className="flex flex-col gap-3 mt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-300">
                <Lock size={14} className="text-amber-500" /> {t('blackMarket.custodyItems')} ({custodyListings.length})
              </h3>
              <p className="mt-1 text-[11px] text-slate-500">
                Itens comprados no P2P ficam em custódia até resgatares para o Estoque.
              </p>
            </div>
            <button
              type="button"
              disabled={custodyListings.length === 0 || isClaimingAll}
              onClick={async () => {
                if (isClaimingAll || custodyListings.length === 0) return;
                setIsClaimingAll(true);
                try {
                  const r = await postBlackMarketClaimAll();
                  if (r && r.ok) {
                    const n = typeof r.claimed === 'number' ? r.claimed : custodyListings.length;
                    bumpRefresh();
                    try {
                      const custody = await getBlackMarketEscrow();
                      setCustodyListings(custody as CustodyListingRow[]);
                    } catch { /* ignore */ }
                    setNotice({
                      variant: 'success',
                      title: t('blackMarket.claimDone'),
                      message: r.message || `${n} ${n === 1 ? 'item foi resgatado' : 'itens foram resgatados'} para o Estoque.`
                    });
                  } else {
                    setNotice({
                      variant: 'error',
                      title: t('blackMarket.claimFailed'),
                      message: r?.error || 'Tente novamente em instantes.'
                    });
                  }
                } finally {
                  setIsClaimingAll(false);
                }
              }}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-600/60 bg-gradient-to-br from-amber-600 to-orange-600 px-4 py-2 text-xs font-black uppercase tracking-wide text-white shadow-md transition hover:from-amber-500 hover:to-orange-500 disabled:cursor-not-allowed disabled:opacity-40 sm:px-5 sm:text-sm"
              title={custodyListings.length === 0 ? t('blackMarket.noCustody') : t('blackMarket.reclaimAll')}
            >
              {isClaimingAll ? (
                <>{t('blackMarket.reclaiming')}</>
              ) : (
                <>{t('blackMarket.reclaimAll')} {custodyListings.length > 0 && <span className="opacity-80">({custodyListings.length})</span>}</>
              )}
            </button>
          </div>

          {custodyListings.length === 0 ? (
            <div className="text-center py-14 text-slate-500 border border-dashed border-slate-800/80 rounded-xl bg-slate-950/40">
              <Lock size={48} className="mx-auto mb-4 opacity-20" />
              <p className="text-sm">{t('blackMarket.noCustody')}</p>
              <p className="mt-1 text-[11px] text-slate-600">{t('blackMarket.buyThenVault')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
              {custodyListings.map(l => {
                const item = upgrades.find(u => u.id === l.itemId);
                if (!item) return null;
                const isThisClaiming = claimingId === l.id;
                return (
                  <div key={l.id} className="bg-slate-950/80 border border-slate-800/80 hover:border-amber-700/50 rounded-xl p-4 flex items-center gap-4 transition-colors shadow-sm">
                    <div className="w-14 h-14 bg-slate-900 rounded-lg border border-slate-700 flex items-center justify-center text-slate-500 overflow-hidden shrink-0">
                      {listingImageSrc(item) ? (
                        <img src={listingImageSrc(item)} alt="" onError={(e) => handleImageError(e)} className="w-full h-full object-cover" />
                      ) : (
                        item.icon
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-slate-100 text-sm truncate">
                        {item.name}
                        {(l.qty && l.qty > 1) && <span className="text-xs text-slate-500 ml-2">x{l.qty}</span>}
                      </div>
                      <UpgradeMarketSpecLine item={item} catalog={upgrades} className="mt-0.5" />
                      <div className="text-xs text-slate-500 mt-0.5">
                        {typeof l.buyerPaidUsdc === 'number' && Number.isFinite(l.buyerPaidUsdc) ? (
                          <>
                            <span className="text-slate-400">USDC debitado: </span>
                            <span className="font-mono text-amber-400">${formatCost(l.buyerPaidUsdc)}</span>
                            {Math.abs(l.buyerPaidUsdc - p2pLineTotal(l)) > 0.0001 && (
                              <span className="mt-0.5 block text-[10px] leading-snug text-rose-400/90">
                                Preço×qtd no anúncio seria ${formatCost(p2pLineTotal(l))}. Se não bate com o teu extrato, pode ser linha antiga — fala com o suporte.
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            <span className="text-slate-400">Total (preço×qtd): </span>
                            <span className="font-mono text-slate-400">${formatCost(p2pLineTotal(l))}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      disabled={isThisClaiming || isClaimingAll}
                      onClick={async () => {
                        if (claimingId || isClaimingAll) return;
                        setClaimingId(l.id);
                        try {
                          const r = await postBlackMarketClaimItem(l.id);
                          if (r && r.ok) {
                            bumpRefresh();
                            const custody = await getBlackMarketEscrow();
                            setCustodyListings(custody as CustodyListingRow[]);
                            setNotice({
                              variant: 'success',
                              title: t('blackMarket.itemClaimed'),
                              message: t('blackMarket.transferredToStock')
                            });
                          } else {
                            setNotice({
                              variant: 'error',
                              title: t('blackMarket.claimFailed'),
                              message: r?.error || 'Tente novamente em instantes.'
                            });
                          }
                        } finally {
                          setClaimingId(null);
                        }
                      }}
                      className="bg-amber-900/50 hover:bg-amber-800 border border-amber-700 text-amber-200 text-xs px-3 py-2 rounded-lg font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                    >
                      {isThisClaiming ? t('blackMarket.reclaiming') : 'Resgatar'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* SELL MODE — form + ofertas lado a lado no desktop; lista sempre com altura útil */}
      {mode === 'sell' && (
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-5">

          {/* Sell Form */}
          <div className="shrink-0 rounded-xl border border-slate-800 bg-slate-950 p-4">
            <h3 className="mb-4 flex items-center gap-2 border-b border-slate-800 pb-2 text-sm font-bold text-slate-300">
              <PlusCircle size={16} className="text-red-500" /> {t('blackMarket.newOffer')}
            </h3>

            {sellableItems.length > 0 && (
              <div className="mb-4 flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{t('blackMarket.filterStock')}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[140px] flex-1">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                    <input
                      type="search"
                      value={sellFilterSearch}
                      onChange={(e) => setSellFilterSearch(e.target.value)}
                      placeholder={t('blackMarket.nameOrId')}
                      className="w-full rounded border border-slate-700 bg-slate-900 py-2 pl-8 pr-2 text-xs text-slate-200 outline-none focus:border-red-600"
                    />
                  </div>
                  <select
                    value={sellFilterCategory}
                    onChange={(e) => setSellFilterCategory(e.target.value)}
                    className="rounded border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-slate-200 outline-none focus:border-red-600"
                  >
                    <option value="">{t('blackMarket.allCategories')}</option>
                    {sellCategoryOptions.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <select
                    value={sellFilterType}
                    onChange={(e) => setSellFilterType((e.target.value || '') as '' | Upgrade['type'])}
                    className="rounded border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-slate-200 outline-none focus:border-red-600"
                  >
                    {P2P_TYPE_OPTION_KEYS.map((o) => (
                      <option key={`s-${o.labelKey}`} value={o.value}>
                        {t(o.labelKey)}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-[10px] text-slate-500">
                  {sellableFiltered.length} de {sellableItems.length} itens no estoque negociável.
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-500">{t('blackMarket.stockPiece')}</label>
                <div className="relative">
                  <select
                    value={sellItemId}
                    onChange={(e) => setSellItemId(e.target.value)}
                    className="w-full appearance-none rounded border border-slate-700 bg-slate-900 p-2 pl-9 text-sm text-slate-200 outline-none focus:border-red-500"
                  >
                    {sellableItems.length === 0 && <option value="">{t('blackMarket.noTradable')}</option>}
                    {sellableItems.length > 0 && sellableFiltered.length === 0 && (
                      <option value="">{t('blackMarket.nothingMatchesFilter')}</option>
                    )}
                    {sellableFiltered.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} (x{stockMap[u.id] || 0})
                      </option>
                    ))}
                  </select>
                  <Package className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase text-slate-500">{t('blackMarket.unitPriceUsdc')}</label>
                  <div className="relative">
                    <input
                      type="number"
                      value={sellPrice}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const v = parseUsdcInput(raw);
                        const ref = getBandReferencePrice(sellItemId);
                        const min = ref * minFactor;
                        const max = ref * maxFactor;
                        if (!Number.isFinite(ref) || ref <= 0 || isNaN(v)) {
                          setSellPrice(raw);
                        } else {
                          const clamped = Math.max(min, Math.min(max, v));
                          setSellPrice(String(clamped));
                        }
                      }}
                      placeholder={(selectedSellItem ? getMarketPrice(selectedSellItem.id) : 0).toString() || "0.00"}
                      className="w-full rounded border border-slate-700 bg-slate-900 p-2 pl-7 font-mono text-sm text-slate-200 outline-none focus:border-red-500"
                    />
                    <DollarSign className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" size={14} />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase text-slate-500">{t('blackMarket.quantity')}</label>
                  <input
                    type="number"
                    min="1"
                    max={stockMap[sellItemId] || 1}
                    value={sellQty}
                    onChange={(e) => setSellQty(e.target.value)}
                    className="w-full rounded border border-slate-700 bg-slate-900 p-2 font-mono text-sm text-slate-200 outline-none focus:border-red-500"
                  />
                </div>
              </div>
            </div>

            {selectedSellItem && (
              <div className="mt-3 flex flex-col gap-2 rounded bg-slate-900/50 p-2 text-xs text-slate-500">
                <UpgradeMarketSpecLine item={selectedSellItem} catalog={upgrades} compact={false} />
                <div className="flex items-center justify-between">
                  <span>Genesis Supply (loja): <span className="font-mono text-green-500">${formatCost(marketPrice)}</span></span>
                  <span>
                    Seu preço:
                    <span className={`font-mono font-bold ${(() => { const p = parseUsdcInput(sellPrice); return isNaN(p) ? '' : (p >= marketPrice ? 'text-red-500' : 'text-green-500'); })()}`}>
                      ${sellPrice ? formatCost(parseUsdcInput(sellPrice)) : '0.00'}
                    </span>
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-slate-800/80 pt-1">
                  <span>Base do limite (±{band}%): <span className="font-mono text-amber-400">${formatCost(refPrice)}</span></span>
                  <span className="font-mono text-[10px] text-slate-600">${formatCost(minAllowed)} – ${formatCost(maxAllowed)}</span>
                </div>
              </div>
            )}

            {selectedSellItem && (
              <div className="mt-2 text-[10px] text-slate-400">
                {`O limite é ±${band}% sobre o preço da Lojinha Miner (Genesis Supply) desta peça. Ex.: com banda 20%, um item de US$ 1 na loja pode ser anunciado entre US$ 0,80 e US$ 1,20 por unidade.`}
              </div>
            )}

            <button
              onClick={handleSellSubmit}
              disabled={publishDisabled || !isEnabled}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded bg-red-600 py-2.5 text-sm font-bold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {!isEnabled ? 'Desk offline' : 'Publicar oferta'} <ArrowRight size={16} />
            </button>
          </div>

          {/* Active Player Listings — altura mínima garantida */}
          <div className="flex min-h-[18rem] flex-col rounded-lg border border-slate-800/50 bg-slate-950/30 p-3 sm:min-h-[22rem] lg:min-h-[28rem]">
            <h3 className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-300">
              <Tag size={14} className="text-green-500" /> {t('blackMarket.yourActiveOffers')}
              {myActiveListings.length > 0 ? (
                <span className="rounded-full bg-green-900/40 px-2 py-0.5 font-mono text-[10px] text-green-400">
                  {myActiveListings.length}
                </span>
              ) : null}
            </h3>
            <p className="mb-3 flex items-center gap-1 text-[10px] text-slate-500">
              <ShieldCheck size={10} /> {t('blackMarket.lockedUntilSold')}
            </p>

            {(() => {
              const sellRows = myActiveListings;
              return sellRows.length === 0 ? (
              <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-slate-800 py-10 text-center text-slate-600">
                Nenhuma linha ativa no book.
              </div>
            ) : (
              <div className="custom-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                {sellRows.map(listing => {
                  const item = upgrades.find(u => u.id === listing.itemId);
                  if (!item) return null;

                  return (
                    <div key={listing.id} className="flex items-center justify-between gap-2 rounded border border-slate-800 bg-slate-950 p-2.5">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-slate-700 bg-slate-900 text-xl text-slate-400">
                          {listingImageSrc(item) ? (
                        <img src={listingImageSrc(item)} alt="" onError={(e) => handleImageError(e)} className="h-full w-full object-cover" />
                      ) : (
                        item.icon
                      )}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-xs font-bold text-slate-300">{item.name}</div>
                          <UpgradeMarketSpecLine item={item} catalog={upgrades} className="mt-0.5" />
                          <div className="mt-0.5 font-mono text-xs text-green-500">
                        ${formatCost(p2pLineTotal(listing))}
                        {(listing.qty && listing.qty > 1) && (
                          <span className="block text-[9px] text-slate-500">${formatCost(listing.price)}/un. × {listing.qty}</span>
                        )}
                      </div>
                        </div>
                      </div>
                      <button
                        onClick={() => void handleCancelListing(listing.id)}
                        className="shrink-0 p-2 text-slate-500 transition-colors hover:text-red-500"
                        title="Cancelar Oferta"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  )
                })}
              </div>
            );
            })()}
          </div>
        </div>
      )}
      </div>

      <UiNoticeModal notice={notice} onClose={() => setNotice(null)} overlayZClassName="z-[140]" />

      {
        confirmListing && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 w-full max-w-md shadow-2xl">
              <h3 className="text-red-500 font-bold text-sm mb-3">{t('blackMarket.closeDeal')}</h3>
              {(() => {
                const item = upgrades.find(u => u.id === confirmListing.itemId);
                const maxQ = Math.max(1, parseInt(String(confirmListing.qty ?? 1), 10) || 1);
                const parsed = parseInt(String(buyQtyDraft ?? '').trim(), 10);
                const buyQ = Number.isFinite(parsed) && parsed >= 1 ? Math.min(maxQ, parsed) : 1;
                const unit = Number(confirmListing.price);
                const confirmTotal = (Number.isFinite(unit) ? unit : 0) * buyQ;
                const canAfford = walletUsdcDisplay >= confirmTotal;
                return (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 bg-slate-900 rounded border border-slate-700 flex items-center justify-center text-2xl text-slate-400 overflow-hidden">
                        {listingImageSrc(item!) ? (
                          <img src={listingImageSrc(item!)!} alt="" onError={(e) => handleImageError(e)} className="w-full h-full object-cover" />
                        ) : (
                          item?.icon
                        )}
                      </div>
                      <div>
                        <div className="text-slate-200 font-bold text-sm">
                          {item?.name || confirmListing.itemId}
                          {maxQ > 1 && (
                            <span className="ml-1 text-xs font-normal text-slate-500">(até {maxQ} un.)</span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500">
                          Vendedor: {formatSellerLabel(confirmListing)}
                        </div>
                        {item && <UpgradeMarketSpecLine item={item} catalog={upgrades} className="mt-1" compact={false} />}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                        Quantidade a comprar (máx. {maxQ})
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={maxQ}
                        value={buyQtyDraft}
                        onChange={(e) => setBuyQtyDraft(e.target.value)}
                        className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-2 font-mono text-sm text-slate-200 outline-none focus:border-red-500"
                      />
                      <p className="text-[10px] text-slate-500">
                        Entre 1 e {maxQ} · ${formatCost(confirmListing.price)} por unidade · total do lote até ${formatCost(p2pLineTotal(confirmListing))}
                      </p>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-400">{t('blackMarket.totalToPay')}</span>
                      <span className={`font-mono ${canAfford ? 'text-green-400' : 'text-red-500'}`}>${formatCost(confirmTotal)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-400">Reserva USDC</span>
                      <span className="font-mono text-slate-300">${formatCost(walletUsdcDisplay)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-400">Saldo após compra</span>
                      <span className={`font-mono ${canAfford ? 'text-slate-300' : 'text-red-500'}`}>
                        ${formatCost(walletUsdcDisplay - confirmTotal)}
                      </span>
                    </div>
                    <div className="flex gap-2 pt-2">
                      <button onClick={async () => {
                        if (!confirmListing) return;
                        await postBlackMarketCancelReserve(confirmListing.id);
                        setConfirmListing(null);
                        await refreshBuyListings();
                      }} className="flex-1 px-3 py-2 text-xs font-bold uppercase rounded border bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-300">
                        {t('blackMarket.cancel')}
                      </button>
                      <button onClick={async () => {
                        if (!confirmListing || isBuying) return;
                        const mq = Math.max(1, parseInt(String(confirmListing.qty ?? 1), 10) || 1);
                        const trimmed = String(buyQtyDraft ?? '').trim();
                        const pq = parseInt(trimmed, 10);
                        const qBuy = Number.isFinite(pq) && pq >= 1 ? Math.min(mq, pq) : 1;
                        if (!buyIdempotencyKeyRef.current) {
                          buyIdempotencyKeyRef.current =
                            typeof crypto !== 'undefined' && 'randomUUID' in crypto
                              ? crypto.randomUUID()
                              : `p2p_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
                        }
                        setIsBuying(true);
                        let res: Awaited<ReturnType<typeof postBlackMarketBuy>>;
                        try {
                          res = await postBlackMarketBuy(confirmListing.id, qBuy, {
                            idempotencyKey: buyIdempotencyKeyRef.current
                          });
                        } finally {
                          setIsBuying(false);
                        }
                        if (res && res.ok) {
                          buyIdempotencyKeyRef.current = null;
                          const got = typeof res.purchasedQty === 'number' ? res.purchasedQty : qBuy;
                          const paid = typeof res.totalUsdc === 'number' ? res.totalUsdc : null;
                          if (got !== qBuy || (paid != null && Math.abs(paid - confirmTotal) > 1e-6)) {
                            console.warn('[BlackMarket] Resposta do servidor difere do pedido:', { pedido: qBuy, confirmTotal, res });
                          }
                          setHistoryReloadNonce((n) => n + 1);
                          setConfirmListing(null);
                          /**
                           * Não trocamos de aba após a compra (UX 2024-11): o jogador costuma comprar
                           * vários itens em sequência e o redirecionamento automático para «Cofre»
                           * interrompia esse fluxo. Atualizamos o contador do Cofre em background
                           * para o badge da aba refletir o novo estado e abrimos um toast com a
                           * mensagem clara de onde o item ficou.
                           */
                          try {
                            const custody = await getBlackMarketEscrow();
                            setCustodyListings(custody as CustodyListingRow[]);
                          } catch {
                            /* ignore */
                          }
                          bumpRefresh();
                          const st = await getBlackMarketState();
                          if (st.ok) syncUsdc(st.usdc);
                          await refreshBuyListings();
                          const totalUsdc = typeof res.totalUsdc === 'number' ? res.totalUsdc : confirmTotal;
                          setNotice({
                            variant: 'success',
                            title: t('blackMarket.purchaseDone'),
                            message: `Pagaste $${formatCost(totalUsdc)} por ${got} un. O item foi enviado para o Cofre — podes resgatá-lo quando quiser.`
                          });
                        } else {
                          const insuff =
                            res.error === 'Insufficient USDC' ||
                            /insufficient|insuficiente/i.test(String(res.error || res.message || ''));
                          if (insuff) {
                            const miss = typeof res.missing === 'number' ? res.missing : 0;
                            setNotice({
                              variant: 'error',
                              title: t('blackMarket.insufficientUsdc'),
                              message: t('blackMarket.missingUsdc', { amount: miss.toFixed(2) })
                            });
                          } else {
                            setNotice({
                              variant: 'error',
                              title: t('blackMarket.purchaseFailed'),
                              message: res.error || res.message || 'Não foi possível concluir a compra.'
                            });
                          }
                        }
                      }} disabled={!canAfford || confirmTotal <= 0 || isBuying} className="flex-1 px-3 py-2 text-xs font-bold uppercase rounded border bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white border-red-700">
                        {isBuying ? t('blackMarket.processing') : t('blackMarket.confirm')}
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
    </div>
    </div>
  );
};
