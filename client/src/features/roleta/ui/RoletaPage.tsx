import { useState, useCallback, useEffect } from 'react';
import { Sparkles, Ticket, DollarSign, Loader2, Wallet, Gift } from 'lucide-react';
import type { Upgrade } from '../../servers/types';
import GameView from './GameView';
import {
  getPendingRoletaCode,
  getWheelState,
  postWheelRedeemCode,
  newWheelIdempotencyKey
} from '../../../shared/api/wheel';
import { UiNoticeModal, type UiNotice } from '../../../shared/ui/UiNoticeModal';
import { ROLETA_PREFILL_CODE_SS } from '../../../shared/constants/roletaPrefill';
import { useT } from '../../../shared/i18n';

export type RoletaPageProps = {
  upgrades?: Upgrade[];
  onRedeemSuccess?: (unopenedBoxes: Record<string, number>) => void;
  /** Resgate iniciado em Caixas: o App injeta o código uma vez. */
  bootstrap?: { v: number; code: string } | null;
  onBootstrapConsumed?: () => void;
  /** Saldo USDC (`game_states`) para a roleta paga. */
  usdcBalance: number;
  /** Atualizar saldo/caixas após giro ou resgate pago. */
  onReloadGameState?: () => void | Promise<void>;
  /** Empurrar USDC para o chrome (navbar) ao montar / após state. */
  onUsdcChange?: (usdc: number) => void;
  /** Navegar para «Caixas da Sorte» — botão no modal de resultado da roleta paga. */
  onGoToLuckyBoxes?: () => void;
};

/**
 * Único ecrã público da roleta: resgate + giro + reclamar prémio.
 * Layout aligned with legacy RoletaPage · DECISIONS #101.
 */
type RoletaTab = 'code' | 'paid';

export function RoletaPage({
  upgrades = [],
  onRedeemSuccess,
  bootstrap,
  onBootstrapConsumed,
  usdcBalance,
  onReloadGameState,
  onUsdcChange,
  onGoToLuckyBoxes
}: RoletaPageProps) {
  const t = useT();
  const [tab, setTab] = useState<RoletaTab>('code');
  const [promoCode, setPromoCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [roletaCode, setRoletaCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<UiNotice | null>(null);
  const [paidTabSpinLabel, setPaidTabSpinLabel] = useState('Giro US$1.00');
  /** `null` = ainda não carregou estado do servidor; `false` = roleta paga desligada no admin. */
  const [paidWheelEnabled, setPaidWheelEnabled] = useState<boolean | null>(null);

  /** Preço do giro pago + seed USDC no chrome (não depender de MiningPage). */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await getWheelState();
      if (cancelled || !s.ok) return;
      setPaidTabSpinLabel(`Giro US$${s.data.spinPriceUsdc.toFixed(2)}`);
      setPaidWheelEnabled(s.data.paidWheelEnabled);
      onUsdcChange?.(s.data.usdcBalance);
    })();
    return () => {
      cancelled = true;
    };
  }, [onUsdcChange]);

  useEffect(() => {
    if (paidWheelEnabled === false && tab === 'paid') setTab('code');
  }, [paidWheelEnabled, tab]);

  /** Código pendente no servidor (resgatou mas ainda não concluiu o fluxo). */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const code = await getPendingRoletaCode();
        if (cancelled || !code) return;
        setRoletaCode((prev) => (prev && prev.length > 0 ? prev : code));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!bootstrap?.code) return;
    const t = String(bootstrap.code).trim();
    if (!t) {
      onBootstrapConsumed?.();
      return;
    }
    setRoletaCode(t);
    setTab('code');
    onBootstrapConsumed?.();
  }, [bootstrap?.v, bootstrap?.code, onBootstrapConsumed]);

  /** Prefill from Caixas da Sorte promo redeem (sessionStorage). */
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(ROLETA_PREFILL_CODE_SS);
      if (!raw) return;
      sessionStorage.removeItem(ROLETA_PREFILL_CODE_SS);
      const c = raw.trim();
      if (!c) return;
      setPromoCode(c);
      setRoletaCode(c);
      setTab('code');
    } catch {
      /* ignore */
    }
  }, []);

  const handleRedeem = useCallback(async () => {
    if (!promoCode.trim()) return;
    setRedeeming(true);
    try {
      const idem = newWheelIdempotencyKey();
      const wrapped = await postWheelRedeemCode(promoCode.trim(), idem);
      if (!wrapped.ok) {
        const st = wrapped.status;
        if (st === 409 || st === 422) {
          const s = await getWheelState();
          if (s.ok) {
            setPaidTabSpinLabel(`Giro US$${s.data.spinPriceUsdc.toFixed(2)}`);
            setPaidWheelEnabled(s.data.paidWheelEnabled);
          }
        }
        setNotice({ variant: 'error', message: wrapped.error || t('wheel.redeemCodeError') });
        return;
      }
      const data = wrapped.data as Record<string, unknown>;
      if (data.type === 'roleta') {
        const c = typeof data.code === 'string' ? data.code.trim() : '';
        setRoletaCode(c || null);
        setPromoCode('');
      } else {
        setNotice({
          variant: 'info',
          title: t('wheel.boxCode'),
          message:
            'Este código não é da roleta. Resgate-o em Caixas da Sorte — o campo «Código promocional» está no topo dessa página.'
        });
        setPromoCode('');
        const ub = data.unopenedBoxes as Record<string, number> | undefined;
        if (onRedeemSuccess && ub) {
          onRedeemSuccess(ub);
        } else if (onRedeemSuccess) {
          onRedeemSuccess({});
        }
      }
    } catch {
      setNotice({ variant: 'error', message: t('wheel.serverCommFailed') });
    } finally {
      setRedeeming(false);
    }
  }, [promoCode, onRedeemSuccess, t]);

  const clearRoletaSession = useCallback(() => {
    setRoletaCode(null);
  }, []);

  const usdcShort = usdcBalance < 0.01 && usdcBalance > 0
    ? usdcBalance.toFixed(3)
    : usdcBalance.toLocaleString('en-US', { maximumFractionDigits: 2 });

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* Halos decorativos dark/cyber — sem pointer-events para nunca bloquear interação. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -top-24 left-1/4 h-64 w-64 rounded-full bg-orange-500/12 blur-3xl" />
        <div className="absolute top-40 right-0 h-72 w-72 rounded-full bg-amber-600/8 blur-3xl" />
        <div className="absolute bottom-10 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full bg-emerald-600/8 blur-3xl" />
      </div>

      {/* Container fluido: padding mínimo, sem footer/banners abaixo (removidos no App). */}
      <div className="relative z-10 mx-auto flex w-full min-w-0 max-w-5xl flex-1 flex-col gap-3 px-3 pb-6 pt-3 sm:gap-4 sm:px-6 sm:pb-8 sm:pt-5">
        {/* Header compacto numa linha só (com pílulas saldo/preço inline). */}
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-amber-600 text-white shadow-md shadow-orange-600/30 sm:h-11 sm:w-11">
              <Sparkles className="h-5 w-5 sm:h-5.5 sm:w-5.5" strokeWidth={2.2} aria-hidden />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-black leading-tight tracking-tight text-slate-900 dark:text-white sm:text-2xl">
                {t('wheel.title')}
              </h1>
              <p className="text-[11px] leading-tight text-slate-500 dark:text-slate-400 sm:text-xs">
                {t('wheel.subtitle')}
              </p>
            </div>
          </div>
          {/* Pílulas inline e discretas — não competem visualmente com a roleta. */}
          <div className="flex shrink-0 items-center gap-1.5">
            <div className="flex items-center gap-1.5 rounded-full border border-emerald-600/40 bg-emerald-950/40 px-2.5 py-1 shadow-inner">
              <Wallet className="h-3 w-3 text-emerald-400" aria-hidden />
              <span className="font-mono text-xs font-bold tabular-nums text-emerald-100">${usdcShort}</span>
            </div>
            {paidWheelEnabled !== false ? (
              <div className="flex items-center gap-1.5 rounded-full border border-orange-500/40 bg-orange-950/40 px-2.5 py-1 shadow-inner">
                <Gift className="h-3 w-3 text-orange-400" aria-hidden />
                <span className="font-mono text-xs font-bold tabular-nums text-orange-100">
                  {paidTabSpinLabel.replace('Giro ', '')}
                </span>
              </div>
            ) : null}
          </div>
        </header>

        {/* Tabs pill — o separador «giro pago» só aparece se a roleta paga estiver ativa no servidor. */}
        <div
          className={`flex gap-1 rounded-full border border-slate-700/70 bg-slate-900/50 p-1 backdrop-blur-sm ${
            paidWheelEnabled === false ? 'sm:max-w-[11rem]' : 'sm:max-w-sm'
          }`}
          role="tablist"
          aria-label={t('wheel.mode')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'code'}
            onClick={() => setTab('code')}
            className={`flex min-h-[36px] items-center justify-center gap-1.5 rounded-full px-3 text-[11px] font-bold uppercase tracking-wide transition-all duration-200 sm:text-xs ${
              paidWheelEnabled === false ? 'w-full flex-1' : 'flex-1'
            } ${
              tab === 'code'
                ? 'bg-gradient-to-r from-orange-600 to-amber-600 text-white shadow-md shadow-orange-900/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Ticket className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('wheel.byCode')}
          </button>
          {paidWheelEnabled !== false ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'paid'}
              onClick={() => setTab('paid')}
              className={`flex min-h-[36px] flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[11px] font-bold uppercase tracking-wide transition-all duration-200 sm:text-xs ${
                tab === 'paid'
                  ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-md shadow-emerald-900/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <DollarSign className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {paidTabSpinLabel}
            </button>
          ) : null}
        </div>

        {tab === 'code' ? (
          <section
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-orange-500/25 bg-gradient-to-b from-slate-900/95 via-slate-950 to-black shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
            aria-label={t('wheel.codeWheelTitle')}
          >
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(251,146,60,0.10),transparent_60%)]" aria-hidden />

            {/* Faixa de input só aparece quando ainda não há código — evita poluição visual durante o giro. */}
            {!roletaCode ? (
              <div className="relative z-10 border-b border-orange-500/15 px-3 py-3 sm:px-5 sm:py-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-2.5">
                  <input
                    type="text"
                    value={promoCode}
                    onChange={(e) => setPromoCode(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !redeeming && handleRedeem()}
                    placeholder={t('wheel.pastePromo')}
                    autoComplete="off"
                    spellCheck={false}
                    className="min-h-[42px] flex-1 rounded-xl border border-slate-700 bg-slate-950/80 px-3 font-mono text-sm uppercase tracking-wide text-slate-100 shadow-inner outline-none transition-all duration-200 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/25 sm:px-4"
                  />
                  <button
                    type="button"
                    onClick={handleRedeem}
                    disabled={redeeming || !promoCode.trim()}
                    className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-orange-600 to-amber-600 px-6 text-xs font-black uppercase tracking-widest text-white shadow-md shadow-orange-900/30 transition-all duration-200 hover:from-orange-500 hover:to-amber-500 hover:shadow-lg active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 sm:px-8 sm:text-sm"
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
            ) : (
              /* Quando há código activo: barra fina só com botão "Trocar código" — máx. foco na roda. */
              <div className="relative z-10 flex items-center justify-between border-b border-orange-500/15 px-3 py-2 sm:px-5">
                <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-orange-300/90">
                  <Ticket className="h-3.5 w-3.5" aria-hidden />
                  {t('wheel.activeCode')}
                </div>
                <button
                  type="button"
                  onClick={clearRoletaSession}
                  className="rounded-full border border-slate-600/80 bg-slate-800/70 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-300 transition-all duration-200 hover:border-slate-500 hover:bg-slate-700 hover:text-white"
                >
                  {t('wheel.changeCode')}
                </button>
              </div>
            )}

            <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-2 py-4 sm:px-5 sm:py-6">
              {roletaCode ? (
                <div className="flex w-full min-w-0 max-w-3xl flex-1 flex-col items-center justify-center">
                  <div className="w-full max-w-full">
                    <GameView
                      items={[]}
                      onBack={clearRoletaSession}
                      redeemCode={roletaCode}
                      upgrades={upgrades}
                      onRedeemComplete={() => {
                        setRoletaCode(null);
                        setPromoCode('');
                        onRedeemSuccess?.({});
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex max-w-md flex-col items-center gap-2.5 px-2 text-center sm:px-4">
                  <Sparkles className="h-10 w-10 text-orange-400/40" strokeWidth={1.5} aria-hidden />
                  <p className="text-sm font-semibold text-slate-400">
                    Cole um código de roleta acima — a roda aparece aqui depois do resgate.
                  </p>
                  <p className="text-xs text-slate-600">
                    Sorteio validado no servidor; um giro por código.
                  </p>
                </div>
              )}
            </div>
          </section>
        ) : (
          <section
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-emerald-600/30 bg-gradient-to-b from-slate-900/95 via-slate-950 to-black shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
            aria-label={t('wheel.paidWheel')}
          >
            <div
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(16,185,129,0.10),transparent_60%)]"
              aria-hidden
            />
            <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-2 py-4 sm:px-5 sm:py-6">
              <div className="flex w-full min-w-0 max-w-3xl flex-1 flex-col items-center justify-center">
                <div className="w-full max-w-full">
                  <GameView
                    items={[]}
                    onBack={() => setTab('code')}
                    paidSpin
                    usdcBalance={usdcBalance}
                    upgrades={upgrades}
                    onPaidBalanceRefresh={onReloadGameState}
                    onGoToLuckyBoxes={onGoToLuckyBoxes}
                    onRedeemComplete={() => {
                      void onReloadGameState?.();
                      onRedeemSuccess?.({});
                    }}
                  />
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Card informativo fixo — sempre visível abaixo da roleta para reforçar a regra de entrega. */}
        <div className="relative z-10 flex flex-col gap-2 rounded-2xl border border-orange-500/20 bg-slate-900/55 px-4 py-3 backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5 sm:py-3.5">
          <div className="min-w-0">
            <h3 className="text-xs font-black uppercase tracking-widest text-orange-300 sm:text-sm">
              Onde retiro meus prémios?
            </h3>
            <p className="mt-1 text-[11px] leading-snug text-slate-400 sm:text-xs">
              Os prémios da Roleta são enviados para{' '}
              <span className="font-semibold text-orange-300">Caixas da Sorte</span>. Abra suas caixas
              para receber os itens no Estoque.
            </p>
          </div>
          {onGoToLuckyBoxes ? (
            <button
              type="button"
              onClick={onGoToLuckyBoxes}
              className="inline-flex shrink-0 items-center justify-center gap-2 self-start rounded-xl bg-gradient-to-r from-orange-600 to-amber-600 px-4 py-2 text-[11px] font-black uppercase tracking-widest text-white shadow-md shadow-orange-900/30 transition hover:from-orange-500 hover:to-amber-500 sm:self-auto sm:text-xs"
            >
              <Gift className="h-3.5 w-3.5" aria-hidden />
              Ver Caixas da Sorte
            </button>
          ) : null}
        </div>
      </div>
      <UiNoticeModal notice={notice} onClose={() => setNotice(null)} />
    </div>
  );
}
