import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, Coins, DollarSign, History, Users, ArrowLeft } from 'lucide-react';
import {
  getAdminReinvestmentHistory,
  getAdminUserReinvestmentHistory,
  type AdminReinvestmentHistoryEntry,
  type AdminReinvestmentHistoryResult,
  type AdminReinvestmentTotals,
  type AdminReinvestmentUserAggregate
} from '../../../shared/api/admin-users';
import type { ReinvestmentHistoryEntry } from '../../../shared/api/wallet';
import { ADMIN_SHOP_SEARCH_MAX } from '../../../shared/constants/formLimits';
import { formatMinedCoinAmount, formatUsdcAmount } from '../../../shared/utils/locale-format';

function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** `datetime-local` → epoch ms string (same contract as AdminShopCheckouts). */
function localInputToMs(value: string): string {
  const t = value.trim();
  if (!t) return '';
  const ms = new Date(t).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return String(Math.floor(ms));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Epoch ms → value for `<input type="datetime-local">` in local timezone. */
function msToLocalInput(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function startOfLocalMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

const ADMIN_REINVESTMENT_LOAD_ERROR = 'Erro ao carregar histórico de reinvestimento.';
const ADMIN_REINVESTMENT_USER_LOAD_ERROR = 'Erro ao carregar reinvestimentos deste utilizador.';

const EMPTY_TOTALS: AdminReinvestmentTotals = {
  ops: 0,
  users: 0,
  grossUsdc: 0,
  feeUsdc: 0,
  netUsdc: 0,
  minAt: 0,
  maxAt: 0
};

type ViewMode = 'overview' | 'by_user' | 'user_detail';

type Totals = {
  ops: number;
  users: number;
  grossUsdc: number;
  feeUsdc: number;
  netUsdc: number;
};

function sumEntries(rows: ReadonlyArray<{ grossUsdc: number; feeUsdc: number; netUsdc: number }>): Omit<
  Totals,
  'users'
> {
  let ops = 0;
  let grossUsdc = 0;
  let feeUsdc = 0;
  let netUsdc = 0;
  for (const row of rows) {
    ops += 1;
    grossUsdc += row.grossUsdc;
    feeUsdc += row.feeUsdc;
    netUsdc += row.netUsdc;
  }
  return { ops, grossUsdc, feeUsdc, netUsdc };
}

function coinLabel(row: { coinSymbol: string; coinId: string }): string {
  const symbol = row.coinSymbol.trim();
  return symbol || row.coinId;
}

function TotalsCards({ totals, title }: { totals: Totals; title: string }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-bold uppercase tracking-wider text-slate-400">{title}</p>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <p className="text-xs uppercase tracking-wider text-slate-400 font-bold">Liquidações</p>
          <p className="mt-1 text-2xl font-black text-white">{totals.ops.toLocaleString('pt-BR')}</p>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <p className="text-xs uppercase tracking-wider text-slate-400 font-bold">Utilizadores</p>
          <p className="mt-1 text-2xl font-black text-sky-400">{totals.users.toLocaleString('pt-BR')}</p>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <p className="text-xs uppercase tracking-wider text-slate-400 font-bold">Bruto USDC</p>
          <p className="mt-1 text-2xl font-black text-green-400">
            {formatUsdcAmount(totals.grossUsdc, 'pt-BR')}
          </p>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <p className="text-xs uppercase tracking-wider text-slate-400 font-bold">Taxas</p>
          <p className="mt-1 text-2xl font-black text-red-400">
            {formatUsdcAmount(totals.feeUsdc, 'pt-BR')}
          </p>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <p className="text-xs uppercase tracking-wider text-slate-400 font-bold">Líquido USDC</p>
          <p className="mt-1 text-2xl font-black text-amber-400">
            {formatUsdcAmount(totals.netUsdc, 'pt-BR')}
          </p>
        </div>
      </div>
    </div>
  );
}

export const AdminReinvestmentHistory: React.FC = () => {
  const [report, setReport] = useState<AdminReinvestmentHistoryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [fromLocal, setFromLocal] = useState('');
  const [toLocal, setToLocal] = useState('');
  const [appliedFromMs, setAppliedFromMs] = useState('');
  const [appliedToMs, setAppliedToMs] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('overview');

  const [selectedUser, setSelectedUser] = useState<AdminReinvestmentUserAggregate | null>(null);
  const [userHistory, setUserHistory] = useState<ReinvestmentHistoryEntry[]>([]);
  const [userLoading, setUserLoading] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);

  const load = useCallback(async (fromMs: string, toMs: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getAdminReinvestmentHistory({ fromMs, toMs });
      if (data === null) {
        setReport(null);
        setLoadError(ADMIN_REINVESTMENT_LOAD_ERROR);
        return;
      }
      setReport(data);
      setAppliedFromMs(fromMs);
      setAppliedToMs(toMs);
    } catch {
      setReport(null);
      setLoadError(ADMIN_REINVESTMENT_LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load('', '');
  }, [load]);

  const applyDateFilter = () => {
    void load(localInputToMs(fromLocal), localInputToMs(toLocal));
  };

  const clearDateFilter = () => {
    setFromLocal('');
    setToLocal('');
    void load('', '');
  };

  const presetToday = () => {
    const now = new Date();
    const from = msToLocalInput(startOfLocalDay(now).getTime());
    const to = msToLocalInput(endOfLocalDay(now).getTime());
    setFromLocal(from);
    setToLocal(to);
    void load(localInputToMs(from), localInputToMs(to));
  };

  const presetThisMonth = () => {
    const now = new Date();
    const from = msToLocalInput(startOfLocalMonth(now).getTime());
    const to = msToLocalInput(endOfLocalDay(now).getTime());
    setFromLocal(from);
    setToLocal(to);
    void load(localInputToMs(from), localInputToMs(to));
  };

  const q = searchTerm.trim().toLowerCase();
  const entries = report?.items ?? [];
  const serverByUser = report?.byUser ?? [];
  const globalTotals = report?.totals ?? EMPTY_TOTALS;

  const filteredEntries = useMemo(() => {
    if (!q) return entries;
    return entries.filter(
      (row) =>
        row.username.toLowerCase().includes(q) ||
        row.email.toLowerCase().includes(q) ||
        String(row.userId).includes(q) ||
        row.coinId.toLowerCase().includes(q) ||
        row.coinSymbol.toLowerCase().includes(q)
    );
  }, [entries, q]);

  const filteredTotals = useMemo((): Totals => {
    const s = sumEntries(filteredEntries);
    return { ...s, users: new Set(filteredEntries.map((e) => e.userId)).size };
  }, [filteredEntries]);

  const userAggregates = useMemo(() => {
    const source =
      serverByUser.length > 0
        ? serverByUser
        : []; /* ranking always prefer server aggregate (full ledger) */
    if (!q) return source;
    return source.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        String(u.userId).includes(q)
    );
  }, [serverByUser, q]);

  const filteredUserTotals = useMemo((): Totals => {
    let ops = 0;
    let grossUsdc = 0;
    let feeUsdc = 0;
    let netUsdc = 0;
    for (const u of userAggregates) {
      ops += u.ops;
      grossUsdc += u.grossUsdc;
      feeUsdc += u.feeUsdc;
      netUsdc += u.netUsdc;
    }
    return { ops, users: userAggregates.length, grossUsdc, feeUsdc, netUsdc };
  }, [userAggregates]);

  const openUserDetail = useCallback(async (agg: AdminReinvestmentUserAggregate) => {
    setSelectedUser(agg);
    setViewMode('user_detail');
    setUserLoading(true);
    setUserError(null);
    setUserHistory([]);
    try {
      const res = await getAdminUserReinvestmentHistory(agg.userId);
      if (!res.ok) {
        setUserError(res.error || ADMIN_REINVESTMENT_USER_LOAD_ERROR);
        setUserHistory([]);
        return;
      }
      setUserHistory(res.history);
    } catch {
      setUserError(ADMIN_REINVESTMENT_USER_LOAD_ERROR);
      setUserHistory([]);
    } finally {
      setUserLoading(false);
    }
  }, []);

  const userDetailTotals = useMemo((): Totals => {
    const s = sumEntries(userHistory);
    return { ...s, users: userHistory.length > 0 ? 1 : 0 };
  }, [userHistory]);

  const backFromUser = () => {
    setSelectedUser(null);
    setUserHistory([]);
    setUserError(null);
    setViewMode('by_user');
  };

  const overviewTotalsTitle = q ? 'Totais (filtro na lista recente)' : 'Totais gerais (ledger completo)';
  const overviewTotals = q ? filteredTotals : globalTotals;
  const byUserTotalsTitle = q ? 'Totais (utilizadores filtrados)' : 'Totais gerais (ledger completo)';
  const byUserTotals = q ? filteredUserTotals : globalTotals;

  return (
    <div className="space-y-6 p-1">
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        Liquidações do desk (cripto minerada → USDC in-app). Os totais e o ranking respeitam o
        período escolhido
        {report?.totals.minAt
          ? ` (dados no filtro: ${formatDate(report.totals.minAt)} → ${formatDate(report.totals.maxAt)})`
          : ''}
        . A tabela «Todas as liquidações» mostra as {report?.itemsLimit ?? 0} mais recentes
        {report?.itemsTruncated ? ' (truncada — usa «Por utilizador» para o total real)' : ''}.
      </div>

      <form
        className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          applyDateFilter();
        }}
      >
        <p className="text-sm font-bold text-white">Período</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={clearDateFilter}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-colors ${
              !appliedFromMs && !appliedToMs
                ? 'bg-amber-600/20 text-white border-amber-600/50'
                : 'text-slate-400 border-slate-700 hover:text-white'
            }`}
          >
            Tudo
          </button>
          <button
            type="button"
            onClick={presetToday}
            className="px-3 py-1.5 text-xs font-bold rounded-lg border text-slate-400 border-slate-700 hover:text-white transition-colors"
          >
            Hoje
          </button>
          <button
            type="button"
            onClick={presetThisMonth}
            className="px-3 py-1.5 text-xs font-bold rounded-lg border text-slate-400 border-slate-700 hover:text-white transition-colors"
          >
            Este mês
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 items-end">
          <label className="text-sm text-slate-300 font-semibold">
            Desde
            <input
              type="datetime-local"
              value={fromLocal}
              onChange={(e) => setFromLocal(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-normal text-slate-100"
            />
          </label>
          <label className="text-sm text-slate-300 font-semibold">
            Até
            <input
              type="datetime-local"
              value={toLocal}
              onChange={(e) => setToLocal(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-normal text-slate-100"
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg text-sm font-bold"
          >
            Aplicar período
          </button>
          <button
            type="button"
            onClick={clearDateFilter}
            disabled={loading}
            className="px-4 py-2 border border-slate-700 text-slate-300 hover:text-white rounded-lg text-sm font-bold disabled:opacity-50"
          >
            Limpar datas
          </button>
        </div>
      </form>

      <TotalsCards
        totals={viewMode === 'by_user' || viewMode === 'user_detail' ? byUserTotals : overviewTotals}
        title={
          viewMode === 'by_user' || viewMode === 'user_detail'
            ? byUserTotalsTitle
            : overviewTotalsTitle
        }
      />

      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setViewMode('overview');
              setSelectedUser(null);
            }}
            className={`px-3 py-1.5 text-sm font-bold rounded-lg border transition-colors ${
              viewMode === 'overview'
                ? 'bg-amber-600/20 text-white border-amber-600/50'
                : 'text-slate-400 border-slate-700 hover:text-white'
            }`}
          >
            Todas as liquidações
          </button>
          <button
            type="button"
            onClick={() => {
              setViewMode('by_user');
              setSelectedUser(null);
            }}
            className={`px-3 py-1.5 text-sm font-bold rounded-lg border transition-colors inline-flex items-center gap-1.5 ${
              viewMode === 'by_user' || viewMode === 'user_detail'
                ? 'bg-amber-600/20 text-white border-amber-600/50'
                : 'text-slate-400 border-slate-700 hover:text-white'
            }`}
          >
            <Users size={14} />
            Por utilizador
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 flex-1 lg:max-w-xl lg:justify-end">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              type="text"
              placeholder="Buscar user, id, email ou moeda…"
              value={searchTerm}
              maxLength={ADMIN_SHOP_SEARCH_MAX}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 text-slate-100"
            />
          </div>
          <button
            type="button"
            onClick={() => void load(appliedFromMs, appliedToMs)}
            disabled={loading}
            className="flex items-center justify-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg text-sm font-bold transition-all"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Atualizando…' : 'Atualizar'}
          </button>
        </div>
      </div>

      {loadError ? <div className="text-sm text-amber-300">{loadError}</div> : null}

      {viewMode === 'user_detail' && selectedUser ? (
        <div className="space-y-4">
          <button
            type="button"
            onClick={backFromUser}
            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-300 hover:text-white"
          >
            <ArrowLeft size={16} />
            Voltar ao ranking de utilizadores
          </button>

          <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
            <h3 className="text-lg font-black text-white">
              {selectedUser.username || `User #${selectedUser.userId}`}
            </h3>
            <p className="text-sm text-slate-400 mt-1">
              #{selectedUser.userId}
              {selectedUser.email ? ` · ${selectedUser.email}` : ''}
            </p>
          </div>

          <TotalsCards totals={userDetailTotals} title="Reinvestimento geral deste utilizador" />

          {userError ? <div className="text-sm text-amber-300">{userError}</div> : null}

          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center gap-2">
              <History className="text-amber-500" size={20} />
              <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wide">
                Histórico do utilizador
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[700px]">
                <thead>
                  <tr className="bg-slate-950 text-slate-400 text-[10px] uppercase tracking-wider font-bold">
                    <th className="px-4 py-3">Data</th>
                    <th className="px-4 py-3">Moeda</th>
                    <th className="px-4 py-3">Vendido</th>
                    <th className="px-4 py-3">Bruto</th>
                    <th className="px-4 py-3">Taxa</th>
                    <th className="px-4 py-3">Líquido</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {userLoading ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-slate-500 text-sm italic">
                        A carregar histórico…
                      </td>
                    </tr>
                  ) : userHistory.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-slate-500 text-sm italic">
                        {userError || 'Sem liquidações para este utilizador.'}
                      </td>
                    </tr>
                  ) : (
                    userHistory.map((row) => (
                      <tr key={row.id} className="hover:bg-slate-800/50">
                        <td className="px-4 py-3 text-xs font-mono text-slate-400 whitespace-nowrap">
                          {formatDate(row.createdAt)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1 text-sm font-bold text-slate-200">
                            <Coins size={14} className="text-amber-500" />
                            {coinLabel(row)}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-sm text-slate-200">
                          {formatMinedCoinAmount(row.soldCrypto)}
                        </td>
                        <td className="px-4 py-3 font-mono text-sm text-green-400">
                          {formatUsdcAmount(row.grossUsdc, 'pt-BR')}
                        </td>
                        <td className="px-4 py-3 font-mono text-sm text-red-400">
                          {formatUsdcAmount(row.feeUsdc, 'pt-BR')}
                        </td>
                        <td className="px-4 py-3 font-mono text-sm font-black text-amber-400">
                          <span className="inline-flex items-center gap-1">
                            <DollarSign size={14} />
                            {formatUsdcAmount(row.netUsdc, 'pt-BR')}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {viewMode === 'by_user' ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
          <div className="px-6 py-4 border-b border-slate-800 flex items-center gap-2">
            <Users className="text-amber-500" size={20} />
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wide">
              Ranking por utilizador — clica para ver o histórico
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr className="bg-slate-950 text-slate-400 text-[10px] uppercase tracking-wider font-bold">
                  <th className="px-4 py-3">Utilizador</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Ops</th>
                  <th className="px-4 py-3">Bruto</th>
                  <th className="px-4 py-3">Taxa</th>
                  <th className="px-4 py-3">Líquido</th>
                  <th className="px-4 py-3">Última</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {userAggregates.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-slate-500 text-sm italic">
                      {loading
                        ? 'Carregando…'
                        : loadError
                          ? loadError
                          : 'Nenhum utilizador com reinvestimento no filtro.'}
                    </td>
                  </tr>
                ) : (
                  userAggregates.map((u) => (
                    <tr
                      key={u.userId}
                      className="hover:bg-slate-800/50 cursor-pointer transition-colors"
                      onClick={() => void openUserDetail(u)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          void openUserDetail(u);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                    >
                      <td className="px-4 py-3 text-sm font-bold text-slate-100">
                        {u.username || `#${u.userId}`}
                        <span className="ml-2 text-xs font-mono text-slate-500">#{u.userId}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">{u.email || '—'}</td>
                      <td className="px-4 py-3 font-mono text-sm text-slate-200">{u.ops}</td>
                      <td className="px-4 py-3 font-mono text-sm text-green-400">
                        {formatUsdcAmount(u.grossUsdc, 'pt-BR')}
                      </td>
                      <td className="px-4 py-3 font-mono text-sm text-red-400">
                        {formatUsdcAmount(u.feeUsdc, 'pt-BR')}
                      </td>
                      <td className="px-4 py-3 font-mono text-sm font-black text-amber-400">
                        {formatUsdcAmount(u.netUsdc, 'pt-BR')}
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-400 whitespace-nowrap">
                        {formatDate(u.lastAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {viewMode === 'overview' ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
          <div className="px-6 py-4 border-b border-slate-800 flex items-center gap-2">
            <History className="text-amber-500" size={20} />
            <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wide">
              Liquidações recentes
              {report?.itemsTruncated
                ? ` (top ${report.itemsLimit} de ${globalTotals.ops.toLocaleString('pt-BR')})`
                : ''}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[900px]">
              <thead>
                <tr className="bg-slate-950 text-slate-400 text-[10px] uppercase tracking-wider font-bold">
                  <th className="px-4 py-3">Data</th>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Moeda</th>
                  <th className="px-4 py-3">Vendido</th>
                  <th className="px-4 py-3">Bruto</th>
                  <th className="px-4 py-3">Taxa</th>
                  <th className="px-4 py-3">Líquido</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {filteredEntries.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-12 text-center text-slate-500 text-sm italic">
                      {loading
                        ? 'Carregando reinvestimentos…'
                        : loadError
                          ? loadError
                          : 'Nenhum reinvestimento encontrado.'}
                    </td>
                  </tr>
                ) : (
                  filteredEntries.map((row: AdminReinvestmentHistoryEntry) => (
                    <tr key={row.id} className="hover:bg-slate-800/50 transition-colors">
                      <td className="px-4 py-3 text-xs font-mono text-slate-400 whitespace-nowrap">
                        {formatDate(row.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="text-sm font-bold text-sky-300 hover:text-sky-200 underline-offset-2 hover:underline"
                          onClick={() =>
                            void openUserDetail({
                              userId: row.userId,
                              username: row.username,
                              email: row.email,
                              ops: 0,
                              grossUsdc: 0,
                              feeUsdc: 0,
                              netUsdc: 0,
                              lastAt: row.createdAt
                            })
                          }
                        >
                          {row.username || `#${row.userId}`}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">{row.email}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-sm font-bold font-mono text-slate-200">
                          <Coins size={14} className="text-amber-500" />
                          {coinLabel(row)}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-sm text-slate-200">
                        {formatMinedCoinAmount(row.soldCrypto)}
                      </td>
                      <td className="px-4 py-3 font-mono text-sm text-green-400">
                        {formatUsdcAmount(row.grossUsdc, 'pt-BR')}
                      </td>
                      <td className="px-4 py-3 font-mono text-sm text-red-400">
                        {formatUsdcAmount(row.feeUsdc, 'pt-BR')}
                      </td>
                      <td className="px-4 py-3 font-mono text-sm font-black text-amber-400">
                        {formatUsdcAmount(row.netUsdc, 'pt-BR')}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
};
