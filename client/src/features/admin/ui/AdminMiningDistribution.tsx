// @ts-nocheck — template legado 1:1.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  Download,
  TrendingUp,
  Users,
  Coins,
  Filter,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Database,
  Search
} from 'lucide-react';
import {
  getAdminMiningDistributionOverview,
  getAdminMiningDistributionByCoin,
  getAdminMiningDistributionTimeline,
  getAdminMiningDistributionCredits,
  getAdminMiningDistributionUserSummary,
  buildAdminMiningDistributionCsvUrl,
  postAdminMiningDistributionRebuildRollups,
  type AdminMiningDistributionOverview,
  type AdminMiningDistributionByCoinRow,
  type AdminMiningCreditLedgerRow
} from '../../../shared/api/admin-legacy';

function utcYmdToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function utcYmdDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  if (Math.abs(n) >= 1) {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
}

function formatCoins(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const fixed = n.toFixed(8);
  return fixed.replace(/\.?0+$/, '') || '0';
}

function formatUtcDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  } catch {
    return '—';
  }
}

function formatHashrate(hps: number): string {
  if (!Number.isFinite(hps) || hps <= 0) return '0 H/s';
  if (hps >= 1e12) return `${(hps / 1e12).toFixed(2)} TH/s`;
  if (hps >= 1e9) return `${(hps / 1e9).toFixed(2)} GH/s`;
  if (hps >= 1e6) return `${(hps / 1e6).toFixed(2)} MH/s`;
  if (hps >= 1e3) return `${(hps / 1e3).toFixed(2)} KH/s`;
  return `${hps.toFixed(0)} H/s`;
}

type KpiCardProps = {
  title: string;
  totals: { totalUsd: number; totalCoins: number; creditRows: number; uniqueUsers: number };
  loading?: boolean;
  variant?: 'amber' | 'emerald';
};

const KpiCard: React.FC<KpiCardProps> = ({ title, totals, loading, variant = 'amber' }) => (
  <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{title}</div>
    {loading ? (
      <Loader2 className="mt-3 h-5 w-5 animate-spin text-slate-500" />
    ) : (
      <>
        <div
          className={`mt-2 text-2xl font-bold ${variant === 'emerald' ? 'text-emerald-400' : 'text-amber-400'}`}
        >
          {formatUsd(totals.totalUsd)}
        </div>
        <div className="mt-1 text-xs text-slate-500">
          {totals.creditRows.toLocaleString('pt-BR')} créditos ·{' '}
          {totals.uniqueUsers.toLocaleString('pt-BR')} utilizadores
        </div>
      </>
    )}
  </div>
);

export const AdminMiningDistribution: React.FC = () => {
  const [overview, setOverview] = useState<AdminMiningDistributionOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [fromYmd, setFromYmd] = useState(() => utcYmdDaysAgo(29));
  const [toYmd, setToYmd] = useState(() => utcYmdToday());
  const [customFromYmd, setCustomFromYmd] = useState('');
  const [customToYmd, setCustomToYmd] = useState('');

  const [byCoin, setByCoin] = useState<AdminMiningDistributionByCoinRow[]>([]);
  const [byCoinLoading, setByCoinLoading] = useState(false);

  const [timelineBucket, setTimelineBucket] = useState<'day' | 'week'>('day');
  const [timelineRows, setTimelineRows] = useState<
    Array<{ bucketStartMs: number; totalUsd: number; creditRows: number }>
  >([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const [ledgerFilters, setLedgerFilters] = useState({
    userId: '',
    coinId: '',
    roomId: '',
    q: ''
  });
  const [credits, setCredits] = useState<AdminMiningCreditLedgerRow[]>([]);
  const [creditsTotal, setCreditsTotal] = useState(0);
  const [creditsPage, setCreditsPage] = useState(1);
  const [creditsLimit] = useState(50);
  const [creditsLoading, setCreditsLoading] = useState(false);

  const [userLookup, setUserLookup] = useState('');
  const [userSummary, setUserSummary] = useState<{
    userId: number;
    totals: { totalUsd: number; creditRows: number };
    byCoin: AdminMiningDistributionByCoinRow[];
  } | null>(null);
  const [userSummaryLoading, setUserSummaryLoading] = useState(false);

  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [rebuildNotice, setRebuildNotice] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    setError(null);
    try {
      const r = await getAdminMiningDistributionOverview(
        customFromYmd || undefined,
        customToYmd || undefined
      );
      if (!r) {
        setError('Não foi possível carregar o resumo. Verifique permissão Relatórios.');
        setOverview(null);
      } else {
        setOverview(r);
      }
    } catch {
      setError('Erro de rede ao carregar resumo.');
    } finally {
      setOverviewLoading(false);
    }
  }, [customFromYmd, customToYmd]);

  const loadByCoinAndTimeline = useCallback(async () => {
    setByCoinLoading(true);
    setTimelineLoading(true);
    try {
      const [coinRes, timelineRes] = await Promise.all([
        getAdminMiningDistributionByCoin(fromYmd, toYmd),
        getAdminMiningDistributionTimeline(fromYmd, toYmd, timelineBucket)
      ]);
      setByCoin(coinRes?.rows ?? []);
      setTimelineRows(
        (timelineRes?.rows ?? []).map((r) => ({
          bucketStartMs: r.bucketStartMs,
          totalUsd: r.totalUsd,
          creditRows: r.creditRows
        }))
      );
    } finally {
      setByCoinLoading(false);
      setTimelineLoading(false);
    }
  }, [fromYmd, toYmd, timelineBucket]);

  const loadCredits = useCallback(
    async (page: number) => {
      setCreditsLoading(true);
      try {
        const userIdNum = ledgerFilters.userId.trim()
          ? parseInt(ledgerFilters.userId.trim(), 10)
          : undefined;
        const r = await getAdminMiningDistributionCredits({
          fromYmd,
          toYmd,
          page,
          limit: creditsLimit,
          userId: Number.isFinite(userIdNum) ? userIdNum : undefined,
          coinId: ledgerFilters.coinId.trim() || undefined,
          roomId: ledgerFilters.roomId.trim() || undefined,
          q: ledgerFilters.q.trim() || undefined
        });
        if (r) {
          setCredits(r.rows);
          setCreditsTotal(r.total);
          setCreditsPage(r.page);
        } else {
          setCredits([]);
          setCreditsTotal(0);
        }
      } finally {
        setCreditsLoading(false);
      }
    },
    [fromYmd, toYmd, ledgerFilters, creditsLimit]
  );

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    void loadByCoinAndTimeline();
  }, [loadByCoinAndTimeline]);

  useEffect(() => {
    void loadCredits(1);
  }, [loadCredits]);

  const maxTimelineUsd = useMemo(
    () => Math.max(1, ...timelineRows.map((r) => r.totalUsd)),
    [timelineRows]
  );

  const creditsTotalPages = Math.max(1, Math.ceil(creditsTotal / creditsLimit));

  const handleExportCsv = () => {
    const userIdNum = ledgerFilters.userId.trim()
      ? parseInt(ledgerFilters.userId.trim(), 10)
      : undefined;
    const url = buildAdminMiningDistributionCsvUrl({
      fromYmd,
      toYmd,
      userId: Number.isFinite(userIdNum) ? userIdNum : undefined,
      coinId: ledgerFilters.coinId.trim() || undefined,
      roomId: ledgerFilters.roomId.trim() || undefined,
      q: ledgerFilters.q.trim() || undefined
    });
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const handleUserLookup = async () => {
    const raw = userLookup.trim();
    const id = parseInt(raw, 10);
    if (!Number.isFinite(id) || id <= 0) {
      setUserSummary(null);
      return;
    }
    setUserSummaryLoading(true);
    try {
      const r = await getAdminMiningDistributionUserSummary(id, fromYmd, toYmd);
      if (r) {
        setUserSummary({
          userId: r.userId,
          totals: { totalUsd: r.totals.totalUsd, creditRows: r.totals.creditRows },
          byCoin: r.byCoin
        });
        setLedgerFilters((f) => ({ ...f, userId: String(id) }));
      } else {
        setUserSummary(null);
      }
    } finally {
      setUserSummaryLoading(false);
    }
  };

  const handleRebuild = async () => {
    setRebuildBusy(true);
    setRebuildNotice(null);
    try {
      const r = await postAdminMiningDistributionRebuildRollups({ daysBack: 45 });
      if (r.ok) {
        setRebuildNotice(
          `Rollups atualizados (~${r.daysProcessed ?? '?'} dias, ${r.rowsUpserted ?? 0} linhas).`
        );
        await loadOverview();
        await loadByCoinAndTimeline();
      } else {
        setRebuildNotice(r.error || 'Falha ao reconstruir rollups.');
      }
    } finally {
      setRebuildBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 pb-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <TrendingUp className="text-amber-400" size={22} />
            Distribuição Mining
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Créditos reais em <span className="text-slate-400">mining_block_history</span> — agrupamento{' '}
            <span className="font-mono text-amber-500/80">UTC</span>.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void loadOverview();
              void loadByCoinAndTimeline();
              void loadCredits(creditsPage);
            }}
            className="px-3 py-2 text-xs font-bold rounded border border-slate-700 text-slate-300 hover:text-white flex items-center gap-2"
          >
            <RefreshCw size={14} />
            Atualizar
          </button>
          <button
            type="button"
            disabled={rebuildBusy}
            onClick={() => void handleRebuild()}
            className="px-3 py-2 text-xs font-bold rounded border border-slate-700 text-slate-300 hover:text-white flex items-center gap-2 disabled:opacity-50"
          >
            {rebuildBusy ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
            Recalcular rollups
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}
      {rebuildNotice && (
        <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-200">
          {rebuildNotice}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          title="Hoje (UTC)"
          loading={overviewLoading}
          totals={
            overview?.periods.today ?? {
              totalUsd: 0,
              totalCoins: 0,
              creditRows: 0,
              uniqueUsers: 0
            }
          }
        />
        <KpiCard
          title="Últimos 7 dias"
          loading={overviewLoading}
          totals={
            overview?.periods.last7Days ?? {
              totalUsd: 0,
              totalCoins: 0,
              creditRows: 0,
              uniqueUsers: 0
            }
          }
        />
        <KpiCard
          title="Últimos 30 dias"
          loading={overviewLoading}
          totals={
            overview?.periods.last30Days ?? {
              totalUsd: 0,
              totalCoins: 0,
              creditRows: 0,
              uniqueUsers: 0
            }
          }
        />
        <KpiCard
          title="Período personalizado"
          loading={overviewLoading}
          totals={
            overview?.periods.custom ?? {
              totalUsd: 0,
              totalCoins: 0,
              creditRows: 0,
              uniqueUsers: 0
            }
          }
          variant="emerald"
        />
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 flex flex-wrap gap-3 items-end">
        <label className="text-xs text-slate-500">
          Custom from (UTC)
          <input
            type="date"
            value={customFromYmd}
            onChange={(e) => setCustomFromYmd(e.target.value)}
            className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
          />
        </label>
        <label className="text-xs text-slate-500">
          Custom to (UTC)
          <input
            type="date"
            value={customToYmd}
            onChange={(e) => setCustomToYmd(e.target.value)}
            className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
          />
        </label>
        <button
          type="button"
          onClick={() => void loadOverview()}
          className="px-3 py-2 text-xs font-bold rounded bg-amber-600/20 border border-amber-600/40 text-amber-200"
        >
          Aplicar KPI custom
        </button>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="flex flex-wrap gap-3 items-end mb-4">
          <label className="text-xs text-slate-500">
            De (UTC)
            <input
              type="date"
              value={fromYmd}
              onChange={(e) => setFromYmd(e.target.value)}
              className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <label className="text-xs text-slate-500">
            Até (UTC)
            <input
              type="date"
              value={toYmd}
              onChange={(e) => setToYmd(e.target.value)}
              className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setFromYmd(utcYmdDaysAgo(6));
                setToYmd(utcYmdToday());
              }}
              className="px-2 py-1.5 text-[10px] font-bold uppercase border border-slate-700 rounded text-slate-400"
            >
              7d
            </button>
            <button
              type="button"
              onClick={() => {
                setFromYmd(utcYmdDaysAgo(29));
                setToYmd(utcYmdToday());
              }}
              className="px-2 py-1.5 text-[10px] font-bold uppercase border border-slate-700 rounded text-slate-400"
            >
              30d
            </button>
          </div>
        </div>

        <h3 className="text-sm font-bold text-slate-300 flex items-center gap-2 mb-3">
          <Coins size={16} className="text-amber-400" />
          Por moeda
          {byCoinLoading && <Loader2 size={14} className="animate-spin text-slate-500" />}
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="text-[10px] uppercase text-slate-500 border-b border-slate-800">
                <th className="py-2 pr-4">Moeda</th>
                <th className="py-2 pr-4">Total moeda</th>
                <th className="py-2 pr-4">USD</th>
                <th className="py-2 pr-4">% USD</th>
                <th className="py-2 pr-4">Créditos</th>
                <th className="py-2 pr-4">Utilizadores</th>
                <th className="py-2">Emissão vs teto</th>
              </tr>
            </thead>
            <tbody>
              {byCoin.length === 0 && !byCoinLoading && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-slate-500">
                    Sem créditos no período.
                  </td>
                </tr>
              )}
              {byCoin.map((row) => (
                <tr key={row.coinId} className="border-b border-slate-800/60 hover:bg-slate-800/30">
                  <td className="py-2 pr-4 font-bold text-white">
                    {row.symbol}
                    <span className="block text-[10px] text-slate-500 font-normal">{row.name}</span>
                  </td>
                  <td className="py-2 pr-4 font-mono text-amber-400/90">{formatCoins(row.totalCoins)}</td>
                  <td className="py-2 pr-4 font-mono text-green-400/90">{formatUsd(row.totalUsd)}</td>
                  <td className="py-2 pr-4 text-slate-400">{row.pctOfTotalUsd.toFixed(1)}%</td>
                  <td className="py-2 pr-4">{row.creditRows.toLocaleString('pt-BR')}</td>
                  <td className="py-2 pr-4">{row.uniqueUsers.toLocaleString('pt-BR')}</td>
                  <td className="py-2 text-xs text-slate-500">
                    {row.emissionUtilizationPct != null
                      ? `${row.emissionUtilizationPct.toFixed(1)}% do teto teórico`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h3 className="text-sm font-bold text-slate-300">Timeline (USD)</h3>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTimelineBucket('day')}
              className={`px-2 py-1 text-[10px] font-bold uppercase rounded border ${
                timelineBucket === 'day'
                  ? 'border-amber-600/50 text-amber-200 bg-amber-600/10'
                  : 'border-slate-700 text-slate-500'
              }`}
            >
              Dia
            </button>
            <button
              type="button"
              onClick={() => setTimelineBucket('week')}
              className={`px-2 py-1 text-[10px] font-bold uppercase rounded border ${
                timelineBucket === 'week'
                  ? 'border-amber-600/50 text-amber-200 bg-amber-600/10'
                  : 'border-slate-700 text-slate-500'
              }`}
            >
              Semana
            </button>
          </div>
        </div>
        {timelineLoading ? (
          <Loader2 className="h-6 w-6 animate-spin text-slate-500 mx-auto" />
        ) : timelineRows.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-6">Sem dados no período.</p>
        ) : (
          <div className="flex items-end gap-1 h-32 overflow-x-auto pb-2">
            {timelineRows.map((row) => (
              <div
                key={row.bucketStartMs}
                className="flex flex-col items-center min-w-[28px] flex-1 max-w-[48px]"
                title={`${formatUtcDateTime(row.bucketStartMs)} — ${formatUsd(row.totalUsd)}`}
              >
                <div
                  className="w-full bg-amber-500/70 rounded-t"
                  style={{ height: `${Math.max(4, (row.totalUsd / maxTimelineUsd) * 100)}%` }}
                />
                <span className="text-[8px] text-slate-600 mt-1 rotate-[-45deg] origin-top-left whitespace-nowrap">
                  {new Date(row.bucketStartMs).toISOString().slice(5, 10)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
        <h3 className="text-sm font-bold text-slate-300 flex items-center gap-2 mb-3">
          <Users size={16} className="text-amber-400" />
          Drill-down utilizador
        </h3>
        <div className="flex flex-wrap gap-2 mb-3">
          <input
            type="text"
            placeholder="ID do utilizador"
            value={userLookup}
            onChange={(e) => setUserLookup(e.target.value)}
            className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white min-w-[140px]"
          />
          <button
            type="button"
            onClick={() => void handleUserLookup()}
            disabled={userSummaryLoading}
            className="px-3 py-2 text-xs font-bold rounded border border-amber-600/40 text-amber-200 flex items-center gap-2"
          >
            {userSummaryLoading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            Resumo
          </button>
        </div>
        {userSummary && (
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm">
            <div className="text-white font-bold">
              User #{userSummary.userId} — {formatUsd(userSummary.totals.totalUsd)} ·{' '}
              {userSummary.totals.creditRows} créditos
            </div>
            <ul className="mt-2 space-y-1 text-slate-400">
              {userSummary.byCoin.map((c) => (
                <li key={c.coinId}>
                  {c.symbol}: {formatCoins(c.totalCoins)} ({formatUsd(c.totalUsd)})
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h3 className="text-sm font-bold text-slate-300 flex items-center gap-2">
            <Filter size={16} />
            Ledger de créditos
          </h3>
          <button
            type="button"
            onClick={handleExportCsv}
            className="px-3 py-2 text-xs font-bold rounded border border-slate-700 text-slate-300 flex items-center gap-2 hover:text-white"
          >
            <Download size={14} />
            Exportar CSV
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mb-4">
          <input
            placeholder="User ID"
            value={ledgerFilters.userId}
            onChange={(e) => setLedgerFilters((f) => ({ ...f, userId: e.target.value }))}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
          />
          <input
            placeholder="Coin ID"
            value={ledgerFilters.coinId}
            onChange={(e) => setLedgerFilters((f) => ({ ...f, coinId: e.target.value }))}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
          />
          <input
            placeholder="Room ID"
            value={ledgerFilters.roomId}
            onChange={(e) => setLedgerFilters((f) => ({ ...f, roomId: e.target.value }))}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
          />
          <input
            placeholder="Username / email"
            value={ledgerFilters.q}
            onChange={(e) => setLedgerFilters((f) => ({ ...f, q: e.target.value }))}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
          />
        </div>
        <button
          type="button"
          onClick={() => void loadCredits(1)}
          className="mb-4 px-3 py-1.5 text-xs font-bold rounded bg-slate-800 text-slate-300"
        >
          Filtrar
        </button>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead>
              <tr className="text-[10px] uppercase text-slate-500 border-b border-slate-800">
                <th className="py-2 pr-2">Fim janela UTC</th>
                <th className="py-2 pr-2">Utilizador</th>
                <th className="py-2 pr-2">Moeda</th>
                <th className="py-2 pr-2">Blocos</th>
                <th className="py-2 pr-2">Quantidade</th>
                <th className="py-2 pr-2">USD</th>
                <th className="py-2">Hash user</th>
              </tr>
            </thead>
            <tbody>
              {creditsLoading && (
                <tr>
                  <td colSpan={7} className="py-8 text-center">
                    <Loader2 className="inline h-5 w-5 animate-spin text-slate-500" />
                  </td>
                </tr>
              )}
              {!creditsLoading && credits.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-slate-500">
                    Nenhum crédito (máx. 93 dias).
                  </td>
                </tr>
              )}
              {!creditsLoading &&
                credits.map((row) => (
                  <tr key={row.id} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                    <td className="py-2 pr-2 font-mono text-slate-400 whitespace-nowrap">
                      {formatUtcDateTime(row.windowEndMs)}
                    </td>
                    <td className="py-2 pr-2">
                      <span className="text-white font-medium">#{row.userId}</span>
                      <span className="block text-slate-500 truncate max-w-[120px]">
                        {row.username || row.email || '—'}
                      </span>
                    </td>
                    <td className="py-2 pr-2 text-amber-400">{row.coinSymbol || row.coinId}</td>
                    <td className="py-2 pr-2">{row.creditBlocks}</td>
                    <td className="py-2 pr-2 font-mono">{formatCoins(row.amountCoins)}</td>
                    <td className="py-2 pr-2 font-mono text-green-400/80">{formatUsd(row.amountUsd)}</td>
                    <td className="py-2 text-slate-500">{formatHashrate(row.userHashHps)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between mt-4 text-xs text-slate-500">
          <span>
            {creditsTotal.toLocaleString('pt-BR')} registos · página {creditsPage} / {creditsTotalPages}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={creditsPage <= 1 || creditsLoading}
              onClick={() => void loadCredits(creditsPage - 1)}
              className="p-2 rounded border border-slate-700 disabled:opacity-40"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              disabled={creditsPage >= creditsTotalPages || creditsLoading}
              onClick={() => void loadCredits(creditsPage + 1)}
              className="p-2 rounded border border-slate-700 disabled:opacity-40"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
