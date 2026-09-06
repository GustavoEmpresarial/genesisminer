import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Combine,
  Cpu,
  History,
  Loader2,
  RefreshCw,
  Server,
  Sparkles,
  X,
  Zap
} from 'lucide-react';
import {
  getMergeConfig,
  getMergeHistory,
  getMergeInventory,
  postMergeExecute,
  type MergeHistoryEntry,
  type MergeHistorySummaryRow,
  type MergeInventoryItem
} from '../../../shared/api/merge';
import { useT } from '../../../shared/i18n';

type Tab = 'machine' | 'multiplier' | 'infrastructure';

const ALL_TABS: Array<{ key: Tab; labelKey: string; Icon: typeof Cpu }> = [
  { key: 'machine', labelKey: 'merge.tabGpus', Icon: Cpu },
  { key: 'multiplier', labelKey: 'merge.tabAiChips', Icon: Zap },
  { key: 'infrastructure', labelKey: 'merge.tabRigs', Icon: Server }
];

const RARITY_STYLE: Record<
  string,
  { text: string; border: string; glow: string; bg: string; badge: string }
> = {
  common: {
    text: 'text-slate-200',
    border: 'border-slate-500/50',
    glow: 'shadow-[0_0_18px_rgba(148,163,184,0.18)]',
    bg: 'from-slate-500/15 to-transparent',
    badge: 'bg-slate-500/20 text-slate-200 border-slate-400/40'
  },
  uncommon: {
    text: 'text-emerald-300',
    border: 'border-emerald-400/50',
    glow: 'shadow-[0_0_22px_rgba(52,211,153,0.25)]',
    bg: 'from-emerald-500/20 to-transparent',
    badge: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/40'
  },
  rare: {
    text: 'text-sky-300',
    border: 'border-sky-400/50',
    glow: 'shadow-[0_0_22px_rgba(56,189,248,0.28)]',
    bg: 'from-sky-500/20 to-transparent',
    badge: 'bg-sky-500/20 text-sky-200 border-sky-400/40'
  },
  epic: {
    text: 'text-fuchsia-300',
    border: 'border-fuchsia-400/50',
    glow: 'shadow-[0_0_24px_rgba(232,121,249,0.28)]',
    bg: 'from-fuchsia-500/20 to-transparent',
    badge: 'bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-400/40'
  },
  legendary: {
    text: 'text-amber-300',
    border: 'border-amber-400/55',
    glow: 'shadow-[0_0_26px_rgba(251,191,36,0.32)]',
    bg: 'from-amber-500/25 to-transparent',
    badge: 'bg-amber-500/20 text-amber-100 border-amber-400/45'
  },
  supreme: {
    text: 'text-rose-300',
    border: 'border-rose-400/55',
    glow: 'shadow-[0_0_28px_rgba(251,113,133,0.35)]',
    bg: 'from-rose-500/25 to-transparent',
    badge: 'bg-rose-500/20 text-rose-100 border-rose-400/45'
  }
};

export type MergePageProps = {
  usdcBalance: number;
  onUsdcChange?: (n: number) => void;
};

function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', { maximumFractionDigits: digits });
}

function rarityOf(r: string | null | undefined) {
  return RARITY_STYLE[String(r || 'common').toLowerCase()] || RARITY_STYLE.common;
}

function fmtWhen(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '—';
  }
}

export const MergePage: React.FC<MergePageProps> = ({ usdcBalance, onUsdcChange }) => {
  const t = useT();
  const [tab, setTab] = useState<Tab>('machine');
  const [enabledByType, setEnabledByType] = useState<Record<Tab, boolean>>({
    machine: true,
    multiplier: true,
    infrastructure: true
  });
  const [items, setItems] = useState<MergeInventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** Quantos merges (pares) executar de uma vez. */
  const [mergeCount, setMergeCount] = useState(1);
  /** idle → charge → merge → impact → reveal */
  const [forgePhase, setForgePhase] = useState<'idle' | 'charge' | 'merge' | 'impact' | 'reveal'>('idle');
  const [histSummary, setHistSummary] = useState<MergeHistorySummaryRow[]>([]);
  const [histRecent, setHistRecent] = useState<MergeHistoryEntry[]>([]);
  const [histTotal, setHistTotal] = useState(0);
  const [histFeeTotal, setHistFeeTotal] = useState(0);
  const [histLoading, setHistLoading] = useState(true);

  const refreshHistory = useCallback(async () => {
    setHistLoading(true);
    try {
      const res = await getMergeHistory(40);
      if (!res.ok) {
        setHistSummary([]);
        setHistRecent([]);
        setHistTotal(0);
        setHistFeeTotal(0);
        return;
      }
      setHistSummary(res.summary || []);
      setHistRecent(res.recent || []);
      setHistTotal(res.totalMerges || 0);
      setHistFeeTotal(res.feeTotalUsdc || 0);
    } catch {
      setHistSummary([]);
      setHistRecent([]);
      setHistTotal(0);
      setHistFeeTotal(0);
    } finally {
      setHistLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfg, inv] = await Promise.all([getMergeConfig(), getMergeInventory(), refreshHistory()]);
      if (cfg.ok && cfg.config) {
        const byType = cfg.config.enabledByType;
        setEnabledByType({
          machine: byType.machine !== false,
          multiplier: byType.multiplier !== false,
          infrastructure: byType.infrastructure !== false
        });
        setTab((prev) => {
          if (byType[prev] !== false) return prev;
          const first = (['machine', 'multiplier', 'infrastructure'] as const).find((k) => byType[k] !== false);
          return first || prev;
        });
      }
      if (!inv.ok) {
        setError(inv.error || t('merge.loadInventoryFailed'));
        setItems([]);
      } else {
        setItems(inv.items || []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('merge.networkError'));
    } finally {
      setLoading(false);
    }
  }, [refreshHistory, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleTabs = useMemo(() => ALL_TABS.filter((t) => enabledByType[t.key]), [enabledByType]);

  const filtered = useMemo(() => items.filter((i) => i.type === tab), [items, tab]);
  const selected = useMemo(
    () => filtered.find((i) => i.itemId === selectedId) ?? null,
    [filtered, selectedId]
  );

  useEffect(() => {
    if (selectedId && !filtered.some((i) => i.itemId === selectedId)) {
      setSelectedId(null);
    }
  }, [filtered, selectedId]);

  const maxMerges = useMemo(() => {
    if (!selected) return 0;
    if (typeof selected.maxMerges === 'number' && selected.maxMerges >= 0) {
      return Math.max(0, Math.floor(selected.maxMerges));
    }
    return Math.max(0, Math.floor((Number(selected.qty) || 0) / 2));
  }, [selected]);

  useEffect(() => {
    if (maxMerges <= 0) {
      setMergeCount(1);
      return;
    }
    setMergeCount((c) => Math.min(Math.max(1, c), maxMerges));
  }, [selectedId, maxMerges]);

  const openConfirm = () => {
    if (!selected || busy) return;
    if (!selected.canMerge) {
      setError(selected.blockReason || t('merge.cannotMerge'));
      return;
    }
    if (mergeCount < 1 || mergeCount > maxMerges) {
      setError(t('merge.chooseMergeCount', { max: maxMerges }));
      return;
    }
    setError(null);
    setConfirmOpen(true);
  };

  const runMerge = async () => {
    if (!selected || busy) return;
    if (!selected.canMerge) {
      setError(selected.blockReason || t('merge.cannotMerge'));
      setConfirmOpen(false);
      return;
    }
    const count = Math.min(maxMerges, Math.max(1, mergeCount));
    setBusy(true);
    setError(null);
    setOkMsg(null);
    setConfirmOpen(false);
    setForgePhase('charge');
    try {
      const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const apiPromise = postMergeExecute(selected.itemId, count);
      await wait(550);
      setForgePhase('merge');
      await wait(1200);
      setForgePhase('impact');
      const res = await apiPromise;
      if (!res.ok) {
        setError(res.error || t('merge.mergeFailed'));
        setForgePhase('idle');
        return;
      }
      await wait(350);
      setForgePhase('reveal');
      await wait(1100);
      if (typeof res.newUsdc === 'number') onUsdcChange?.(res.newUsdc);
      const done = res.count ?? count;
      setOkMsg(
        done > 1
          ? `Forge ×${done}: +${done}× ${res.result?.name || res.resultItemId} (${res.result?.resultRarity || ''}). Taxa total $${fmt(res.feeUsdc)}.`
          : `Forge completa: ${res.result?.name || res.resultItemId} (${res.result?.resultRarity || ''}). Taxa $${fmt(res.feeUsdc)}.`
      );
      await refresh();
    } finally {
      setBusy(false);
      setForgePhase('idle');
    }
  };

  const srcStyle = rarityOf(selected?.rarity);
  const dstStyle = rarityOf(selected?.resultRarity);
  const qty = selected ? Math.max(0, Math.floor(Number(selected.qty) || 0)) : 0;
  const slotAFilled = qty >= 1;
  const slotBFilled = qty >= 2;
  const feeUnit = selected?.feeUsdc ?? selected?.preview?.feeUsdc ?? 0;
  const feeTotal = Math.round(feeUnit * mergeCount * 100) / 100;
  const consumeQty = mergeCount * 2;
  const isMerging = forgePhase !== 'idle';
  const phaseLabel =
    forgePhase === 'charge'
      ? t('merge.loadingEnergy')
      : forgePhase === 'merge'
        ? t('merge.fusingBoards')
        : forgePhase === 'impact'
          ? t('merge.impact')
          : forgePhase === 'reveal'
            ? t('merge.mergeComplete')
            : '';

  return (
    <div className="mrg-root relative mx-auto w-full max-w-6xl animate-in fade-in px-3 pb-10 pt-4 duration-300 sm:px-4 sm:pt-5 lg:px-6 lg:pt-6">
      <style>{`
        .mrg-root {
          --mrg-amber: #f59e0b;
          --mrg-cyan: #2de2e6;
          --mrg-glow: rgba(245,158,11,.4);
        }
        .mrg-title {
          background: linear-gradient(90deg, #f59e0b, #fde68a, #2de2e6, #f59e0b);
          background-size: 300% auto;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          animation: mrgHue 8s linear infinite;
          letter-spacing: 0.06em;
        }
        @keyframes mrgHue { to { background-position: 300% center; } }
        @keyframes mrgPulse {
          0%, 100% { box-shadow: 0 0 12px rgba(245,158,11,.25); }
          50% { box-shadow: 0 0 28px rgba(245,158,11,.55); }
        }
        @keyframes mrgBob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        @keyframes mrgScan {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100%); }
        }
        @keyframes mrgFloat {
          0%, 100% { transform: translateY(0); opacity: .25; }
          50% { transform: translateY(-14px); opacity: 1; }
        }
        @keyframes mrgArrow {
          0%, 100% { transform: translateY(0); opacity: .7; }
          50% { transform: translateY(4px); opacity: 1; }
        }
        @keyframes mrgNeedPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(255,170,0,.0); border-color: rgba(255,170,0,.35); }
          50% { box-shadow: 0 0 16px rgba(255,170,0,.35); border-color: rgba(255,170,0,.75); }
        }
        @keyframes mrgChargePulse {
          0%, 100% { transform: scale(1); filter: brightness(1); box-shadow: 0 0 12px rgba(245,158,11,.25); }
          50% { transform: scale(1.06); filter: brightness(1.35); box-shadow: 0 0 32px rgba(45,226,230,.55), 0 0 48px rgba(245,158,11,.35); }
        }
        @keyframes mrgRingSpin {
          to { transform: translate(-50%, -50%) rotate(360deg); }
        }
        @keyframes mrgRingSpinRev {
          to { transform: translate(-50%, -50%) rotate(-360deg); }
        }
        @keyframes mrgBeamGrow {
          0% { transform: scaleX(0); opacity: 0; }
          30% { opacity: 1; }
          100% { transform: scaleX(1); opacity: .95; }
        }
        @keyframes mrgSlideInL {
          0% { transform: translateX(0) scale(1) rotate(0deg); opacity: 1; }
          40% { transform: translateX(18px) scale(1.08) rotate(-6deg); opacity: 1; }
          75% { transform: translateX(52px) scale(.85) rotate(-12deg); opacity: .9; }
          100% { transform: translateX(70px) scale(.35) rotate(-20deg); opacity: 0; filter: blur(2px); }
        }
        @keyframes mrgSlideInR {
          0% { transform: translateX(0) scale(1) rotate(0deg); opacity: 1; }
          40% { transform: translateX(-18px) scale(1.08) rotate(6deg); opacity: 1; }
          75% { transform: translateX(-52px) scale(.85) rotate(12deg); opacity: .9; }
          100% { transform: translateX(-70px) scale(.35) rotate(20deg); opacity: 0; filter: blur(2px); }
        }
        @keyframes mrgCoreBeat {
          0%, 100% { transform: scale(.7); opacity: .4; }
          50% { transform: scale(1.35); opacity: 1; }
        }
        @keyframes mrgShock {
          0% { transform: translate(-50%, -50%) scale(.2); opacity: .9; border-width: 3px; }
          100% { transform: translate(-50%, -50%) scale(2.8); opacity: 0; border-width: 1px; }
        }
        @keyframes mrgFlash {
          0% { opacity: 0; transform: scale(.3); }
          25% { opacity: 1; transform: scale(1.4); }
          100% { opacity: 0; transform: scale(2.4); }
        }
        @keyframes mrgWhiteFlash {
          0% { opacity: 0; }
          20% { opacity: .55; }
          100% { opacity: 0; }
        }
        @keyframes mrgReveal {
          0% { opacity: 0; transform: scale(.35) rotate(-14deg); filter: brightness(2.2) saturate(1.4); }
          45% { opacity: 1; transform: scale(1.18) rotate(4deg); filter: brightness(1.4); }
          70% { transform: scale(.96) rotate(-2deg); }
          100% { opacity: 1; transform: scale(1) rotate(0); filter: brightness(1) saturate(1); }
        }
        @keyframes mrgSpark {
          0% { transform: translate(0,0) scale(1); opacity: 1; }
          100% { transform: translate(var(--sx), var(--sy)) scale(0); opacity: 0; }
        }
        @keyframes mrgEmber {
          0% { transform: translateY(8px) scale(.6); opacity: 0; }
          20% { opacity: 1; }
          100% { transform: translateY(-56px) scale(0); opacity: 0; }
        }
        @keyframes mrgHex {
          0% { transform: translate(-50%, -50%) scale(.4) rotate(0deg); opacity: .8; }
          100% { transform: translate(-50%, -50%) scale(1.6) rotate(40deg); opacity: 0; }
        }
        @keyframes mrgLabelIn {
          0% { opacity: 0; letter-spacing: .4em; }
          100% { opacity: 1; letter-spacing: .25em; }
        }
        .mrg-scan::after {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(180deg, transparent 40%, rgba(45,226,230,.05) 50%, transparent 60%);
          animation: mrgScan 4.5s linear infinite;
          pointer-events: none;
          z-index: 1;
        }
        .mrg-orb {
          position: absolute;
          width: 5px;
          height: 5px;
          border-radius: 999px;
          background: #f59e0b;
          box-shadow: 0 0 12px #f59e0b;
          animation: mrgFloat 3s ease-in-out infinite;
          pointer-events: none;
        }
        .mrg-need { animation: mrgNeedPulse 1.2s ease-in-out infinite; }
        .mrg-charge-board { animation: mrgChargePulse .55s ease-in-out infinite; }
        .mrg-ring-a {
          position: absolute; left: 50%; top: 50%; width: 110px; height: 110px; margin: 0;
          border-radius: 999px; border: 2px dashed rgba(45,226,230,.55);
          animation: mrgRingSpin 2.2s linear infinite;
          pointer-events: none;
        }
        .mrg-ring-b {
          position: absolute; left: 50%; top: 50%; width: 150px; height: 150px; margin: 0;
          border-radius: 999px; border: 1px solid rgba(245,158,11,.35);
          border-top-color: transparent; border-bottom-color: transparent;
          animation: mrgRingSpinRev 1.6s linear infinite;
          pointer-events: none;
        }
        .mrg-beam {
          position: absolute; left: 18%; right: 18%; top: 50%; height: 3px; margin-top: -1.5px;
          background: linear-gradient(90deg, transparent, #2de2e6, #fde68a, #f59e0b, #2de2e6, transparent);
          box-shadow: 0 0 14px #2de2e6, 0 0 28px rgba(245,158,11,.6);
          transform-origin: center; animation: mrgBeamGrow .45s ease-out forwards;
          pointer-events: none; z-index: 2;
        }
        .mrg-board-l { animation: mrgSlideInL 1.15s cubic-bezier(.45,.05,.25,1) forwards; }
        .mrg-board-r { animation: mrgSlideInR 1.15s cubic-bezier(.45,.05,.25,1) forwards; }
        .mrg-core { animation: mrgCoreBeat .35s ease-in-out infinite; }
        .mrg-shock {
          position: absolute; left: 50%; top: 50%; width: 40px; height: 40px; border-radius: 999px;
          border: 3px solid rgba(253,224,71,.85); box-shadow: 0 0 24px rgba(45,226,230,.6);
          animation: mrgShock .55s ease-out forwards; pointer-events: none;
        }
        .mrg-flash { animation: mrgFlash .75s ease-out forwards; }
        .mrg-white { animation: mrgWhiteFlash .45s ease-out forwards; }
        .mrg-reveal { animation: mrgReveal .95s cubic-bezier(.2,.85,.2,1) forwards; }
        .mrg-spark { animation: mrgSpark .7s ease-out forwards; }
        .mrg-ember { animation: mrgEmber 1.1s ease-out infinite; }
        .mrg-hex {
          position: absolute; left: 50%; top: 50%; width: 72px; height: 72px;
          clip-path: polygon(25% 6%, 75% 6%, 100% 50%, 75% 94%, 25% 94%, 0% 50%);
          border: 1px solid rgba(45,226,230,.5); background: rgba(45,226,230,.08);
          animation: mrgHex .7s ease-out forwards; pointer-events: none;
        }
        .mrg-phase-label { animation: mrgLabelIn .35s ease-out both; }
      `}</style>

      {/* ambient glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-8 -top-10 h-48 bg-[radial-gradient(ellipse_at_top,rgba(245,158,11,0.14),transparent_65%)]"
      />

      <header className="relative mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="relative rounded-2xl border border-amber-400/40 bg-gradient-to-br from-amber-500/25 via-stone-900 to-cyan-500/10 p-3.5 shadow-[0_0_28px_rgba(245,158,11,0.25)]">
            <Combine size={24} className="text-amber-300" />
            <Sparkles size={12} className="absolute -right-1 -top-1 text-cyan-300" />
          </div>
          <div>
            <h1 className="mrg-title text-3xl font-black uppercase tracking-wide">{t('merge.title')}</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-400">
              {t('merge.subtitle')}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="rounded-2xl border border-amber-400/35 bg-gradient-to-br from-amber-500/10 to-cyan-500/5 px-4 py-2.5 shadow-[0_0_20px_rgba(245,158,11,0.12)]">
            <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-500">{t('merge.usdcBalance')}</div>
            <div className="text-lg font-black text-amber-300">${fmt(usdcBalance)}</div>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || busy}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-600/80 bg-slate-950/80 px-3.5 py-2.5 text-[11px] font-black uppercase tracking-wider text-slate-200 transition hover:border-amber-400/50 hover:shadow-[0_0_16px_rgba(245,158,11,0.2)] disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {t('merge.refresh')}
          </button>
        </div>
      </header>

      <div className="relative mb-5 flex flex-wrap gap-2">
        {visibleTabs.map(({ key, labelKey, Icon }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                setTab(key);
                setSelectedId(null);
              }}
              className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-[11px] font-black uppercase tracking-wider transition ${
                active
                  ? 'border-amber-400/70 bg-gradient-to-b from-amber-500/25 to-amber-500/5 text-amber-100 shadow-[0_0_18px_rgba(245,158,11,0.35)]'
                  : 'border-white/10 bg-black/30 text-slate-400 hover:border-white/25 hover:text-slate-200'
              }`}
            >
              <Icon size={14} />
              {t(labelKey)}
            </button>
          );
        })}
      </div>

      {!loading && visibleTabs.length === 0 && (
        <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
          Nenhum tipo de merge está ativo neste momento. Volta mais tarde.
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-xl border border-red-500/40 bg-red-950/50 px-3 py-2 text-sm text-red-200 shadow-[0_0_16px_rgba(239,68,68,0.15)]">
          {error}
        </div>
      )}
      {okMsg && (
        <div className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200 shadow-[0_0_16px_rgba(16,185,129,0.15)]">
          {okMsg}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
        {/* Inventory */}
        <section className="relative overflow-hidden rounded-2xl border border-cyan-400/15 bg-gradient-to-b from-[#0c1626]/95 to-[#080e1a]/98 p-5 shadow-[0_8px_32px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-cyan-400/10 blur-3xl"
          />
          <h2 className="relative mb-4 flex items-center gap-2 text-sm font-black uppercase tracking-wider text-slate-100">
            <span className="inline-block h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#2de2e6]" />
            Inventário mergeável
          </h2>

          {loading ? (
            <div className="flex items-center gap-2 py-14 text-sm text-slate-400">
              <Loader2 className="animate-spin" size={18} /> {t('merge.loading')}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-500">{t('merge.emptyType')}</p>
          ) : (
            <ul className="relative grid max-h-[480px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
              {filtered.map((item) => {
                const active = item.itemId === selectedId;
                const rs = rarityOf(item.rarity);
                return (
                  <li key={item.itemId}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(item.itemId)}
                      className={`group relative w-full overflow-hidden rounded-xl border p-3 text-left transition duration-150 ${
                        active
                          ? `border-amber-400/70 bg-amber-500/10 shadow-[0_0_0_1px_rgba(245,158,11,0.25)_inset,0_0_22px_rgba(245,158,11,0.2)]`
                          : `border-white/8 bg-black/35 hover:translate-x-0.5 hover:border-cyan-400/40 hover:shadow-[0_0_14px_rgba(45,226,230,0.12)]`
                      }`}
                    >
                      <div
                        aria-hidden
                        className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${rs.bg} opacity-70`}
                      />
                      <div className="relative flex items-center gap-3">
                        <div
                          className={`flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border bg-black/50 text-2xl ${rs.border} ${active ? rs.glow : ''}`}
                        >
                          {item.image ? (
                            <img src={item.image} alt="" className="h-full w-full object-contain p-1" />
                          ) : (
                            <span>{item.icon}</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-bold text-white">{item.name}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider ${rs.badge}`}
                            >
                              {item.rarity}
                            </span>
                            <span className="rounded-lg border border-amber-400/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-black text-amber-300">
                              ×{item.qty}
                            </span>
                          </div>
                          <div className="mt-1 text-[11px] text-slate-500">
                            {item.type === 'machine'
                              ? `${fmt(item.baseProduction, 4)} H/s`
                              : item.type === 'infrastructure'
                                ? `+${fmt((item.preview?.multiplier ?? item.multiplier ?? 0) * 100, 1)}% H/s`
                                : `+${fmt((item.multiplier || 0) * 100, 1)}%`}
                          </div>
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Forge */}
        <aside
          className={`mrg-scan relative overflow-hidden rounded-2xl border border-amber-400/25 bg-gradient-to-b from-[#14100a] via-[#0c1626] to-[#080e1a] p-5 shadow-[0_8px_40px_rgba(0,0,0,0.4),0_0_40px_rgba(245,158,11,0.08),inset_0_1px_0_rgba(255,255,255,0.04)] ${busy ? 'ring-1 ring-amber-400/40' : ''}`}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_50%_20%,rgba(245,158,11,0.12),transparent_60%),radial-gradient(ellipse_50%_40%_at_70%_80%,rgba(45,226,230,0.08),transparent_55%)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.04]"
            style={{
              backgroundImage:
                'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.9) 2px, rgba(255,255,255,0.9) 4px)'
            }}
          />

          {isMerging && (
            <>
              {[
                ['12%', '22%', '0s'],
                ['78%', '28%', '0.35s'],
                ['50%', '14%', '0.7s'],
                ['22%', '70%', '0.2s'],
                ['68%', '74%', '0.9s'],
                ['40%', '60%', '1.2s']
              ].map(([l, t, d], i) => (
                <span
                  key={i}
                  className="mrg-orb"
                  style={{ left: l, top: t, animationDelay: d, background: i % 2 ? '#2de2e6' : '#f59e0b' }}
                />
              ))}
            </>
          )}

          <h2 className="relative z-[2] mb-5 flex items-center gap-2 text-sm font-black uppercase tracking-wider text-amber-300">
            <Sparkles size={14} />
            Forge
            {qty > 0 && (
              <span className="ml-auto rounded-full border border-white/10 bg-black/40 px-2 py-0.5 text-[10px] font-bold normal-case tracking-normal text-slate-400">
                stock ×{qty}
              </span>
            )}
          </h2>

          {!selected ? (
            <div className="relative z-[2] flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/10 bg-black/25 px-4 py-10 text-center">
              <div className="rounded-full border border-amber-400/30 bg-amber-500/10 p-4 text-amber-300/80">
                <Combine size={28} />
              </div>
              <p className="text-sm text-slate-400">{t('merge.selectHint')}</p>
            </div>
          ) : (
            <div className="relative z-[2] space-y-4">
              {/* Forge stage — slots + merge animation */}
              <div
                className={`relative min-h-[200px] overflow-hidden rounded-xl border px-3 py-4 ${
                  isMerging
                    ? 'border-amber-400/50 bg-black/50 shadow-[inset_0_0_40px_rgba(245,158,11,0.12),0_0_30px_rgba(45,226,230,0.1)]'
                    : 'border-amber-400/20 bg-black/40'
                }`}
              >
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(245,158,11,0.12),transparent_65%)]"
                />
                {isMerging && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 opacity-30"
                    style={{
                      backgroundImage:
                        'radial-gradient(circle at 20% 40%, rgba(45,226,230,.15), transparent 35%), radial-gradient(circle at 80% 50%, rgba(245,158,11,.18), transparent 35%)'
                    }}
                  />
                )}

                {isMerging ? (
                  <div className="relative flex h-[168px] items-center justify-center">
                    {/* energy rings */}
                    {(forgePhase === 'charge' || forgePhase === 'merge') && (
                      <>
                        <div className="mrg-ring-a" />
                        <div className="mrg-ring-b" />
                      </>
                    )}

                    {/* beam between boards */}
                    {(forgePhase === 'merge' || forgePhase === 'impact') && <div className="mrg-beam" />}

                    {/* embers rising */}
                    {(forgePhase === 'merge' || forgePhase === 'impact' || forgePhase === 'reveal') &&
                      [18, 32, 48, 62, 75].map((left, i) => (
                        <span
                          key={`e-${i}`}
                          aria-hidden
                          className="mrg-ember absolute bottom-6 h-1.5 w-1.5 rounded-full bg-amber-300"
                          style={{
                            left: `${left}%`,
                            animationDelay: `${i * 0.12}s`,
                            boxShadow: '0 0 8px #f59e0b'
                          }}
                        />
                      ))}

                    {/* boards during charge + merge */}
                    {(forgePhase === 'charge' || forgePhase === 'merge') && (
                      <>
                        <div
                          className={`absolute left-[10%] flex h-[88px] w-[88px] items-center justify-center overflow-hidden rounded-xl border-2 bg-black/75 text-3xl ${srcStyle.border} ${srcStyle.glow} ${
                            forgePhase === 'charge' ? 'mrg-charge-board' : 'mrg-board-l'
                          }`}
                        >
                          {selected.image ? (
                            <img src={selected.image} alt="" className="h-full w-full object-contain p-1.5" />
                          ) : (
                            <span>{selected.icon}</span>
                          )}
                          <span
                            aria-hidden
                            className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-cyan-400/10 via-transparent to-amber-400/20"
                          />
                        </div>
                        <div
                          className={`absolute right-[10%] flex h-[88px] w-[88px] items-center justify-center overflow-hidden rounded-xl border-2 bg-black/75 text-3xl ${srcStyle.border} ${srcStyle.glow} ${
                            forgePhase === 'charge' ? 'mrg-charge-board' : 'mrg-board-r'
                          }`}
                          style={forgePhase === 'charge' ? { animationDelay: '0.18s' } : undefined}
                        >
                          {selected.image ? (
                            <img src={selected.image} alt="" className="h-full w-full object-contain p-1.5" />
                          ) : (
                            <span>{selected.icon}</span>
                          )}
                          <span
                            aria-hidden
                            className="pointer-events-none absolute inset-0 bg-gradient-to-tl from-amber-400/15 via-transparent to-cyan-400/15"
                          />
                        </div>
                        <div className="absolute inset-0 z-[3] flex items-center justify-center">
                          <div className="mrg-core h-4 w-4 rounded-full bg-gradient-to-br from-amber-200 to-cyan-300 shadow-[0_0_28px_#f59e0b,0_0_40px_#2de2e6]" />
                        </div>
                      </>
                    )}

                    {/* impact flash + shockwave */}
                    {(forgePhase === 'impact' || forgePhase === 'reveal') && (
                      <>
                        <div aria-hidden className="mrg-white absolute inset-0 bg-white/40" />
                        <div
                          aria-hidden
                          className="mrg-flash absolute h-36 w-36 rounded-full bg-[radial-gradient(circle,rgba(253,224,71,0.95),rgba(45,226,230,0.45)_38%,transparent_68%)]"
                        />
                        <div className="mrg-shock" />
                        <div className="mrg-shock" style={{ animationDelay: '80ms', borderColor: 'rgba(45,226,230,.7)' }} />
                        <div className="mrg-hex" />
                        {(
                          [
                            ['-56px', '-48px'],
                            ['56px', '-44px'],
                            ['-62px', '28px'],
                            ['62px', '32px'],
                            ['0px', '-64px'],
                            ['0px', '58px'],
                            ['-36px', '52px'],
                            ['36px', '-56px'],
                            ['-70px', '0px'],
                            ['70px', '4px'],
                            ['-24px', '-60px'],
                            ['28px', '60px']
                          ] as const
                        ).map(([sx, sy], i) => (
                          <span
                            key={i}
                            aria-hidden
                            className="mrg-spark absolute h-2 w-2 rounded-full"
                            style={
                              {
                                '--sx': sx,
                                '--sy': sy,
                                animationDelay: `${i * 28}ms`,
                                background: i % 3 === 0 ? '#2de2e6' : i % 3 === 1 ? '#fde68a' : '#f59e0b',
                                boxShadow: '0 0 10px currentColor'
                              } as React.CSSProperties
                            }
                          />
                        ))}
                      </>
                    )}

                    {/* result reveal */}
                    {forgePhase === 'reveal' && (
                      <div
                        className={`mrg-reveal relative z-[4] flex h-28 w-28 items-center justify-center overflow-hidden rounded-2xl border-2 bg-black/85 text-4xl ${dstStyle.border} ${dstStyle.glow}`}
                      >
                        {selected.image ? (
                          <img src={selected.image} alt="" className="h-full w-full object-contain p-2" />
                        ) : (
                          <span>{selected.icon}</span>
                        )}
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-b from-white/15 to-transparent"
                        />
                      </div>
                    )}

                    <p className="mrg-phase-label absolute bottom-0 left-0 right-0 text-center text-[10px] font-black uppercase tracking-[0.25em] text-amber-300/95">
                      {phaseLabel}
                    </p>
                  </div>
                ) : (
                  <div className="relative flex items-stretch justify-center gap-2 sm:gap-4">
                    {([0, 1] as const).map((i) => {
                      const filled = i === 0 ? slotAFilled : slotBFilled;
                      return (
                        <div
                          key={i}
                          className={`flex w-[46%] max-w-[150px] flex-col items-center rounded-xl border-2 p-3 text-center transition ${
                            filled
                              ? `bg-black/55 ${srcStyle.border} ${srcStyle.glow}`
                              : 'mrg-need border-dashed border-amber-400/40 bg-black/25'
                          }`}
                        >
                          <div className="mb-1 text-[8px] font-bold uppercase tracking-[0.15em] text-cyan-300/70">
                            Unidade {i === 0 ? 'A' : 'B'}
                          </div>
                          <div
                            className={`mb-2 flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg border text-2xl ${
                              filled ? `bg-black/60 ${srcStyle.border}` : 'border-white/10 bg-black/30 text-slate-600'
                            }`}
                          >
                            {filled ? (
                              selected.image ? (
                                <img src={selected.image} alt="" className="h-full w-full object-contain p-1" />
                              ) : (
                                <span>{selected.icon}</span>
                              )
                            ) : (
                              <span className="text-xs font-bold text-amber-400/70">?</span>
                            )}
                          </div>
                          {filled ? (
                            <>
                              <div className="w-full truncate text-[11px] font-bold text-slate-100">{selected.name}</div>
                              <span
                                className={`mt-1 rounded border px-1.5 py-0.5 text-[8px] font-black uppercase ${srcStyle.badge}`}
                              >
                                {selected.rarity}
                              </span>
                            </>
                          ) : (
                            <p className="text-[10px] leading-snug text-amber-300/80">
                              Falta 1 unidade
                              <br />
                              no stock
                            </p>
                          )}
                        </div>
                      );
                    })}
                    {slotAFilled && slotBFilled && (
                      <div
                        aria-hidden
                        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-amber-400/30"
                      >
                        <Combine size={36} />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {!isMerging && (
                <div
                  className="flex justify-center text-amber-400"
                  style={{ animation: 'mrgArrow 1s ease-in-out infinite' }}
                  aria-hidden
                >
                  <ArrowRight size={22} className="rotate-90" />
                </div>
              )}

              {/* result preview */}
              <div
                className={`rounded-xl border-2 bg-gradient-to-b from-amber-500/15 to-black/40 p-4 ${dstStyle.border} ${
                  !selected.canMerge ? 'opacity-50' : ''
                }`}
                style={{
                  animation:
                    selected.canMerge && !isMerging
                      ? 'mrgPulse 1.6s ease-in-out infinite, mrgBob 2.4s ease-in-out infinite'
                      : undefined
                }}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-[72px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-black/60 text-3xl ${dstStyle.border} ${dstStyle.glow}`}
                  >
                    {selected.image ? (
                      <img src={selected.image} alt="" className="h-full w-full object-contain p-1.5" />
                    ) : (
                      <span>{selected.icon}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-amber-400/80">
                      Resultado · +{fmt(selected.preview?.gainPercent, 1)}% stats
                    </div>
                    <div className="mt-0.5 truncate text-base font-black text-white">
                      {selected.preview?.name || '—'}
                    </div>
                    <span
                      className={`mt-1 inline-block rounded border px-2 py-0.5 text-[10px] font-black uppercase ${dstStyle.badge}`}
                    >
                      {selected.resultRarity || '—'}
                    </span>
                    {selected.type === 'machine' ? (
                      <p className="mt-2 text-xs text-slate-300">
                        <span className="font-bold text-cyan-300">{fmt(selected.preview?.baseProduction, 4)} H/s</span>
                        <span className="mx-1.5 text-slate-600">·</span>
                        <span>{fmt(selected.preview?.powerConsumption)} W</span>
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-slate-300">
                        <span className="font-bold text-cyan-300">
                          +{fmt((selected.preview?.multiplier || 0) * 100, 1)}%
                          {selected.type === 'infrastructure' ? ' H/s (rig)' : ' boost'}
                        </span>
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/5 pt-3">
                  <span className="text-[11px] text-slate-500">
                    Taxa {mergeCount > 1 ? `total (${mergeCount}×)` : 'da forge'}
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/35 bg-amber-500/15 px-3 py-1 text-xs font-black text-amber-200">
                    ${fmt(feeTotal)} USDC
                    <span className="text-[10px] font-bold text-amber-400/70">
                      {mergeCount > 1
                        ? `${mergeCount}× $${fmt(feeUnit)}`
                        : `(${selected.preview?.costPct ?? '—'}%)`}
                    </span>
                  </span>
                </div>
              </div>

              {maxMerges >= 1 && (
                <div className="rounded-xl border border-cyan-400/20 bg-black/35 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-[10px] font-black uppercase tracking-wider text-cyan-300/90">
                      Quantidade de merges
                    </span>
                    <span className="text-[10px] text-slate-500">
                      máx. {maxMerges} · consome {consumeQty} unidades
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy || mergeCount <= 1}
                      onClick={() => setMergeCount((c) => Math.max(1, c - 1))}
                      className="h-9 w-9 shrink-0 rounded-lg border border-white/15 bg-slate-900 text-sm font-black text-white hover:border-amber-400/50 disabled:opacity-40"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={maxMerges}
                      value={mergeCount}
                      disabled={busy}
                      onChange={(e) => {
                        const n = Math.floor(Number(e.target.value) || 1);
                        setMergeCount(Math.min(maxMerges, Math.max(1, n)));
                      }}
                      className="w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-center text-sm font-black text-amber-200 outline-none focus:border-amber-400/50"
                    />
                    <button
                      type="button"
                      disabled={busy || mergeCount >= maxMerges}
                      onClick={() => setMergeCount((c) => Math.min(maxMerges, c + 1))}
                      className="h-9 w-9 shrink-0 rounded-lg border border-white/15 bg-slate-900 text-sm font-black text-white hover:border-amber-400/50 disabled:opacity-40"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      disabled={busy || maxMerges <= 1}
                      onClick={() => setMergeCount(maxMerges)}
                      className="shrink-0 rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-2 text-[10px] font-black uppercase tracking-wider text-amber-200 hover:bg-amber-500/25 disabled:opacity-40"
                    >
                      Máx
                    </button>
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">
                    Com ×{qty} no stock fazes até <span className="font-bold text-slate-300">{maxMerges}</span>{' '}
                    merge(s) (2 placas por merge). Resultado: +{mergeCount} item(ns).
                  </p>
                </div>
              )}

              {!selected.canMerge && selected.blockReason && (
                <p className="rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-xs text-red-300">
                  {selected.blockReason}
                </p>
              )}

              <button
                type="button"
                disabled={!selected.canMerge || busy || maxMerges < 1}
                onClick={openConfirm}
                className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl border border-amber-400/60 bg-gradient-to-b from-amber-400/35 via-amber-500/20 to-amber-700/25 py-3.5 text-xs font-black uppercase tracking-[0.2em] text-amber-50 transition hover:-translate-y-0.5 hover:shadow-[0_0_28px_rgba(245,158,11,0.45)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 disabled:hover:shadow-none"
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-[linear-gradient(110deg,transparent_30%,rgba(255,255,255,0.12)_50%,transparent_70%)] opacity-0 transition group-hover:opacity-100"
                />
                {busy ? <Loader2 className="animate-spin" size={16} /> : <Combine size={16} />}
                {busy ? t('merge.forging') : mergeCount > 1 ? `${t('merge.mergeAction')} ×${mergeCount}` : t('merge.mergeAction')}
              </button>
            </div>
          )}
        </aside>
      </div>

      {/* Histórico */}
      <section className="relative mt-5 overflow-hidden rounded-2xl border border-fuchsia-400/15 bg-gradient-to-b from-[#16101f]/95 to-[#080e1a]/98 p-5 shadow-[0_8px_32px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div
          aria-hidden
          className="pointer-events-none absolute -left-10 top-0 h-40 w-40 rounded-full bg-fuchsia-400/10 blur-3xl"
        />
        <div className="relative mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-slate-100">
              <History size={16} className="text-fuchsia-300" />
              Histórico de merges
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Quantos merges fizeste por placa e raridade de origem.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            <div className="rounded-lg border border-white/10 bg-black/35 px-3 py-1.5">
              <span className="text-slate-500">{t('merge.total')}</span>{' '}
              <span className="font-black text-fuchsia-200">{histTotal}</span>
            </div>
            <div className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-1.5">
              <span className="text-slate-500">{t('merge.fees')}</span>{' '}
              <span className="font-black text-amber-300">${fmt(histFeeTotal)}</span>
            </div>
          </div>
        </div>

        {histLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-slate-400">
            <Loader2 className="animate-spin" size={16} /> {t('merge.loadingHistory')}
          </div>
        ) : histSummary.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">{t('merge.noHistory')}</p>
        ) : (
          <div className="relative grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <h3 className="mb-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                Por placa / raridade
              </h3>
              <ul className="grid max-h-[320px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                {histSummary.map((row) => {
                  const src = rarityOf(row.sourceRarity);
                  const dst = rarityOf(row.resultRarity);
                  return (
                    <li
                      key={`${row.sourceItemId}|${row.sourceRarity}|${row.resultItemId}|${row.resultRarity}`}
                      className={`relative overflow-hidden rounded-xl border bg-black/40 p-3 ${src.border}`}
                    >
                      <div
                        aria-hidden
                        className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${src.bg} opacity-60`}
                      />
                      <div className="relative flex items-start gap-3">
                        <div
                          className={`flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-black/50 text-xl ${src.border}`}
                        >
                          {row.image ? (
                            <img src={row.image} alt="" className="h-full w-full object-contain p-1" />
                          ) : (
                            <span>{row.icon}</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-bold text-white">{row.sourceName}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[8px] font-black uppercase ${src.badge}`}
                            >
                              {row.sourceRarity}
                            </span>
                            <ArrowRight size={10} className="text-slate-500" />
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[8px] font-black uppercase ${dst.badge}`}
                            >
                              {row.resultRarity}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px]">
                            <span>
                              <span className="font-black text-fuchsia-200">{row.mergeCount}</span>
                              <span className="text-slate-500"> merge{row.mergeCount === 1 ? '' : 's'}</span>
                            </span>
                            <span className="text-amber-300/90">${fmt(row.feeTotalUsdc)}</span>
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-600">
                            Último: {fmtWhen(row.lastAt)}
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div>
              <h3 className="mb-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                Recentes
              </h3>
              <ul className="max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
                {histRecent.map((row) => {
                  const src = rarityOf(row.sourceRarity);
                  const dst = rarityOf(row.resultRarity);
                  return (
                    <li
                      key={row.id}
                      className="flex items-center gap-2 rounded-lg border border-white/8 bg-black/35 px-2.5 py-2"
                    >
                      <div
                        className={`flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-black/50 text-sm ${src.border}`}
                      >
                        {row.image ? (
                          <img src={row.image} alt="" className="h-full w-full object-contain p-0.5" />
                        ) : (
                          <span>{row.icon}</span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-semibold text-slate-100">
                          {row.sourceName}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[9px]">
                          <span className={`rounded border px-1 py-0.5 font-black uppercase ${src.badge}`}>
                            {row.sourceRarity}
                          </span>
                          <ArrowRight size={9} className="text-slate-600" />
                          <span className={`rounded border px-1 py-0.5 font-black uppercase ${dst.badge}`}>
                            {row.resultRarity}
                          </span>
                          <span className="text-slate-600">·</span>
                          <span className="text-amber-300/80">${fmt(row.feeUsdc)}</span>
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-[9px] leading-tight text-slate-500">
                        {fmtWhen(row.createdAt)}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
      </section>

      {confirmOpen && selected && (
        <div
          className="fixed inset-0 z-[160] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200"
          role="dialog"
          aria-modal="true"
          aria-label={t('merge.confirmTitle')}
          onClick={() => {
            if (!busy) setConfirmOpen(false);
          }}
        >
          <div
            className="relative w-full max-w-md overflow-hidden rounded-2xl border border-amber-400/50 bg-gradient-to-b from-[#16120c] via-[#0c1626] to-[#080e1a] p-6 shadow-[0_0_48px_rgba(245,158,11,0.28),0_20px_60px_rgba(0,0,0,0.55)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-amber-400/15 blur-3xl"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -bottom-10 -left-10 h-36 w-36 rounded-full bg-cyan-400/10 blur-3xl"
            />

            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmOpen(false)}
              className="absolute right-3 top-3 rounded-lg border border-white/10 bg-black/30 p-1.5 text-slate-400 transition hover:border-white/25 hover:text-white disabled:opacity-40"
              aria-label={t('merge.close')}
            >
              <X size={14} />
            </button>

            <div className="relative mb-4 flex items-center gap-3">
              <div className="rounded-xl border border-amber-400/40 bg-amber-500/15 p-2.5 text-amber-300 shadow-[0_0_18px_rgba(245,158,11,0.25)]">
                <Combine size={20} />
              </div>
              <div>
                <h3 className="text-base font-black uppercase tracking-wide text-white">{t('merge.confirmForge')}</h3>
                <p className="text-[11px] text-slate-400">
                  {mergeCount > 1
                    ? `${mergeCount} merges · consome ${consumeQty} unidades`
                    : t('merge.confirmBody')}
                </p>
              </div>
            </div>

            <div className="relative space-y-3">
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/35 p-3">
                <div
                  className={`flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-black/50 text-2xl ${srcStyle.border}`}
                >
                  {selected.image ? (
                    <img src={selected.image} alt="" className="h-full w-full object-contain p-1" />
                  ) : (
                    <span>{selected.icon}</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-white">
                    Mergear {consumeQty}× <span className="text-amber-200">{selected.name}</span>
                    {mergeCount > 1 && (
                      <span className="ml-1 text-xs font-bold text-cyan-300">({mergeCount} pares)</span>
                    )}
                  </p>
                  <span
                    className={`mt-1 inline-block rounded border px-1.5 py-0.5 text-[9px] font-black uppercase ${srcStyle.badge}`}
                  >
                    {selected.rarity}
                  </span>
                </div>
              </div>

              <div className="flex justify-center text-amber-400/80" aria-hidden>
                <ArrowRight size={18} className="rotate-90" />
              </div>

              <div className={`rounded-xl border bg-gradient-to-b from-amber-500/10 to-black/30 p-3 ${dstStyle.border}`}>
                <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-amber-400/80">
                  Resultado {mergeCount > 1 ? `×${mergeCount}` : ''}
                </div>
                <div className="mt-0.5 truncate text-sm font-black text-white">
                  {mergeCount > 1 ? `${mergeCount}× ` : ''}
                  {selected.preview?.name || '—'}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[9px] font-black uppercase ${dstStyle.badge}`}
                  >
                    {selected.resultRarity || '—'}
                  </span>
                  <span className="text-[11px] font-bold text-cyan-300">
                    +{fmt(selected.preview?.gainPercent, 1)}% stats
                  </span>
                </div>
                {selected.type === 'machine' ? (
                  <p className="mt-2 text-[11px] text-slate-400">
                    {fmt(selected.preview?.baseProduction, 4)} H/s · {fmt(selected.preview?.powerConsumption)} W
                  </p>
                ) : (
                  <p className="mt-2 text-[11px] text-slate-400">
                    +{fmt((selected.preview?.multiplier || 0) * 100, 1)}%
                    {selected.type === 'infrastructure' ? ' H/s (rig)' : ' boost'}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2.5">
                <span className="text-[11px] uppercase tracking-wider text-slate-400">
                  Taxa {mergeCount > 1 ? 'total' : ''}
                </span>
                <span className="text-sm font-black text-amber-200">
                  ${fmt(feeTotal)} USDC
                  <span className="ml-1.5 text-[10px] font-bold text-amber-400/70">
                    {mergeCount > 1 ? `${mergeCount}× $${fmt(feeUnit)}` : `(${selected.preview?.costPct ?? '—'}%)`}
                  </span>
                </span>
              </div>
            </div>

            <div className="relative mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmOpen(false)}
                className="w-full rounded-xl border border-slate-600 bg-slate-900/80 py-2.5 text-xs font-black uppercase tracking-widest text-slate-200 transition hover:bg-slate-800 disabled:opacity-50 sm:w-auto sm:min-w-[120px]"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runMerge()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-amber-400/60 bg-gradient-to-b from-amber-400/40 to-amber-600/30 py-2.5 text-xs font-black uppercase tracking-widest text-amber-50 shadow-[0_0_20px_rgba(245,158,11,0.3)] transition hover:shadow-[0_0_28px_rgba(245,158,11,0.45)] disabled:opacity-50 sm:w-auto sm:min-w-[160px]"
              >
                {busy ? <Loader2 className="animate-spin" size={14} /> : <Combine size={14} />}
                {busy ? t('merge.forging') : mergeCount > 1 ? `${t('merge.confirm')} ×${mergeCount}` : t('merge.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
