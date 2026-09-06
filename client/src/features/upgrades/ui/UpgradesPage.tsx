/**
 * Eventos e passes (upgrade packages) — player view.
 * Ported from `legacy/frontend/components/UpgradeAccount.tsx`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';
import type { LucideIcon } from 'lucide-react';
import { Crown, CheckCircle2, ShieldCheck, Zap, Rocket, Gift } from 'lucide-react';
import {
  getUpgradesState,
  postUpgradesPurchase,
  type UpgradesStatePackage,
  type UpgradesStatePayload
} from '../../../shared/api/upgrades';
import { newWheelIdempotencyKey } from '../../../shared/api/wheel';
import { appendUsdcShortfallLine, looksLikeInsufficientUsdcMessage } from '../../../shared/utils/playerMoneyMessages';
import { normalizePublicAssetUrl } from '../../../shared/utils/public-url';
import { UiNoticeModal, type UiNotice } from '../../../shared/ui/UiNoticeModal';

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

export function UpgradesPage({
  usdcBalance: _usdcBalance,
  onUsdcChange,
  onGoToLuckyBoxes,
  onGoToWallet,
  user
}: UpgradesPageProps) {
  const [upgradesState, setUpgradesState] = useState<UpgradesStatePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [purchaseBusyId, setPurchaseBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<UiNotice | null>(null);
  const [purchaseSuccess, setPurchaseSuccess] = useState<PurchaseSuccess | null>(null);
  const [confirmPackage, setConfirmPackage] = useState<UpgradesStatePackage | null>(null);

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
        boxName: res.box?.name || `Pacote ${pkg.name}`,
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
        title: isStaleOffer ? 'Oferta atualizada' : 'Compra não concluída',
        message: err || 'Tente novamente.'
      });
      return;
    }
    if (res.missing != null && onGoToWallet) {
      onGoToWallet();
    }
    setNotice({
      variant: 'error',
      title: 'Não foi possível concluir a compra',
      message: appendUsdcShortfallLine(res.error || 'Falha na compra.', res.missing)
    });
  };

  const requestPurchase = (pkg: UpgradesStatePackage) => {
    if (purchaseBusyId) return;
    if (!pkg.isPurchasable) return;
    setConfirmPackage(pkg);
  };

  const packages = upgradesState?.packages ?? [];

  const getTierStyles = (name: string) => {
    const n = name.toLowerCase();
    if (n.includes('genesis dao') || n.includes('náutilos') || n.includes('nautilos'))
      return {
        border: 'neon-border-cyan',
        text: 'text-amber-300 neon-text-cyan',
        btn: 'from-amber-500 to-orange-600 shadow-amber-500/30',
        glow: 'bg-gradient-to-r from-amber-500/20 to-orange-500/25'
      };
    if (n.includes('nemo'))
      return {
        border: 'neon-border-purple',
        text: 'text-orange-500 neon-text-purple',
        btn: 'from-orange-600 to-orange-800 shadow-orange-500/20',
        glow: 'bg-orange-500/10'
      };
    if (n.includes('baleia'))
      return {
        border: 'neon-border-cyan',
        text: 'text-amber-500 neon-text-cyan',
        btn: 'from-amber-600 to-orange-600 shadow-amber-500/20',
        glow: 'bg-amber-500/10'
      };
    if (n.includes('kraken'))
      return {
        border: 'neon-border-green',
        text: 'text-green-500 neon-text-green',
        btn: 'from-green-600 to-emerald-600 shadow-green-500/20',
        glow: 'bg-green-500/10'
      };
    return { border: 'border-slate-800', text: 'text-white', btn: 'from-slate-700 to-slate-800', glow: 'bg-white/5' };
  };

  return (
    <div className="h-full flex flex-col p-8 overflow-y-auto custom-scrollbar relative bg-slate-950">
      <div className="nebula-bg" />

      <div className="relative z-10 w-full max-w-7xl mx-auto">
        <header className="text-center mb-12">
          <h2 className="text-4xl md:text-5xl font-black text-white mb-4 tracking-tight">
            Escolha o{' '}
            <span className="bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">
              nível certo
            </span>{' '}
            para a sua sala
          </h2>
        </header>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-amber-500" aria-busy="true" />
          </div>
        ) : packages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 px-6 text-center rounded-3xl border border-slate-800 bg-slate-900/40 max-w-xl mx-auto">
            <Crown className="text-slate-600 mb-4" size={48} />
            <p className="text-lg font-bold text-slate-200 mb-2">Nenhum upgrade disponível no momento</p>
            <p className="text-sm text-slate-500 max-w-md">
              Não há pacotes à venda para o seu perfil agora. Volte mais tarde ou fale com o suporte se esperava ver
              uma oferta aqui.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {packages.map((offer) => {
              const styles = getTierStyles(offer.name);
              const img = safePackageImageUrl(offer.imageUrl);
              const busy = purchaseBusyId === offer.id;
              const anyBusy = purchaseBusyId != null;

              return (
                <div
                  key={offer.id}
                  className={`group relative glass-card rounded-[2rem] p-8 border transition-all duration-500 flex flex-col min-h-[550px] ${styles.border} ${!offer.isPurchasable ? 'opacity-95' : 'hover:-translate-y-4 hover:brightness-110'}`}
                >
                  <div
                    className={`absolute top-0 inset-x-0 h-40 ${styles.glow} blur-3xl rounded-full -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-700`}
                  />

                  <div className="relative z-10 flex flex-col h-full">
                    <div className="flex justify-between items-start mb-4">
                      <h3 className={`text-3xl font-black uppercase tracking-tighter leading-none ${styles.text}`}>
                        {offer.name}
                      </h3>
                      <Crown className={`${styles.text} shrink-0`} size={24} />
                    </div>

                    {img ? (
                      <div className="mb-4 rounded-xl overflow-hidden border border-white/10 max-h-36">
                        <img src={img} alt="" className="w-full h-36 object-cover" loading="lazy" aria-hidden />
                      </div>
                    ) : null}

                    <div className="text-sm text-slate-300 font-medium mb-6 leading-relaxed">
                      <RichDescription
                        isRaw
                        content={
                          offer.description?.trim()
                            ? offer.description
                            : 'Desbloqueie vantagens e conteúdos extras na sua operação.'
                        }
                      />
                    </div>

                    <div className="flex flex-col gap-1 mb-8">
                      {offer.originalPrice && Number(offer.originalPrice) > Number(offer.finalPrice) ? (
                        <div className="text-sm text-slate-500 line-through font-mono">
                          ${formatUsdcDisplay(offer.originalPrice)} USDC
                        </div>
                      ) : null}
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-5xl font-black text-white">${formatUsdcDisplay(offer.finalPrice)}</span>
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">
                          {offer.currency}
                        </span>
                        {offer.discountPercent != null && offer.discountPercent > 0 ? (
                          <span className="text-xs font-black text-green-400 bg-green-900/30 px-2 py-0.5 rounded-full">
                            -{offer.discountPercent.toFixed(1)}%
                          </span>
                        ) : null}
                      </div>
                      {offer.stockRemaining != null ? (
                        <div className="text-[10px] text-slate-500 font-mono">Stock: {offer.stockRemaining}</div>
                      ) : null}
                      {offer.unpurchasableReason ? (
                        <div className="text-[10px] text-amber-400/90">{offer.unpurchasableReason}</div>
                      ) : null}
                    </div>

                    <button
                      type="button"
                      onClick={() => requestPurchase(offer)}
                      disabled={anyBusy || !offer.isPurchasable}
                      className={`w-full py-4 rounded-2xl font-black text-xs tracking-[0.1em] uppercase transition-all duration-300 relative overflow-hidden group/btn disabled:grayscale disabled:opacity-50 mb-8
                          ${!offer.isPurchasable ? 'bg-slate-800 text-slate-500' : `bg-gradient-to-br ${styles.btn} text-white shadow-2xl hover:scale-[1.02] active:scale-95`}
                        `}
                    >
                      <span className="relative z-10">
                        {busy
                          ? 'A PROCESSAR…'
                          : !offer.isPurchasable
                            ? looksLikeInsufficientUsdcMessage(offer.unpurchasableReason || '')
                              ? 'SALDO INSUFICIENTE'
                              : 'INDISPONÍVEL'
                            : 'ADQUIRIR E UPGRADAR'}
                      </span>
                      {offer.isPurchasable && (
                        <div className="absolute inset-0 bg-white/20 translate-y-full group-hover/btn:translate-y-0 transition-transform duration-300" />
                      )}
                    </button>

                    <div className="flex-1 space-y-4 overflow-hidden">
                      {offer.itemsPreview.length > 0 && (
                        <>
                          <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-2">
                            CONTEÚDO DO PACOTE
                          </div>
                          <div className="space-y-2">
                            {offer.itemsPreview.map((row, i) => (
                              <div
                                key={`${row.rewardType}-${row.catalogId}-${i}`}
                                className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-xl p-3 text-sm group-hover:bg-white/10 transition-colors"
                              >
                                <span className={`font-black ${styles.text.split(' ')[0]}`}>{row.quantity}x</span>
                                <span className="text-slate-200">{row.label}</span>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {confirmPackage ? (
        <div
          className="fixed inset-0 z-[155] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Confirmar compra"
          onClick={() => setConfirmPackage(null)}
        >
          <div
            className="relative w-full max-w-md rounded-2xl border border-amber-600/50 bg-slate-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 pr-8 text-base font-black uppercase tracking-wide text-white">Confirmar compra</h3>
            <p className="text-sm text-slate-300">
              Comprar <span className="font-bold text-white">{confirmPackage.name}</span> por{' '}
              <span className="font-mono font-bold text-amber-300">
                ${formatUsdcDisplay(confirmPackage.finalPrice)} USDC
              </span>
              ?
            </p>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              O valor será debitado do seu saldo. Uma caixa com o conteúdo do pacote será enviada para{' '}
              <span className="font-semibold text-slate-300">Caixas da Sorte</span> — abra-a para receber os itens no
              estoque.
            </p>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setConfirmPackage(null)}
                className="w-full rounded-xl border border-slate-600 bg-slate-800 py-2.5 text-xs font-black uppercase tracking-widest text-slate-200 transition hover:bg-slate-700 sm:w-auto sm:min-w-[140px]"
              >
                Cancelar
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
                Confirmar e pagar
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
          aria-label="Pacote adquirido"
          onClick={() => setPurchaseSuccess(null)}
        >
          <div
            className="relative w-full max-w-md rounded-2xl border border-emerald-600/60 bg-slate-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 inline-flex rounded-full bg-emerald-500/20 p-2 text-emerald-400">
              <Gift size={22} aria-hidden />
            </div>
            <h3 className="mb-2 text-base font-black uppercase tracking-wide text-white">Pacote adquirido!</h3>
            <p className="text-sm leading-relaxed text-slate-300">
              {purchaseSuccess.boxName ? (
                <>
                  Sua caixa <span className="font-bold text-emerald-300">{purchaseSuccess.boxName}</span> foi enviada
                  para <span className="font-bold text-amber-300">Caixas da Sorte</span>. Abra-a para receber os itens.
                </>
              ) : (
                <>Sua caixa foi enviada para Caixas da Sorte. Abra-a para receber os itens.</>
              )}
            </p>
            {purchaseSuccess.itemsPreview.length > 0 ? (
              <div className="mt-4 max-h-48 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <div className="mb-2 text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Conteúdo</div>
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
                  Ir para Caixas da Sorte
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setPurchaseSuccess(null)}
                className="w-full rounded-xl bg-slate-800 py-2.5 text-xs font-black uppercase tracking-widest text-white transition hover:bg-slate-700 sm:flex-1"
              >
                Continuar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
