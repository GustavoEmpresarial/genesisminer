/**
 * Eventos e passes (upgrade packages) — player view.
 * Ported from `legacy/frontend/components/UpgradeAccount.tsx`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';
import type { LucideIcon } from 'lucide-react';
import { Crown, CheckCircle2, ShieldCheck, Zap, Rocket, Gift, X, Loader2 } from 'lucide-react';
import {
  getUpgradesState,
  postUpgradesPurchase,
  type UpgradesStatePackage,
  type UpgradesStatePackagePreview,
  type UpgradesStatePayload
} from '../../../shared/api/upgrades';
import { newWheelIdempotencyKey } from '../../../shared/api/wheel';
import { appendUsdcShortfallLine, looksLikeInsufficientUsdcMessage } from '../../../shared/utils/playerMoneyMessages';
import { normalizePublicAssetUrl } from '../../../shared/utils/public-url';
import { formatHashrateAmount } from '../../../shared/utils/locale-format';
import { UiNoticeModal, type UiNotice } from '../../../shared/ui/UiNoticeModal';
import { useT } from '../../../shared/i18n';

/** Compact pass photo. `h-16` is the same 4rem media box used on other player cards. */
const PASS_PHOTO_BOX_CLASS =
  'flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-800 bg-black/40';
const PASS_FALLBACK_ICON_PX = 24;

export type UpgradesPageProps = {
  usdcBalance: number;
  onUsdcChange?: (usdc: number) => void;
  onGoToLuckyBoxes?: () => void;
  /** Navegar para carteira (stub) quando saldo USDC insuficiente. */
  onGoToWallet?: () => void;
  user?: { email?: string; username?: string; accessLevel?: string } | null;
};

type PurchaseSuccess = {
  packageName: string;
  boxName: string | null;
  itemsPreview: string[];
};

type PackageItemPreview = {
  imageUrl: string;
  label: string;
  quantity: number;
  baseProduction: number;
};

/** Lista branca para descrições HTML vindas do admin. */
const RICH_HTML_PURIFY: Config = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'strong',
    'em',
    'b',
    'i',
    'u',
    'span',
    'div',
    'ul',
    'ol',
    'li',
    'h3',
    'h4',
    'h5',
    'small',
    'sub',
    'sup',
    'a'
  ],
  ALLOWED_ATTR: ['class', 'href', 'title', 'target', 'rel'],
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false
};

let richHtmlPurifyHooksInstalled = false;
function ensureRichHtmlPurifyHooks(): void {
  if (richHtmlPurifyHooksInstalled) return;
  richHtmlPurifyHooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'A' || !(node instanceof HTMLAnchorElement)) return;
    if (node.getAttribute('target') === '_blank') {
      const rel = node.getAttribute('rel') || '';
      if (!/\bnoopener\b/i.test(rel)) {
        node.setAttribute('rel', rel ? `${rel} noopener noreferrer`.trim() : 'noopener noreferrer');
      }
    }
  });
}

function sanitizeRichHtmlFragment(html: string): string {
  if (!html) return '';
  ensureRichHtmlPurifyHooks();
  return DOMPurify.sanitize(html, RICH_HTML_PURIFY);
}

const RichDescription: React.FC<{ content: string; isRaw?: boolean }> = ({ content, isRaw }) => {
  if (!content) return null;

  let trimmed = content.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    trimmed = trimmed.substring(1, trimmed.length - 1).trim();
  }

  if (!trimmed.startsWith('<')) {
    return (
      <div
        className={`mb-4 text-sm ${isRaw ? '' : 'text-slate-600 dark:text-slate-300'}`}
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
      >
        {trimmed}
      </div>
    );
  }

  const processed = trimmed.replace(/className=/g, 'class=');
  const iconRegex = /<([A-Z][a-zA-Z0-9]+)\s*([^>]*)\/>/g;
  const iconsMap: Record<string, LucideIcon> = { Gift, CheckCircle2, ShieldCheck, Zap, Rocket, Crown };

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = iconRegex.exec(processed)) !== null) {
    if (match.index > lastIndex) {
      const htmlPart = processed.substring(lastIndex, match.index);
      parts.push(
        <span key={`text-${lastIndex}`} dangerouslySetInnerHTML={{ __html: sanitizeRichHtmlFragment(htmlPart) }} />
      );
    }
    const iconName = match[1];
    const propsStr = match[2];
    const IconComponent = iconsMap[iconName];
    if (IconComponent) {
      const sizeMatch = propsStr.match(/size=\{?(\d+)\}?/);
      const classMatch = propsStr.match(/class(?:Name)?=["']([^"']+)["']/);
      parts.push(
        <IconComponent
          key={`icon-${match.index}`}
          size={sizeMatch ? parseInt(sizeMatch[1], 10) : 16}
          className={classMatch ? classMatch[1] : ''}
        />
      );
    } else {
      parts.push(<span key={`error-${match.index}`}>{match[0]}</span>);
    }
    lastIndex = iconRegex.lastIndex;
  }

  if (lastIndex < processed.length) {
    const htmlPart = processed.substring(lastIndex);
    parts.push(
      <span key={`text-${lastIndex}`} dangerouslySetInnerHTML={{ __html: sanitizeRichHtmlFragment(htmlPart) }} />
    );
  }

  return (
    <div
      className={`rich-description ${isRaw ? '' : 'mb-4 text-sm text-slate-600 dark:text-slate-300'}`}
      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
    >
      {parts}
    </div>
  );
};

function safePackageImageUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.startsWith('/')) return t;
  if (/^https:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*\//.test(t)) return t;
  const normalized = normalizePublicAssetUrl(t);
  if (normalized && (normalized.startsWith('/') || /^https:\/\//.test(normalized))) return normalized;
  return null;
}

function formatUsdcDisplay(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n === 0) return '0.00';
  if (n < 0.01) return n.toFixed(6);
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

const DISCOUNT_FRACTION_DIGITS = 1;

function passAccentClass(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('genesis dao') || n.includes('náutilos') || n.includes('nautilos')) return 'border-l-amber-400';
  if (n.includes('nemo')) return 'border-l-orange-500';
  if (n.includes('baleia')) return 'border-l-amber-500';
  if (n.includes('kraken')) return 'border-l-emerald-500';
  return 'border-l-gray-600';
}

export function UpgradesPage({
  onUsdcChange,
  onGoToLuckyBoxes,
  onGoToWallet,
  user
}: UpgradesPageProps) {
  const t = useT();
  const [upgradesState, setUpgradesState] = useState<UpgradesStatePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [purchaseBusyId, setPurchaseBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<UiNotice | null>(null);
  const [purchaseSuccess, setPurchaseSuccess] = useState<PurchaseSuccess | null>(null);
  const [confirmPackage, setConfirmPackage] = useState<UpgradesStatePackage | null>(null);
  const [itemPreview, setItemPreview] = useState<PackageItemPreview | null>(null);

  const closeItemPreview = useCallback(() => setItemPreview(null), []);

  useEffect(() => {
    if (!itemPreview) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeItemPreview();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [itemPreview, closeItemPreview]);

  const openItemPreview = useCallback((row: UpgradesStatePackagePreview, thumb: string) => {
    setItemPreview({
      imageUrl: thumb,
      label: row.label,
      quantity: row.quantity,
      baseProduction: row.baseProduction
    });
  }, []);

  const reloadState = useCallback(async () => {
    const s = await getUpgradesState();
    setUpgradesState(s);
    if (s && typeof s.usdcBalance === 'number') {
      onUsdcChange?.(s.usdcBalance);
    }
    setLoading(false);
  }, [onUsdcChange]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    void (async () => {
      await reloadState();
      if (!mounted) return;
    })();
    return () => {
      mounted = false;
    };
  }, [reloadState, user?.email]);

  const executePurchase = async (pkg: UpgradesStatePackage) => {
    if (purchaseBusyId) return;
    if (!pkg.isPurchasable) return;
    setPurchaseBusyId(pkg.id);
    const idem = newWheelIdempotencyKey();
    const res = await postUpgradesPurchase({
      packageId: pkg.id,
      idempotencyKey: idem,
      clientPackageVersion: pkg.version
    });
    setPurchaseBusyId(null);
    if (res.ok === true) {
      if (typeof res.newUsdc === 'number' && Number.isFinite(res.newUsdc)) {
        onUsdcChange?.(res.newUsdc);
      }
      await reloadState();
      const itemsPreview = (pkg.itemsPreview || []).map((row) => `${row.quantity}x ${row.label}`);
      setPurchaseSuccess({
        packageName: pkg.name,
        boxName: res.box?.name || t('upgrades.boxFallback', { name: pkg.name }),
        itemsPreview
      });
      return;
    }
    if (res.status === 409 || res.status === 422) {
      await reloadState();
      const err = res.error || '';
      const isStaleOffer =
        res.status === 409 || /atualizada|recarreg/i.test(err) || /vers[aã]o|oferta/i.test(err);
      setNotice({
        variant: isStaleOffer ? 'info' : 'error',
        title: isStaleOffer ? t('upgrades.offerUpdated') : t('upgrades.purchaseNotCompleted'),
        message: err || t('upgrades.tryAgain')
      });
      return;
    }
    if (res.missing != null && onGoToWallet) {
      onGoToWallet();
    }
    setNotice({
      variant: 'error',
      title: t('upgrades.purchaseFailedTitle'),
      message: appendUsdcShortfallLine(res.error || t('upgrades.purchaseFailed'), res.missing)
    });
  };

  const requestPurchase = (pkg: UpgradesStatePackage) => {
    if (purchaseBusyId) return;
    if (!pkg.isPurchasable) return;
    setConfirmPackage(pkg);
  };

  const packages = upgradesState?.packages ?? [];

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#1a1b26] p-3 font-sans text-white sm:p-6">
      <div className="mx-auto w-full min-w-0 max-w-6xl">
        <header className="mb-6 flex flex-col gap-1 sm:mb-8">
          <h1 className="bg-gradient-to-r from-amber-400 to-orange-700 bg-clip-text text-2xl font-bold text-transparent sm:text-3xl">
            {t('upgrades.title')}
          </h1>
          <p className="text-sm leading-relaxed text-gray-400">{t('upgrades.subtitle')}</p>
        </header>

        {loading ? (
          <div className="flex min-h-[40vh] items-center justify-center text-white">
            <Loader2 className="mr-2 animate-spin text-amber-400" size={PASS_FALLBACK_ICON_PX} aria-hidden />
            <span>{t('upgrades.loading')}</span>
          </div>
        ) : packages.length === 0 ? (
          <div className="mx-auto flex max-w-xl flex-col items-center justify-center rounded-xl border border-gray-800 bg-[#16161e] px-6 py-16 text-center">
            <Crown className="mb-4 text-gray-500" size={PASS_FALLBACK_ICON_PX * 2} />
            <p className="mb-2 text-lg font-bold text-white">{t('upgrades.emptyTitle')}</p>
            <p className="max-w-md text-sm text-gray-400">{t('upgrades.emptyBody')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {packages.map((offer) => {
              const img = safePackageImageUrl(offer.imageUrl);
              const busy = purchaseBusyId === offer.id;
              const anyBusy = purchaseBusyId != null;
              const accent = passAccentClass(offer.name);

              return (
                <article
                  key={offer.id}
                  className={`flex flex-col rounded-xl border border-gray-800 border-l-2 bg-[#16161e] p-4 ${accent}`}
                >
                  <div className="flex flex-col">
                    <div className="flex items-start gap-3">
                      <div className={PASS_PHOTO_BOX_CLASS}>
                        {img ? (
                          <img src={img} alt={offer.name} className="h-full w-full object-contain p-1" loading="lazy" />
                        ) : (
                          <Crown className="text-amber-400" size={PASS_FALLBACK_ICON_PX} aria-hidden />
                        )}
                      </div>
                      <h2 className="min-w-0 text-lg font-bold leading-tight text-white">{offer.name}</h2>
                    </div>

                    <div className="mt-3 text-sm leading-relaxed text-gray-400">
                      <RichDescription
                        isRaw
                        content={offer.description?.trim() ? offer.description : t('upgrades.fallbackDescription')}
                      />
                    </div>

                    <div className="mb-4 mt-4 flex flex-col gap-1">
                      {offer.originalPrice && Number(offer.originalPrice) > Number(offer.finalPrice) ? (
                        <div className="font-mono text-sm text-gray-500 line-through">
                          ${formatUsdcDisplay(offer.originalPrice)} USDC
                        </div>
                      ) : null}
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-2xl font-bold text-white">${formatUsdcDisplay(offer.finalPrice)}</span>
                        <span className="text-xs font-bold uppercase tracking-wide text-gray-400">
                          {offer.currency}
                        </span>
                        {offer.discountPercent != null && offer.discountPercent > 0 ? (
                          <span className="rounded-full bg-emerald-900/40 px-2 py-0.5 text-xs font-bold text-emerald-300">
                            -{offer.discountPercent.toFixed(DISCOUNT_FRACTION_DIGITS)}%
                          </span>
                        ) : null}
                      </div>
                      {offer.stockRemaining != null ? (
                        <div className="font-mono text-xs text-gray-400">
                          {t('upgrades.stockRemaining', { count: offer.stockRemaining })}
                        </div>
                      ) : null}
                      {offer.unpurchasableReason ? (
                        <div className="text-xs text-amber-300/90">{offer.unpurchasableReason}</div>
                      ) : null}
                    </div>

                    <button
                      type="button"
                      onClick={() => requestPurchase(offer)}
                      disabled={anyBusy || !offer.isPurchasable}
                      className={`mb-4 w-full rounded-xl py-2.5 text-sm font-bold transition disabled:opacity-50 ${
                        !offer.isPurchasable
                          ? 'bg-slate-800 text-slate-400'
                          : 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                      }`}
                    >
                      {busy
                        ? t('upgrades.processing')
                        : !offer.isPurchasable
                          ? looksLikeInsufficientUsdcMessage(offer.unpurchasableReason || '')
                            ? t('upgrades.insufficientBalance')
                            : t('upgrades.unavailable')
                          : t('upgrades.buy')}
                    </button>

                    <div className="flex-1 space-y-3">
                      {offer.itemsPreview.length > 0 && (
                        <>
                          <div className="text-xs font-bold uppercase tracking-wide text-gray-400">
                            {t('upgrades.packageContents')}
                          </div>
                          <div className="space-y-2">
                            {offer.itemsPreview.map((row, i) => {
                              const thumb = safePackageImageUrl(row.imageUrl);
                              const showPower = row.baseProduction > 0;
                              return (
                                <div
                                  key={`${row.rewardType}-${row.catalogId}-${i}`}
                                  className="flex items-center gap-3 rounded-xl border border-gray-800 bg-black/20 p-3 text-sm"
                                >
                                  {thumb ? (
                                    <button
                                      type="button"
                                      className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-800 bg-black/40 transition hover:border-amber-500/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
                                      aria-label={t('upgrades.previewItem', { label: row.label })}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openItemPreview(row, thumb);
                                      }}
                                    >
                                      <img src={thumb} alt="" className="h-full w-full object-contain p-0.5" />
                                    </button>
                                  ) : (
                                    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-800 bg-black/40">
                                      <Gift size={PASS_FALLBACK_ICON_PX} className="text-gray-500" aria-hidden />
                                    </div>
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <div className="flex min-w-0 items-center gap-2">
                                      <span className="shrink-0 font-bold text-amber-300">{row.quantity}x</span>
                                      <span className="truncate text-gray-200">{row.label}</span>
                                    </div>
                                    {showPower ? (
                                      <div className="mt-0.5 font-mono text-xs text-emerald-300">
                                        +{formatHashrateAmount(row.baseProduction)} H/s
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {itemPreview ? (
        <div
          className="fixed inset-0 z-[155] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t('upgrades.previewItem', { label: itemPreview.label })}
          onClick={closeItemPreview}
        >
          <div
            className="relative w-full max-w-md rounded-2xl border border-amber-600/50 bg-slate-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={closeItemPreview}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
              aria-label={t('upgrades.close')}
            >
              <X size={PASS_FALLBACK_ICON_PX} aria-hidden />
            </button>
            <div className="mb-4 flex aspect-square max-h-72 w-full items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/40">
              <img
                src={itemPreview.imageUrl}
                alt={itemPreview.label}
                className="h-full w-full object-contain p-3"
              />
            </div>
            <div className="pr-8">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="shrink-0 text-lg font-black text-amber-300">{itemPreview.quantity}x</span>
                <h3 className="truncate text-base font-black uppercase tracking-wide text-white">
                  {itemPreview.label}
                </h3>
              </div>
              {itemPreview.baseProduction > 0 ? (
                <p className="mt-2 font-mono text-sm text-green-400">
                  +{formatHashrateAmount(itemPreview.baseProduction)} H/s
                </p>
              ) : null}
            </div>
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={closeItemPreview}
                className="w-full rounded-xl border border-slate-600 bg-slate-800 py-2.5 text-xs font-black uppercase tracking-widest text-slate-200 transition hover:bg-slate-700 sm:w-auto sm:min-w-[140px]"
              >
                {t('upgrades.close')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmPackage ? (
        <div
          className="fixed inset-0 z-[155] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t('upgrades.confirmTitle')}
          onClick={() => setConfirmPackage(null)}
        >
          <div
            className="relative w-full max-w-md rounded-2xl border border-amber-600/50 bg-slate-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 pr-8 text-base font-bold text-white">{t('upgrades.confirmTitle')}</h3>
            <p className="text-sm text-gray-300">
              {t('upgrades.confirmBody', {
                name: confirmPackage.name,
                price: formatUsdcDisplay(confirmPackage.finalPrice)
              })}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-gray-400">{t('upgrades.confirmHint')}</p>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setConfirmPackage(null)}
                className="w-full rounded-xl border border-slate-600 bg-slate-800 py-2.5 text-xs font-black uppercase tracking-widest text-slate-200 transition hover:bg-slate-700 sm:w-auto sm:min-w-[140px]"
              >
                {t('upgrades.cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  const pkg = confirmPackage;
                  setConfirmPackage(null);
                  void executePurchase(pkg);
                }}
                className="w-full rounded-xl bg-amber-500 py-2.5 text-xs font-black uppercase tracking-widest text-slate-950 transition hover:bg-amber-400 sm:w-auto sm:min-w-[180px]"
              >
                {t('upgrades.confirmPay')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <UiNoticeModal notice={notice} onClose={() => setNotice(null)} overlayZClassName="z-[150]" />

      {purchaseSuccess ? (
        <div
          className="fixed inset-0 z-[160] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t('upgrades.successTitle')}
          onClick={() => setPurchaseSuccess(null)}
        >
          <div
            className="relative w-full max-w-md rounded-2xl border border-emerald-600/60 bg-slate-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 inline-flex rounded-full bg-emerald-500/20 p-2 text-emerald-400">
              <Gift size={PASS_FALLBACK_ICON_PX} aria-hidden />
            </div>
            <h3 className="mb-2 text-base font-bold text-white">{t('upgrades.successTitle')}</h3>
            <p className="text-sm leading-relaxed text-gray-300">
              {purchaseSuccess.boxName
                ? t('upgrades.successWithBox', { box: purchaseSuccess.boxName })
                : t('upgrades.successNoBox')}
            </p>
            {purchaseSuccess.itemsPreview.length > 0 ? (
              <div className="mt-4 max-h-48 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <div className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-400">
                  {t('upgrades.contents')}
                </div>
                <ul className="space-y-1">
                  {purchaseSuccess.itemsPreview.map((line, i) => (
                    <li key={i} className="text-xs text-slate-200">
                      • {line}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              {onGoToLuckyBoxes ? (
                <button
                  type="button"
                  onClick={() => {
                    setPurchaseSuccess(null);
                    onGoToLuckyBoxes();
                  }}
                  className="w-full rounded-xl bg-amber-500 py-2.5 text-xs font-black uppercase tracking-widest text-slate-950 transition hover:bg-amber-400 sm:flex-1"
                >
                  {t('upgrades.goToLuckyBoxes')}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setPurchaseSuccess(null)}
                className="w-full rounded-xl bg-slate-800 py-2.5 text-xs font-black uppercase tracking-widest text-white transition hover:bg-slate-700 sm:flex-1"
              >
                {t('upgrades.continue')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
