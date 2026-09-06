/**
 * Caixa da Sorte — player view (self-fetch, no gameState monolith).
 * Ported from `legacy/frontend/components/LuckyBoxStore.tsx`.
 */
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  Gift,
  Package,
  Sparkles,
  DollarSign,
  Box,
  CheckCircle2,
  Ticket,
  Store,
  Trash2,
  Loader2
} from 'lucide-react';
import {
  getLuckyBoxesState,
  postLuckyBoxPurchase,
  postLuckyBoxOpen,
  postLuckyBoxDiscard,
  redeemLuckyBoxPromoCode,
  newLuckyBoxIdempotencyKey,
  getLuckyBoxesInventory,
  type LuckyBoxesStateV1Ok,
  type LuckyBoxShopEntryV1,
  type LuckyBoxInventoryEntryV1,
  type LuckyBoxOpeningReward
} from '../../../shared/api/lucky-boxes';
import { getShopState } from '../../../shared/api/shop';
import { normalizePublicAssetUrl } from '../../../shared/utils/public-url';
import { UiNoticeModal, type UiNotice } from '../../../shared/ui/UiNoticeModal';
import { useT } from '../../../shared/i18n';

function displayLootBoxName(raw: string | undefined): string {
  const n = raw || 'Caixa';
  return n.replace(/\bCorigo\b/gi, 'Código');
}

/** Só paths/URLs de ficheiro — emoji e classes de icon set não contam. */
function isImageAssetSrc(icon: string): boolean {
  const s = icon.trim();
  if (!s) return false;
  if (s.startsWith('bi-') || s.startsWith('bi ')) return false;
  return (
    s.includes('/') ||
    s.includes('http') ||
    /\.(png|jpe?g|gif|webp|ico|svg)(\?.*)?$/i.test(s)
  );
}

function serverShopAvailability(entry: LuckyBoxShopEntryV1): { canBuy: boolean; label: string | null } {
  if (entry.stockRemaining === 0) return { canBuy: false, label: 'ESGOTADO' };
  if (!(entry.priceUsdc > 1e-6)) return { canBuy: true, label: 'GRATIS' };
  return { canBuy: true, label: null };
}

function countOpenableInventory(inventory: LuckyBoxInventoryEntryV1[]): number {
  let sum = 0;
  for (const row of inventory) {
    if (row.openableHere && row.qty > 0) sum += row.qty;
  }
  return sum;
}

function formatCost(val: number): string {
  if (!(val > 1e-6)) return '0';
  if (val < 0.01) return val.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Thumb da caixa: só arte própria da caixa; nunca herda imagem dos prémios. */
function boxOwnImage(icon: string | undefined): string {
  if (icon && isImageAssetSrc(icon)) return icon;
  return '';
}

export type LuckyBoxesPageProps = {
  usdcBalance?: number;
  onUsdcChange?: (n: number) => void;
  onOpenRoleta?: (code: string) => void;
  userEmail?: string | null;
};

type LuckyTab = 'inventario' | 'loja';

export function LuckyBoxesPage({ usdcBalance, onUsdcChange, onOpenRoleta, userEmail = null }: LuckyBoxesPageProps) {
  const t = useT();
  const promoInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<LuckyBoxesStateV1Ok | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openingBox, setOpeningBox] = useState<string | null>(null);
  const openIdempotencyKeyRef = useRef<string | null>(null);
  const openIdempotencyBoxRef = useRef<string | null>(null);
  const buyIdempotencyKeyRef = useRef<string | null>(null);
  const buyIdempotencyBoxRef = useRef<string | null>(null);
  const promoIdempotencyKeyRef = useRef<string | null>(null);
  const promoIdempotencyCodeRef = useRef<string | null>(null);
  const [discardingBox, setDiscardingBox] = useState<string | null>(null);
  const [rewards, setRewards] = useState<LuckyBoxOpeningReward[] | null>(null);
  const [promoCode, setPromoCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [buyingBoxId, setBuyingBoxId] = useState<string | null>(null);
  const [notice, setNotice] = useState<UiNotice | null>(null);
  /** id → { image, name } da loja (abinha do produto). */
  const [catalogById, setCatalogById] = useState<Record<string, { image: string; name: string }>>({});
  /** nome exacto do upgrade → image (fallback quando o slot só traz label). */
  const [catalogByName, setCatalogByName] = useState<Record<string, string>>({});

  const openableInventoryTotal = useMemo(
    () => countOpenableInventory(state?.inventory ?? []),
    [state?.inventory]
  );

  const [activeTab, setActiveTab] = useState<LuckyTab>('loja');
  const lastOwnedRef = useRef(0);
  const tabInitializedRef = useRef(false);

  useEffect(() => {
    if (!tabInitializedRef.current && state) {
      tabInitializedRef.current = true;
      setActiveTab(openableInventoryTotal > 0 ? 'inventario' : 'loja');
    }
  }, [state, openableInventoryTotal]);

  useEffect(() => {
    if (openableInventoryTotal > lastOwnedRef.current) setActiveTab('inventario');
    lastOwnedRef.current = openableInventoryTotal;
  }, [openableInventoryTotal]);

  const applyUsdc = useCallback(
    (n: number | undefined) => {
      if (typeof n === 'number' && Number.isFinite(n)) onUsdcChange?.(n);
    },
    [onUsdcChange]
  );

  const refreshState = useCallback(
    async (opts?: { quiet?: boolean }): Promise<LuckyBoxesStateV1Ok | null> => {
      if (!userEmail?.trim()) {
        if (!opts?.quiet) {
          setLoading(false);
          setState(null);
          setLoadError(t('luckyBoxes.loginRequired'));
        }
        return null;
      }
      if (!opts?.quiet) {
        setLoading(true);
        setLoadError(null);
      }

      const attempts = 3;
      let lastError: string | null = null;
      for (let i = 0; i < attempts; i++) {
        const out = await getLuckyBoxesState();
        if (out.ok === true) {
          setState(out);
          applyUsdc(out.usdc);
          setLoadError(null);
          setLoading(false);
          return out;
        }
        lastError = out.error || t('luckyBoxes.loadFailed');
        // Fallback: pelo menos o inventário de caixas
        const inv = await getLuckyBoxesInventory();
        if (inv.ok) {
          setState((prev) => {
            const base: LuckyBoxesStateV1Ok = prev ?? {
              ok: true,
              version: 1,
              usdc: usdcBalance ?? 0,
              banner: null,
              promoHelp: '',
              roulettePromoNote: '',
              shop: [],
              shopEmptyMessage: '',
              inventory: []
            };
            return { ...base, inventory: inv.inventory };
          });
          setLoadError(null);
          setLoading(false);
          return null;
        }
        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        }
      }

      setLoading(false);
      // Não limpar state antigo — evita inventário vazio após compra OK
      if (!opts?.quiet) setLoadError(lastError);
      return null;
    },
    [userEmail, applyUsdc, usdcBalance, t]
  );

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const shop = await getShopState();
      if (cancelled || !shop || !('products' in shop) || !Array.isArray(shop.products)) return;
      const byId: Record<string, { image: string; name: string }> = {};
      const byName: Record<string, string> = {};
      for (const p of shop.products) {
        const img =
          (p.image && isImageAssetSrc(p.image) ? p.image : '') ||
          (p.icon && isImageAssetSrc(p.icon) ? p.icon : '');
        const name = String(p.name || '').trim();
        if (img || name) {
          byId[p.id] = { image: img, name: name || p.id };
        }
        if (name && img) byName[name] = img;
      }
      setCatalogById(byId);
      setCatalogByName(byName);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Arte do prémio: path do servidor, senão abinha da loja (por id ou nome). */
  const resolveSlotImage = useCallback(
    (s: { icon?: string; itemId?: string; label?: string }) => {
      if (s.icon && isImageAssetSrc(s.icon)) return s.icon;
      if (s.itemId) {
        const fromId = catalogById[s.itemId]?.image;
        if (fromId && isImageAssetSrc(fromId)) return fromId;
      }
      const label = String(s.label || '').trim();
      if (label && catalogByName[label] && isImageAssetSrc(catalogByName[label]!)) {
        return catalogByName[label]!;
      }
      return '';
    },
    [catalogById, catalogByName]
  );

  const mergeInventoryFromPurchase = useCallback(
    (inventory: LuckyBoxInventoryEntryV1[] | undefined, boxId: string, qtyPurchased: number | undefined) => {
      if (inventory && inventory.length > 0) {
        setState((prev) => {
          if (!prev) {
            return {
              ok: true,
              version: 1,
              usdc: usdcBalance ?? 0,
              banner: null,
              promoHelp: '',
              roulettePromoNote: '',
              shop: [],
              shopEmptyMessage: '',
              inventory
            };
          }
          return { ...prev, inventory };
        });
        return true;
      }
      // Optimistic bump se a API não mandou inventory
      const add = Math.max(1, Math.floor(Number(qtyPurchased) || 1));
      setState((prev) => {
        if (!prev) return prev;
        const list = [...prev.inventory];
        const idx = list.findIndex((r) => r.boxId === boxId);
        if (idx >= 0) {
          const cur = list[idx]!;
          list[idx] = { ...cur, qty: cur.qty + add };
        } else {
          list.push({
            boxId,
            qty: add,
            name: 'Caixa',
            description: '',
            icon: '',
            trigger: 'shop',
            openableHere: true,
            rewardSummary: { slotCount: 0, slots: [] }
          });
        }
        return { ...prev, inventory: list };
      });
      return false;
    },
    [usdcBalance]
  );

  const reserveUsdc = state?.usdc ?? usdcBalance ?? 0;

  const ownedBoxes = useMemo(
    () => (state?.inventory ?? []).filter((row) => row.openableHere && row.qty > 0),
    [state?.inventory]
  );

  /** Imagem real do catálogo; sem path → ícone de caixa (não emoji / não Bootstrap). */
  const renderCatalogImage = (src: string | undefined | null, imgClass = 'h-10 w-10') => {
    const raw = String(src || '').trim();
    if (isImageAssetSrc(raw)) {
      const url = normalizePublicAssetUrl(raw) || raw;
      return (
        <span className="inline-flex h-full w-full items-center justify-center">
          <img
            src={url}
            alt=""
            aria-hidden
            onError={(e) => {
              const img = e.currentTarget;
              img.style.display = 'none';
              const sib = img.nextElementSibling;
              if (sib instanceof HTMLElement) sib.classList.remove('hidden');
            }}
            className={`object-contain ${imgClass}`}
          />
          <Package className={`hidden text-slate-500 ${imgClass}`} aria-hidden />
        </span>
      );
    }
    return <Package className={`text-slate-500 ${imgClass}`} aria-hidden />;
  };

  /** Thumb da carta da caixa: arte própria se existir, senão ícone de caixa. */
  const renderBoxThumb = (icon: string | undefined, imgClass = 'h-10 w-10') => {
    return renderCatalogImage(boxOwnImage(icon), imgClass);
  };

  const rewardVisual = (reward: LuckyBoxOpeningReward) => {
    const type = reward.type || 'item';
    if (type === 'currency') {
      return {
        name: reward.id === 'usdc' ? 'USDC' : reward.id.toUpperCase(),
        category: 'Saldo',
        image: '',
        showQty: true
      };
    }
    if (type === 'coin') {
      return { name: reward.id.toUpperCase() || 'Moeda', category: 'Moeda', image: '', showQty: true };
    }
    if (type === 'box') {
      const cat = catalogById[reward.id];
      return {
        name: displayLootBoxName(cat?.name || reward.id) || 'Caixa',
        category: 'Caixa',
        image: cat?.image || '',
        showQty: true
      };
    }
    if (type === 'pass') {
      return { name: 'Season Pass', category: 'Passe', image: '', showQty: false };
    }
    if (type === 'access_level') {
      return { name: 'Nível de acesso', category: 'Acesso', image: '', showQty: false };
    }
    const cat = catalogById[reward.id];
    return {
      name: cat?.name || reward.id || 'Item',
      category: 'Item',
      image: cat?.image || catalogByName[String(cat?.name || '').trim()] || '',
      showQty: true
    };
  };

  const handleBuy = async (boxId: string) => {
    if (buyingBoxId) return;
    if (!buyIdempotencyKeyRef.current || buyIdempotencyBoxRef.current !== boxId) {
      buyIdempotencyKeyRef.current = newLuckyBoxIdempotencyKey('lb_p');
      buyIdempotencyBoxRef.current = boxId;
    }
    const ik = buyIdempotencyKeyRef.current;
    setBuyingBoxId(boxId);
    try {
      const result = await postLuckyBoxPurchase({
        boxId,
        email: userEmail ?? undefined,
        idempotencyKey: ik
      });
      if (!result.ok) {
        setNotice({
          variant: 'error',
          title: t('luckyBoxes.title'),
          message: result.error || t('luckyBoxes.buyFailed')
        });
        return;
      }
      buyIdempotencyKeyRef.current = null;
      buyIdempotencyBoxRef.current = null;
      applyUsdc(result.newUsdc);
      mergeInventoryFromPurchase(result.inventory, boxId, result.qtyPurchased);
      setActiveTab('inventario');

      const refreshed = await refreshState({ quiet: true });
      let list = refreshed?.inventory ?? result.inventory ?? [];
      let hasBox = list.some((r) => r.boxId === boxId && r.qty > 0);

      if (!hasBox) {
        const inv = await getLuckyBoxesInventory();
        if (inv.ok) {
          list = inv.inventory;
          setState((prev) => (prev ? { ...prev, inventory: inv.inventory } : prev));
          hasBox = inv.inventory.some((r) => r.boxId === boxId && r.qty > 0);
        }
        setNotice({
          variant: hasBox ? 'success' : 'error',
          title: t('luckyBoxes.title'),
          message: hasBox
            ? t('luckyBoxes.purchasedOpenInventory')
            : 'Compra registada, mas o inventário demorou a atualizar. Recarrega a página (F5) e verifica Meu inventário — não compres de novo sem confirmar.'
        });
        return;
      }

      setNotice({ variant: 'success', message: t('luckyBoxes.purchasedOpenInventory') });
    } finally {
      setBuyingBoxId(null);
    }
  };

  const handleOpen = (boxId: string) => {
    if (openingBox) return;
    setOpeningBox(boxId);
    if (!openIdempotencyKeyRef.current || openIdempotencyBoxRef.current !== boxId) {
      openIdempotencyKeyRef.current = newLuckyBoxIdempotencyKey('lb_o');
      openIdempotencyBoxRef.current = boxId;
    }
    const ik = openIdempotencyKeyRef.current;

    const stuckGuard = window.setTimeout(() => {
      setOpeningBox((cur) => (cur === boxId ? null : cur));
      setNotice({
        variant: 'error',
        title: 'Caixas da Sorte',
        message:
          'A abertura está a demorar mais do que o esperado. Recarrega a página e verifica Meu inventário (caixas) e Inventário (itens) antes de tentar de novo — a abertura pode ter sido registada.'
      });
    }, 70_000);

    void (async () => {
      try {
        const result = await postLuckyBoxOpen({
          boxId,
          email: userEmail ?? undefined,
          idempotencyKey: ik
        });
        if (!result.ok) {
          setNotice({
            variant: 'error',
            title: t('luckyBoxes.title'),
            message: result.error || t('luckyBoxes.openFailed')
          });
          await refreshState({ quiet: true });
          return;
        }
        openIdempotencyKeyRef.current = null;
        openIdempotencyBoxRef.current = null;
        if (result.rewards && result.rewards.length > 0) {
          setRewards(result.rewards);
        } else {
          setNotice({
            variant: 'info',
            title: t('luckyBoxes.boxOpened'),
            message:
              'Abertura confirmada. Se não viste prémios na lista, verifica o Inventário (Depósito de peças) — itens e baterias vão para lá.'
          });
        }
        await refreshState({ quiet: true });
      } catch (e: unknown) {
        setNotice({
          variant: 'error',
          title: t('luckyBoxes.title'),
          message: e instanceof Error ? e.message : t('luckyBoxes.openFailed')
        });
        await refreshState({ quiet: true });
      } finally {
        window.clearTimeout(stuckGuard);
        setOpeningBox(null);
      }
    })();
  };

  const handleDiscardClick = async (boxId: string, name: string) => {
    if (!window.confirm(t('luckyBoxes.discardConfirm', { name: `«${name}»` }))) {
      return;
    }
    setDiscardingBox(boxId);
    try {
      const result = await postLuckyBoxDiscard({ boxId, email: userEmail ?? undefined });
      if (!result.ok) {
        setNotice({
          variant: 'error',
          title: t('luckyBoxes.title'),
          message: result.error || t('luckyBoxes.discardFailed')
        });
        return;
      }
      await refreshState();
    } finally {
      setDiscardingBox(null);
    }
  };

  const handleRedeem = async () => {
    if (!promoCode.trim() || redeeming) return;
    const codeNorm = promoCode.trim();
    if (!promoIdempotencyKeyRef.current || promoIdempotencyCodeRef.current !== codeNorm) {
      promoIdempotencyKeyRef.current = newLuckyBoxIdempotencyKey('promo');
      promoIdempotencyCodeRef.current = codeNorm;
    }
    const ik = promoIdempotencyKeyRef.current;
    setRedeeming(true);
    try {
      const data = await redeemLuckyBoxPromoCode({
        code: codeNorm,
        idempotencyKey: ik
      });

      if (data.ok) {
        promoIdempotencyKeyRef.current = null;
        promoIdempotencyCodeRef.current = null;
        if (data.type === 'roleta') {
          const c = typeof data.code === 'string' ? data.code.trim() : '';
          setPromoCode('');
          if (c && onOpenRoleta) {
            onOpenRoleta(c);
          } else if (c) {
            setNotice({
              variant: 'info',
              title: t('luckyBoxes.redeemOk'),
              message: t('luckyBoxes.openRoletaHint')
            });
          }
        } else {
          setNotice({ variant: 'success', message: t('luckyBoxes.codeRedeemed') });
          setPromoCode('');
          await refreshState();
          setActiveTab('inventario');
        }
      } else {
        setNotice({ variant: 'error', message: data.error || t('luckyBoxes.redeemCodeError') });
      }
    } catch {
      setNotice({ variant: 'error', message: t('luckyBoxes.serverCommFailed') });
    } finally {
      setRedeeming(false);
    }
  };

  if (loading && !state) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-12 text-slate-500">
        <Loader2 className="h-8 w-8 animate-spin text-orange-500" aria-hidden />
        <p className="text-sm">{t('luckyBoxes.loading')}</p>
      </div>
    );
  }

  if (loadError && !state) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center dark:border-slate-700 dark:bg-slate-900/40">
        <p className="text-slate-700 dark:text-slate-300">{loadError}</p>
      </div>
    );
  }

  const shopRows = state?.shop ?? [];
  const shopEmptyMessage =
    shopRows.length > 0 ? '' : state?.shopEmptyMessage || 'Nenhuma caixa disponível para compra no momento.';

  return (
    <div className="relative flex flex-col p-3 animate-in fade-in slide-in-from-bottom-4 duration-300 sm:p-6">
      <div className="mb-6 flex items-center gap-3 border-b border-slate-200 pb-4 dark:border-slate-800">
        <div className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-700 p-2 text-white shadow-lg">
          <Gift size={24} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-800 dark:text-slate-200 sm:text-xl">{t('luckyBoxes.boxSingular')}</h2>
          <p className="text-xs text-slate-500 sm:text-sm">
            Loja para comprar; inventário separado para abrir o que você já tem.
          </p>
        </div>
      </div>

      <div
        id="lucky-store-redeem"
        className="mb-6 rounded-2xl border border-orange-500/25 bg-gradient-to-r from-orange-900/15 to-amber-950/35 p-4 shadow-sm sm:p-6"
      >
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 flex-1">
            <h3 className="mb-1 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-orange-600 dark:text-orange-400 sm:text-sm">
              <Ticket size={18} aria-hidden /> {t('luckyBoxes.promoCode')}
            </h3>
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
              Insere um código de campanha para receber caixas ou prémios. Códigos da Roleta abrem na
              aba Roleta.
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-stretch md:w-auto md:shrink-0">
            <input
              ref={promoInputRef}
              type="text"
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
              placeholder={t('luckyBoxes.codeLabel')}
              className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-4 py-2 font-mono text-sm font-bold tracking-widest text-orange-600 focus:outline-none focus:ring-2 focus:ring-orange-500/50 dark:border-slate-700 dark:bg-slate-950 dark:text-orange-400 sm:min-w-[12rem] md:w-56"
            />
            <button
              type="button"
              onClick={() => void handleRedeem()}
              disabled={redeeming || !promoCode.trim()}
              className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-xl bg-orange-600 px-6 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-orange-600/25 transition hover:bg-orange-500 disabled:opacity-50"
            >
              {redeeming ? (
                <>
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                  {t('wheel.redeeming')}
                </>
              ) : (
                t('wheel.redeem')
              )}
            </button>
          </div>
        </div>
      </div>

      <nav className="mb-6 flex flex-wrap gap-2" aria-label={t('luckyBoxes.shopSections')}>
        <button
          type="button"
          onClick={() => setActiveTab('inventario')}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold uppercase tracking-widest transition-all ${
            activeTab === 'inventario'
              ? 'bg-orange-600 text-white shadow-lg shadow-orange-600/25'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800/80 dark:text-slate-400 dark:hover:bg-slate-700'
          }`}
        >
          <Package size={16} />
          {t('luckyBoxes.myInventory')}
          {openableInventoryTotal > 0 ? (
            <span className="ml-0.5 rounded-full bg-white/20 px-2 py-0.5 text-[10px] tabular-nums">
              {openableInventoryTotal}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('loja')}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold uppercase tracking-widest transition-all ${
            activeTab === 'loja'
              ? 'bg-orange-600 text-white shadow-lg shadow-orange-600/25'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800/80 dark:text-slate-400 dark:hover:bg-slate-700'
          }`}
        >
          <Store size={16} />
          Loja
        </button>
      </nav>

      {state?.banner && (
        <div
          className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
            state.banner.variant === 'warning'
              ? 'border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100'
              : 'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-600 dark:bg-slate-800/80 dark:text-slate-200'
          }`}
          role="status"
        >
          {state.banner.text}
        </div>
      )}

      {activeTab === 'inventario' && (
        <div className="mb-8">
          <h3 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-slate-500">
            <Package size={16} /> {t('luckyBoxes.inventoryOpen')} ({openableInventoryTotal})
          </h3>
          {ownedBoxes.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/80 px-6 py-14 text-center dark:border-slate-700 dark:bg-slate-900/40">
              <p className="mb-2 font-medium text-slate-700 dark:text-slate-300">{t('luckyBoxes.noBoxesToOpen')}</p>
              <p className="mb-6 text-sm text-slate-500">{t('luckyBoxes.buyOrPromoHint')}</p>
              <button
                type="button"
                onClick={() => setActiveTab('loja')}
                className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-md shadow-amber-600/20 transition hover:bg-amber-500 active:scale-95"
              >
                Ir à loja
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {ownedBoxes.map((box) => (
                <div
                  key={box.boxId}
                  className="group relative flex flex-col items-center overflow-hidden rounded-xl border-2 border-orange-500/30 bg-white p-4 text-center shadow-lg dark:bg-slate-900"
                >
                  <div className="absolute inset-0 bg-orange-500/5 transition-colors group-hover:bg-orange-500/10" />
                  <div className="relative z-10 mb-3 flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-slate-100 text-3xl shadow-inner dark:bg-slate-800">
                    {renderBoxThumb(box.icon, 'h-10 w-10')}
                  </div>
                  <div className="relative z-10 font-bold text-slate-800 dark:text-white">{displayLootBoxName(box.name)}</div>
                  <div className="relative z-10 mb-4 text-xs text-slate-500">{box.description}</div>
                  <div className="relative z-10 mb-4 w-full text-left">
                    <div className="mb-2 text-[11px] uppercase tracking-wider text-slate-500">{t('luckyBoxes.possiblePrizes')}</div>
                    <div className="space-y-1">
                      {box.rewardSummary.slots.map((s, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-2 rounded border border-slate-200 bg-slate-50 p-2 text-[12px] dark:border-slate-800 dark:bg-slate-950/40"
                        >
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden">
                            {renderCatalogImage(resolveSlotImage(s), 'h-5 w-5')}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-300">{s.label}</span>
                          <span className="shrink-0 font-mono text-slate-600 dark:text-slate-400">{s.rangeText}</span>
                          {s.chanceText ? (
                            <span className="shrink-0 font-mono text-yellow-600 dark:text-yellow-400">{s.chanceText}</span>
                          ) : null}
                        </div>
                      ))}
                      {box.rewardSummary.slots.length === 0 && (
                        <div className="text-[12px] text-slate-500">{t('luckyBoxes.prizesOnOpen')}</div>
                      )}
                    </div>
                  </div>
                  <div className="relative z-10 mb-3 rounded-full bg-orange-100 px-3 py-1 text-xs font-bold text-orange-600 dark:bg-orange-900/30 dark:text-orange-400">
                    Quantidade: {box.qty}
                  </div>
                  <div className="relative z-10 flex w-full flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => handleOpen(box.boxId)}
                      disabled={openingBox !== null || discardingBox !== null}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-600 py-2 font-bold text-white transition-all hover:bg-orange-500 active:scale-95 disabled:opacity-50"
                    >
                      {openingBox === box.boxId ? (
                        <Sparkles className="animate-spin" size={16} />
                      ) : (
                        <Box size={16} />
                      )}
                      {openingBox === box.boxId ? t('luckyBoxes.opening') : t('luckyBoxes.openNow')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDiscardClick(box.boxId, box.name)}
                      disabled={openingBox !== null || discardingBox !== null}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 py-2 text-xs font-bold uppercase tracking-wider text-red-600 transition-all hover:bg-red-500/20 active:scale-95 disabled:opacity-50 dark:text-red-400"
                    >
                      {discardingBox === box.boxId ? (
                        <Sparkles className="animate-spin" size={14} />
                      ) : (
                        <Trash2 size={14} />
                      )}
                      {discardingBox === box.boxId ? t('luckyBoxes.discarding') : t('luckyBoxes.discard')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'loja' && (
        <div>
          <h3 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-slate-500">
            <DollarSign size={16} /> {t('luckyBoxes.shopTitle')}
          </h3>
          <p className="-mt-2 mb-4 text-xs text-slate-500">
            Só aparecem ofertas que você ainda pode comprar. Caixas que você já tem ficam em{' '}
            <span className="font-semibold text-slate-600 dark:text-slate-400">Meu inventário</span>.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {shopRows.map((entry) => {
              const availability = serverShopAvailability(entry);
              const canAfford = reserveUsdc >= entry.priceUsdc;
              const buyingThis = buyingBoxId === entry.id;
              const shopBusyElsewhere = buyingBoxId !== null && !buyingThis;
              const disabledShop = !availability.canBuy || !canAfford || shopBusyElsewhere || buyingThis;
              const showBuyActive = (availability.canBuy && canAfford) || buyingThis;
              return (
                <div
                  key={entry.id}
                  className="group relative flex flex-col items-center overflow-hidden rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm transition-all hover:border-amber-500 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-amber-500"
                >
                  <div className="mb-3 flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-slate-100 text-3xl shadow-inner transition-transform group-hover:scale-110 dark:bg-slate-800">
                    {renderBoxThumb(entry.icon, 'h-10 w-10')}
                  </div>
                  <div className="font-bold text-slate-800 dark:text-white">{displayLootBoxName(entry.name)}</div>
                  <div className="mb-3 line-clamp-2 h-8 text-xs text-slate-500">{entry.description}</div>
                  {entry.stockRemaining != null && (
                    <div className="mb-2 font-mono text-[10px] text-amber-700 dark:text-amber-400">
                      Restam: {entry.stockRemaining}
                    </div>
                  )}
                  <div className="mb-3 w-full text-left">
                    <div className="mb-2 text-[11px] uppercase tracking-wider text-slate-500">{t('luckyBoxes.possiblePrizes')}</div>
                    <div className="space-y-1">
                      {entry.rewardSummary.slots.map((s, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-2 rounded border border-slate-200 bg-slate-50 p-2 text-[12px] dark:border-slate-800 dark:bg-slate-950/40"
                        >
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden">
                            {renderCatalogImage(resolveSlotImage(s), 'h-5 w-5')}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-300">{s.label}</span>
                          <span className="shrink-0 font-mono text-slate-600 dark:text-slate-400">{s.rangeText}</span>
                          {s.chanceText ? (
                            <span className="shrink-0 font-mono text-yellow-600 dark:text-yellow-400">{s.chanceText}</span>
                          ) : null}
                        </div>
                      ))}
                      {entry.rewardSummary.slots.length === 0 && (
                        <div className="text-[12px] text-slate-500">{t('luckyBoxes.prizesOnOpen')}</div>
                      )}
                    </div>
                  </div>
                  <div className="mt-auto w-full">
                    <button
                      type="button"
                      onClick={() => void handleBuy(entry.id)}
                      disabled={disabledShop}
                      className={`flex w-full items-center justify-center gap-1 rounded-lg py-2 text-sm font-bold transition-all active:scale-95 ${
                        showBuyActive
                          ? 'bg-amber-600 text-white shadow-lg shadow-amber-500/20 hover:bg-amber-500'
                          : 'cursor-not-allowed bg-slate-200 text-slate-400 dark:bg-slate-800'
                      }`}
                    >
                      {buyingThis ? (
                        <>
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                          <span className="uppercase tracking-wider">{t('luckyBoxes.buying')}</span>
                        </>
                      ) : availability.label ? (
                        <span className="flex items-center gap-1 uppercase tracking-wider">
                          <Gift size={14} /> {availability.label}
                        </span>
                      ) : entry.priceUsdc <= 0 ? (
                        <span className="flex items-center gap-1 uppercase tracking-wider">
                          <Gift size={14} /> {t('luckyBoxes.free')}
                        </span>
                      ) : (
                        <>
                          <DollarSign size={14} /> {formatCost(entry.priceUsdc)}
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
            {shopRows.length === 0 && (
              <div className="col-span-full rounded-xl border-2 border-dashed border-slate-200 py-12 text-center italic text-slate-500 dark:border-slate-800">
                {shopEmptyMessage}
              </div>
            )}
          </div>
        </div>
      )}

      {rewards && (
        <div
          className="fixed inset-0 z-50 flex animate-in fade-in items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-sm duration-300"
          onClick={() => setRewards(null)}
        >
          <div
            className="relative flex max-h-[min(90dvh,36rem)] w-full max-w-md animate-in zoom-in-95 flex-col items-center overflow-hidden rounded-2xl border border-orange-500 bg-white p-6 shadow-[0_0_50px_rgba(194,65,12,0.3)] duration-300 dark:bg-slate-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute -top-10 left-1/2 -translate-x-1/2">
              <div className="animate-bounce rounded-full border-4 border-slate-900 bg-orange-600 p-4 text-white shadow-lg">
                <Gift size={32} />
              </div>
            </div>

            <h3 className="mb-2 mt-6 shrink-0 bg-gradient-to-r from-amber-500 to-orange-700 bg-clip-text text-2xl font-black uppercase tracking-widest text-transparent">
              RECOMPENSAS!
            </h3>
            <p className="mb-6 shrink-0 text-sm text-slate-500">
              Você encontrou os seguintes itens — já estão no teu Inventário (Depósito de peças):
            </p>

            <div className="mb-8 min-h-0 w-full flex-1 space-y-3 overflow-y-auto">
              {rewards.map((reward, idx) => {
                const d = rewardVisual(reward);
                const qtyLabel =
                  reward.type === 'currency' && reward.id === 'usdc'
                    ? formatCost(reward.qty)
                    : String(reward.qty);

                return (
                  <div
                    key={idx}
                    className="flex animate-in slide-in-from-bottom-2 items-center gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3 duration-500 dark:border-slate-700 dark:bg-slate-800"
                    style={{ animationDelay: `${Math.min(idx, 12) * 100}ms` }}
                  >
                    <div className="flex h-10 w-10 items-center justify-center overflow-hidden">
                      {renderCatalogImage(d.image, 'h-8 w-8')}
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-bold text-slate-800 dark:text-white">{d.name}</div>
                      <div className="text-xs uppercase text-slate-500">{d.category}</div>
                    </div>
                    {d.showQty ? (
                      <div className="font-mono font-bold text-green-600 dark:text-green-400">x{qtyLabel}</div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => setRewards(null)}
              className="flex shrink-0 items-center gap-2 rounded-full bg-orange-600 px-8 py-3 font-bold text-white shadow-lg transition-transform hover:bg-orange-500 active:scale-95"
            >
              <CheckCircle2 size={18} /> {t('luckyBoxes.collectAll')}
            </button>
          </div>
        </div>
      )}

      <UiNoticeModal notice={notice} onClose={() => setNotice(null)} overlayZClassName="z-[150]" />
    </div>
  );
}
