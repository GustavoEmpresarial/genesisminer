/**
 * Transparency hub — public ledger (DECISIONS #82-ish / GAME_SHELL).
 * Large orchestrator; prefer extracting filters/list in a later pass.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Scale,
  ExternalLink,
  Loader2,
  RefreshCw,
  DollarSign,
  TrendingUp,
  Activity,
  Wallet,
  Download,
  Search,
  Copy,
  Calendar,
  Layers
} from 'lucide-react';
import { useI18n, useT } from '../../../shared/i18n';
import {
  getTransparency,
  getTransparencyHealth,
  getWeb3Settings,
  formatTransparencyUsdc,
  type TransparencyEntry,
  type TransparencyCategory,
  type TransparencyHealthSnapshot
} from '../../../shared/api/transparency';
import { dateLocaleFor } from '../../../shared/utils/locale-format';
import { isSafeHttpsLink } from '../../../shared/utils/safe-https-link';
import { computeTransparencyHealth, normalizeHealthCategory } from '../lib/health';
import {
  collectPeriodYmOptions,
  currentPeriodYmUtc,
  filterEntriesByPeriodYm,
  formatPeriodYmLabel,
  sumTransparencySheet
} from '../lib/periodYm';
import { TransparencyHealthBoard } from './TransparencyHealthBoard';

const CATEGORY_ORDER: TransparencyCategory[] = ['pool', 'trade', 'investment', 'expense', 'other'];

function lsGet(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function lsSet(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* ignore quota / private mode */
  }
}

function lsRemove(...keys: string[]): void {
  try {
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

function entryTimeMs(entry: TransparencyEntry): number {
  const t = entry.createdAt;
  if (typeof t !== 'number' || !Number.isFinite(t)) return 0;
  return t < 1e12 ? t * 1000 : t;
}

function normalizeCategory(c: string): TransparencyCategory {
  return normalizeHealthCategory(c);
}

function catBorder(cat: TransparencyCategory): string {
  switch (cat) {
    case 'pool':
      return 'border-emerald-600/35 bg-emerald-950/20 dark:bg-emerald-950/20';
    case 'trade':
      return 'border-sky-600/35 bg-sky-950/20 dark:bg-sky-950/20';
    case 'investment':
      return 'border-violet-600/35 bg-violet-950/20 dark:bg-violet-950/20';
    case 'expense':
      return 'border-orange-600/35 bg-orange-950/20 dark:bg-orange-950/20';
    default:
      return 'border-slate-600/50 bg-slate-100/80 dark:bg-slate-900/60';
  }
}

function catAccent(cat: TransparencyCategory): string {
  switch (cat) {
    case 'pool':
      return 'text-emerald-600 dark:text-emerald-300';
    case 'trade':
      return 'text-sky-600 dark:text-sky-300';
    case 'investment':
      return 'text-violet-600 dark:text-violet-300';
    case 'expense':
      return 'text-orange-600 dark:text-orange-300';
    default:
      return 'text-slate-600 dark:text-slate-300';
  }
}

export function TransparencyPage() {
  const t = useT();
  const { locale } = useI18n();
  const dateLocale = dateLocaleFor(locale);

  const formatUsdc = useCallback(
    (n: number | undefined | null) => formatTransparencyUsdc(n, locale),
    [locale]
  );

  const categoryLabel = useCallback(
    (cat: TransparencyCategory) => t(`transparency.categories.${cat}`),
    [t]
  );

  const [items, setItems] = useState<TransparencyEntry[]>([]);
  const [healthFromApi, setHealthFromApi] = useState<TransparencyHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [depositWallet, setDepositWallet] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(() => {
    const saved = lsGet('transparencyPeriodYm');
    if (saved === 'geral' || saved === '') return null;
    if (/^\d{4}-\d{2}$/.test(saved)) return saved;
    return currentPeriodYmUtc();
  });
  const [search, setSearch] = useState(() => lsGet('transparencySearch'));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, web3, health] = await Promise.all([
        getTransparency(),
        getWeb3Settings(),
        getTransparencyHealth().catch(() => null)
      ]);
      setItems(list);
      setHealthFromApi(health);
      const w = web3?.depositWallet?.trim();
      setDepositWallet(w && /^0x[a-fA-F0-9]{40}$/i.test(w) ? w : null);
    } catch {
      setError(t('transparency.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const periodOptions = useMemo(() => collectPeriodYmOptions(items), [items]);

  const filteredItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    const monthItems = filterEntriesByPeriodYm(items, selectedPeriod);
    return monthItems.filter((e) => {
      if (!term) return true;
      const blob = `${e.title} ${e.body || ''} ${categoryLabel(normalizeCategory(e.category))}`.toLowerCase();
      return blob.includes(term);
    });
  }, [items, selectedPeriod, search, categoryLabel]);

  const sheetTotals = useMemo(() => sumTransparencySheet(filteredItems), [filteredItems]);

  const stats = useMemo(() => {
    const { pool, expense, investment, other, trade } = sheetTotals;
    let withAmount = 0;
    for (const e of filteredItems) {
      if (e.amountUsdc != null && Number.isFinite(e.amountUsdc)) withAmount += 1;
    }
    const totalWeighted =
      Math.abs(pool) + Math.abs(trade) + Math.abs(expense) + Math.abs(investment) + Math.abs(other);
    const informative = pool + investment - expense;
    return { pool, expense, investment, other, withAmount, totalWeighted, informative };
  }, [filteredItems, sheetTotals]);

  const healthSnapshot = useMemo(
    () => healthFromApi ?? computeTransparencyHealth(items),
    [healthFromApi, items]
  );

  const weightByCategory = useMemo(() => {
    const rows: { cat: TransparencyCategory; amount: number; label: string }[] = [];
    for (const c of CATEGORY_ORDER) {
      let sum = 0;
      for (const e of filteredItems) {
        if (normalizeCategory(e.category) !== c) continue;
        const a = e.amountUsdc;
        if (a != null && Number.isFinite(a)) sum += a;
      }
      rows.push({ cat: c, amount: sum, label: categoryLabel(c) });
    }
    const denom = stats.totalWeighted > 0 ? stats.totalWeighted : 1;
    return rows.map((r) => ({
      ...r,
      pct: denom > 0 ? Math.min(100, (Math.abs(r.amount) / denom) * 100) : 0
    }));
  }, [filteredItems, stats.totalWeighted, categoryLabel]);

  const grouped = useMemo(() => {
    const m = new Map<TransparencyCategory, TransparencyEntry[]>();
    for (const c of CATEGORY_ORDER) m.set(c, []);
    for (const e of filteredItems) {
      const c = normalizeCategory(e.category);
      m.get(c)!.push(e);
    }
    for (const list of m.values()) {
      list.sort((a, b) => (a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.id - b.id));
    }
    return m;
  }, [filteredItems]);

  const exportCsv = () => {
    if (filteredItems.length === 0) {
      alert(t('transparency.exportEmpty'));
      return;
    }
    const headers = ['Period', 'Category', 'Title', 'Amount_USDC', 'Published_at', 'Link'];
    const lines = filteredItems.map((e) => {
      const ms = entryTimeMs(e);
      const d = ms ? new Date(ms).toLocaleString(dateLocale) : '';
      const cat = categoryLabel(normalizeCategory(e.category));
      const amt = e.amountUsdc != null && Number.isFinite(e.amountUsdc) ? String(e.amountUsdc) : '';
      const title = String(e.title).replace(/"/g, '""');
      const link = (e.linkUrl || '').replace(/"/g, '""');
      const period = e.periodYm || 'geral';
      return `"${period}","${cat}","${title}","${amt}","${d}","${link}"`;
    });
    const csv = [headers.join(','), ...lines].join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ym = selectedPeriod || 'geral';
    a.download = `transparency_${ym}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyWallet = () => {
    if (depositWallet) void navigator.clipboard.writeText(depositWallet);
  };

  const clearAllFilters = () => {
    setSearch('');
    lsRemove('transparencySearch');
  };

  const selectPeriod = (ym: string | null) => {
    setSelectedPeriod(ym);
    lsSet('transparencyPeriodYm', ym ?? 'geral');
  };

  return (
    <div className="flex flex-1 w-full max-w-6xl mx-auto flex-col animate-in fade-in slide-in-from-bottom-2 duration-300 p-4 md:p-6">
      <div className="relative mb-6 overflow-hidden rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-slate-100 via-white to-slate-100 p-6 shadow-xl dark:from-slate-900 dark:via-slate-950 dark:to-slate-900 md:p-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(16,185,129,0.1),transparent_55%)]" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <div className="shrink-0 rounded-xl border border-emerald-400/30 bg-emerald-500/20 p-3 text-emerald-600 shadow-inner dark:text-emerald-300">
              <Scale size={28} strokeWidth={2} />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white md:text-3xl">
                {t('transparency.title')}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {t('transparency.heroDescription')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex shrink-0 items-center gap-2 self-start rounded-lg border border-slate-300 bg-slate-200/90 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-300 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800/90 dark:text-slate-200 dark:hover:border-slate-500 dark:hover:bg-slate-700"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            {t('transparency.refresh')}
          </button>
        </div>

        <div className="relative mt-6 flex flex-col gap-3 border-t border-slate-300 pt-5 dark:border-slate-700/60">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mr-1">
              <Calendar size={16} />
              <span className="text-xs font-bold uppercase tracking-wide">{t('transparency.period')}</span>
            </div>
            {periodOptions.map((ym) => {
              const on = selectedPeriod === ym;
              const count = filterEntriesByPeriodYm(items, ym).length;
              return (
                <button
                  key={ym ?? 'geral'}
                  type="button"
                  onClick={() => selectPeriod(ym)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${
                    on
                      ? 'border-emerald-500 bg-emerald-900/30 text-emerald-800 dark:text-emerald-100'
                      : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300'
                  }`}
                >
                  {ym ? formatPeriodYmLabel(ym, dateLocale) : t('transparency.monthStanding')}
                  <span className="ml-1 opacity-60">({count})</span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-500">{t('transparency.monthSheetHint')}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-emerald-800/30 bg-emerald-950/10 px-3 py-2">
              <div className="text-[10px] font-bold uppercase text-emerald-600 dark:text-emerald-400/80">
                {t('transparency.sheetIn')}
              </div>
              <div className="font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                {formatUsdc(sheetTotals.inUsdc)}
              </div>
            </div>
            <div className="rounded-lg border border-orange-800/30 bg-orange-950/10 px-3 py-2">
              <div className="text-[10px] font-bold uppercase text-orange-600 dark:text-orange-400/80">
                {t('transparency.sheetOut')}
              </div>
              <div className="font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                {formatUsdc(sheetTotals.outUsdc)}
              </div>
            </div>
            <div className="rounded-lg border border-slate-300 bg-slate-100/80 px-3 py-2 dark:border-slate-600 dark:bg-slate-900/60">
              <div className="text-[10px] font-bold uppercase text-slate-500">{t('transparency.sheetNet')}</div>
              <div
                className={`font-mono text-sm font-bold tabular-nums ${
                  sheetTotals.netUsdc >= 0
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-red-700 dark:text-red-300'
                }`}
              >
                {formatUsdc(sheetTotals.netUsdc)}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-300 bg-slate-100/80 px-3 py-2 focus-within:border-emerald-500/50 dark:border-slate-600 dark:bg-slate-950/60">
              <Search size={16} className="shrink-0 text-slate-500" />
              <input
                value={search}
                onChange={(e) => {
                  const v = e.target.value;
                  setSearch(v);
                  lsSet('transparencySearch', v);
                }}
                placeholder={t('transparency.searchPlaceholder')}
                className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-white dark:placeholder:text-slate-600"
              />
            </div>
            <button
              type="button"
              onClick={exportCsv}
              disabled={loading || filteredItems.length === 0}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-emerald-600/50 bg-emerald-950/10 px-4 py-2 text-xs font-bold text-emerald-700 transition-colors hover:bg-emerald-900/20 disabled:opacity-40 dark:bg-emerald-950/50 dark:text-emerald-200 dark:hover:bg-emerald-900/50"
            >
              <Download size={14} />
              {t('transparency.exportCsv')}
            </button>
          </div>
        </div>
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-slate-100/80 py-24 text-slate-500 dark:border-slate-800 dark:bg-slate-950/50">
          <Loader2 className="animate-spin text-emerald-500" size={36} />
          <span className="text-sm">{t('transparency.loading')}</span>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-xl border border-red-500/40 bg-red-950/10 px-4 py-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="rounded-2xl border border-slate-300 bg-slate-100/80 px-8 py-16 text-center dark:border-slate-700 dark:bg-slate-900/60">
          <p className="text-slate-600 dark:text-slate-400">{t('transparency.emptyTitle')}</p>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-600">{t('transparency.emptyHint')}</p>
        </div>
      )}

      {!loading && !error && (
        <TransparencyHealthBoard snapshot={healthSnapshot} formatUsdc={formatUsdc} />
      )}

      {!loading && !error && items.length > 0 && (
        <>
          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="flex min-h-[118px] flex-col gap-2 rounded-xl border border-slate-300 bg-slate-100/85 p-4 shadow-lg dark:border-slate-700 dark:bg-slate-900/85">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {t('transparency.stats.expense')}
                </span>
                <DollarSign size={18} className="text-slate-500" />
              </div>
              <p className="text-2xl font-bold tabular-nums text-slate-900 dark:text-white">{formatUsdc(stats.expense)}</p>
              <p className="text-[11px] text-slate-500">{t('transparency.stats.expenseHint')}</p>
            </div>
            <div className="flex min-h-[118px] flex-col gap-2 rounded-xl border border-emerald-900/40 bg-emerald-950/10 p-4 shadow-lg dark:bg-emerald-950/15">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400/80">
                  {t('transparency.stats.pool')}
                </span>
                <TrendingUp size={18} className="text-emerald-500/70" />
              </div>
              <p className="text-2xl font-bold tabular-nums text-slate-900 dark:text-white">{formatUsdc(stats.pool)}</p>
              <p className="text-[11px] text-slate-500">{t('transparency.stats.poolHint')}</p>
            </div>
            <div className="flex min-h-[118px] flex-col gap-2 rounded-xl border border-cyan-900/40 bg-cyan-950/10 p-4 shadow-lg">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-600 dark:text-cyan-400/80">
                  {t('transparency.stats.informative')}
                </span>
                <Activity size={18} className="text-cyan-500/70" />
              </div>
              <p className="text-2xl font-bold tabular-nums text-slate-900 dark:text-white">
                {formatUsdc(stats.informative)}
              </p>
              <p className="text-[11px] text-slate-500">{t('transparency.stats.informativeHint')}</p>
            </div>
            <div className="flex min-h-[118px] flex-col gap-2 rounded-xl border border-violet-900/40 bg-violet-950/10 p-4 shadow-lg dark:bg-violet-950/15">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-violet-600 dark:text-violet-300/80">
                  {t('transparency.stats.investment')}
                </span>
                <Wallet size={18} className="text-violet-500/70 dark:text-violet-400/70" />
              </div>
              <p className="text-2xl font-bold tabular-nums text-slate-900 dark:text-white">
                {formatUsdc(stats.investment)}
              </p>
              <p className="text-[11px] text-slate-500">
                {t('transparency.stats.investmentHint', {
                  count: filteredItems.length,
                  withAmount: stats.withAmount
                })}
              </p>
            </div>
          </div>

          <div className="mb-6 rounded-2xl border border-slate-300 bg-slate-100/70 p-5 shadow-inner dark:border-slate-700 dark:bg-slate-900/70 md:p-6">
            <div className="mb-4 flex items-center gap-2">
              <Layers size={18} className="text-slate-500 dark:text-slate-400" />
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700 dark:text-slate-300">
                {t('transparency.weightByCategory')}
              </h2>
              <span className="ml-auto text-[10px] text-slate-500 dark:text-slate-600">
                {t('transparency.weightHint')}
              </span>
            </div>
            <div className="space-y-4">
              {weightByCategory.map(({ cat, label, amount, pct }) => (
                <div key={cat} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex w-full items-center justify-between sm:block sm:w-40">
                    <span className={`text-xs font-bold ${catAccent(cat)}`}>{label}</span>
                    <span className="font-mono text-xs text-slate-500 sm:hidden dark:text-slate-400">
                      {formatUsdc(amount)}
                    </span>
                  </div>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full border border-slate-300 bg-slate-200 dark:border-slate-700/80 dark:bg-slate-800">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        cat === 'pool'
                          ? 'bg-emerald-500'
                          : cat === 'trade'
                            ? 'bg-sky-500'
                            : cat === 'investment'
                              ? 'bg-violet-500'
                              : cat === 'expense'
                                ? 'bg-orange-500'
                                : 'bg-slate-500'
                      }`}
                      style={{ width: `${Number.isFinite(pct) ? pct : 0}%` }}
                    />
                  </div>
                  <span className="hidden w-28 text-right font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300 sm:block">
                    {formatUsdc(amount)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {depositWallet && (
            <div className="mb-6 rounded-2xl border border-emerald-700/35 bg-gradient-to-br from-emerald-950/20 to-slate-100/80 p-5 dark:from-emerald-950/40 dark:to-slate-950/80 md:p-6">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-900 dark:text-white">{t('transparency.wallet.title')}</h2>
                  <p className="mt-1 text-xs text-slate-500">{t('transparency.wallet.description')}</p>
                </div>
              </div>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="flex flex-1 items-center gap-2 break-all rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-mono text-xs text-emerald-800 dark:border-slate-700 dark:bg-slate-950/80 dark:text-emerald-100/90">
                  {depositWallet}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={copyWallet}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-300 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    <Copy size={14} />
                    {t('transparency.wallet.copy')}
                  </button>
                  <a
                    href={`https://debank.com/profile/polygon/${depositWallet}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-700/50 bg-emerald-950/30 px-3 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-900/40 dark:bg-emerald-950/50 dark:text-emerald-200 dark:hover:bg-emerald-900/60"
                  >
                    {t('transparency.wallet.debank')}
                    <ExternalLink size={12} />
                  </a>
                  <a
                    href={`https://polygonscan.com/address/${depositWallet}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-300 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    {t('transparency.wallet.polygonscan')}
                    <ExternalLink size={12} />
                  </a>
                </div>
              </div>
              <p className="mt-3 text-[11px] text-slate-500 dark:text-slate-600">{t('transparency.wallet.footnote')}</p>
            </div>
          )}

          <div className="mb-8 overflow-hidden rounded-2xl border border-slate-300 bg-slate-100/50 dark:border-slate-700 dark:bg-slate-900/50">
            <div className="border-b border-slate-200 bg-slate-200/50 px-5 py-4 dark:border-slate-800 dark:bg-slate-950/40">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700 dark:text-slate-300">
                {t('transparency.details.title')}
              </h2>
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-600">{t('transparency.details.hint')}</p>
            </div>
            <div className="space-y-8 p-4 md:p-6">
              {filteredItems.length === 0 && (
                <div className="rounded-xl border border-amber-900/40 bg-amber-950/10 px-4 py-4 text-center text-sm text-amber-900 dark:bg-amber-950/25 dark:text-amber-100/95">
                  {t('transparency.details.noMatches')}{' '}
                  <button
                    type="button"
                    className="font-bold underline hover:text-slate-900 dark:hover:text-white"
                    onClick={clearAllFilters}
                  >
                    {t('transparency.details.clearFilters')}
                  </button>
                </div>
              )}
              {CATEGORY_ORDER.map((cat) => {
                const list = grouped.get(cat) || [];
                if (list.length === 0) return null;
                const catSum = list.reduce((acc, e) => {
                  const a = e.amountUsdc;
                  return acc + (a != null && Number.isFinite(a) ? a : 0);
                }, 0);
                return (
                  <div key={cat}>
                    <div className="mb-3 flex items-center justify-between gap-2 border-b border-slate-200 pb-2 dark:border-slate-800/80">
                      <span className={`text-[11px] font-bold uppercase tracking-widest ${catAccent(cat)}`}>
                        {categoryLabel(cat)}
                      </span>
                      <span className="font-mono text-xs text-slate-500">
                        {t('transparency.details.catSumInPeriod', { amount: formatUsdc(catSum) })}
                      </span>
                    </div>
                    <ul className="space-y-3">
                      {list.map((row) => {
                        const amt = row.amountUsdc;
                        const hasAmt = amt != null && Number.isFinite(amt);
                        return (
                          <li
                            key={row.id}
                            className={`rounded-xl border p-4 transition-shadow hover:shadow-md md:p-5 ${catBorder(cat)}`}
                          >
                            <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
                              <h3 className="pr-4 text-base font-bold text-slate-900 dark:text-white md:text-lg">
                                {row.title}
                              </h3>
                              {hasAmt && (
                                <span className="shrink-0 font-mono text-sm font-bold text-amber-600 dark:text-amber-400">
                                  {formatUsdc(amt)}
                                </span>
                              )}
                            </div>
                            {row.body && (
                              <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                                {row.body}
                              </p>
                            )}
                            <div className="mt-3 flex flex-wrap items-center gap-3">
                              {row.linkUrl && isSafeHttpsLink(row.linkUrl) ? (
                                <a
                                  href={row.linkUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-600 hover:text-emerald-500 dark:text-emerald-400 dark:hover:text-emerald-300"
                                >
                                  {t('transparency.details.viewLink')}
                                  <ExternalLink size={12} />
                                </a>
                              ) : null}
                              <span className="text-[10px] text-slate-500 dark:text-slate-600">
                                {entryTimeMs(row)
                                  ? new Date(entryTimeMs(row)).toLocaleString(dateLocale)
                                  : ''}
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
