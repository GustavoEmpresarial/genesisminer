/**
 * Admin Dashboard — layout/copy do legado `AdminDashboard.tsx`.
 * Fetch sob pedido (mount + após exclusão de ranking). Sem poll / WS.
 * Depósitos on-chain (Etherscan) ficam para quando a rota treasury existir.
 */
import { useCallback, useEffect, useState } from 'react';
import { Clock, DollarSign, Download, Eye, EyeOff, RefreshCw, Trophy, Users, Zap } from 'lucide-react';
import {
  getAdminDashboardStats,
  toggleRankingExclusion,
  type AdminDashboardStats
} from '../../../shared/api/admin-dashboard';

type DashState = {
  totalUsers: number;
  deactivatedUsers: number;
  onlineUsers: number;
  totalHashrate: number;
  top10: { username: string; email: string; power: number }[];
  rankingExcluded: { username: string; email: string; id?: number; isAdmin?: boolean }[];
  last10: { username: string; email: string }[];
  totalDeposited: number;
  dbTotalDeposited: number;
  depositDisplayMode: 'chain' | 'db';
  topDeposits: { username: string; email: string; amount: number }[];
  totalWithdrawn: number;
  topWithdrawalsByCoin: Array<{
    coinId: string;
    coinName: string;
    top: { username: string; email: string; total: number }[];
  }>;
};

const EMPTY: DashState = {
  totalUsers: 0,
  deactivatedUsers: 0,
  onlineUsers: 0,
  totalHashrate: 0,
  top10: [],
  rankingExcluded: [],
  last10: [],
  totalDeposited: 0,
  dbTotalDeposited: 0,
  depositDisplayMode: 'db',
  topDeposits: [],
  totalWithdrawn: 0,
  topWithdrawalsByCoin: []
};

function mapExcluded(data: AdminDashboardStats) {
  return Array.isArray(data.rankingExcluded)
    ? data.rankingExcluded.map((row) => ({
        id: row.id != null ? Number(row.id) : undefined,
        username: String(row.username ?? ''),
        email: String(row.email ?? ''),
        isAdmin: Boolean(row.isAdmin ?? Number(row.is_admin) === 1)
      }))
    : [];
}

function applyServerDashboard(data: AdminDashboardStats): DashState {
  return {
    totalUsers: data.totalUsers,
    deactivatedUsers: Number(data.deactivatedUsers) || 0,
    onlineUsers: data.onlineUsers,
    dbTotalDeposited: data.totalDeposited,
    totalDeposited: data.totalDeposited,
    depositDisplayMode: 'db',
    totalWithdrawn: data.totalWithdrawn,
    last10: data.last10 || [],
    topDeposits: data.topDeposits || [],
    topWithdrawalsByCoin: data.topWithdrawalsByCoin || [],
    totalHashrate: data.globalPower || 0,
    top10: (data.topMiners || []).map((m) => ({
      username: m.username,
      email: m.email,
      power: m.amount
    })),
    rankingExcluded: mapExcluded(data)
  };
}

export function AdminDashboard() {
  const [stats, setStats] = useState<DashState>(EMPTY);
  const [selectedCoinId, setSelectedCoinId] = useState('');
  const [miningCoins, setMiningCoins] = useState<{ id: string; name: string }[]>([]);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [loadedOk, setLoadedOk] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const data = await getAdminDashboardStats();
    if (!data) {
      setStatsError(
        'Não foi possível carregar /api/admin/dashboard-stats (resposta vazia ou erro). Confira os logs do servidor.'
      );
      setLoadedOk(false);
      return;
    }
    setStatsError(null);
    setLoadedOk(true);
    setStats(applyServerDashboard(data));
    const coins =
      Array.isArray(data.miningCoins) && data.miningCoins.length > 0
        ? data.miningCoins
        : (data.topWithdrawalsByCoin || []).map((c) => ({ id: c.coinId, name: c.coinName }));
    setMiningCoins(coins);
    setSelectedCoinId((prev) => prev || (coins[0]?.id ?? ''));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshManual = async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const refreshAfterExclusion = async () => {
    const data = await getAdminDashboardStats();
    if (!data) return;
    setStats((prev) => ({
      ...prev,
      totalUsers: data.totalUsers,
      onlineUsers: data.onlineUsers,
      totalHashrate: data.globalPower || 0,
      top10: (data.topMiners || []).map((m) => ({
        username: m.username,
        email: m.email,
        power: m.amount
      })),
      rankingExcluded: mapExcluded(data)
    }));
  };

  const formatHash = (val: number) => {
    if (val === 0) return '0 H/s';
    if (val < 0.0001) return `${val.toFixed(8)} H/s`;
    return `${Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(val)} H/s`;
  };
  const formatMoney = (val: number) => {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2
      }).format(val);
    } catch {
      return `$${val.toFixed(2)}`;
    }
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 space-y-6">
      {statsError && (
        <div className="rounded-xl border border-amber-600/50 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
          <span className="font-bold text-amber-400">Dashboard:</span> {statsError}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500" aria-live="polite">
        <span
          className={`inline-block h-2 w-2 rounded-full ${loadedOk ? 'bg-emerald-500' : 'bg-amber-600'}`}
          title={loadedOk ? 'Snapshot carregado' : 'A carregar…'}
        />
        <span>{loadedOk ? 'Métricas (snapshot sob pedido)' : 'A carregar métricas…'}</span>
        <button
          type="button"
          onClick={() => void refreshManual()}
          disabled={refreshing}
          className="inline-flex items-center gap-1 rounded border border-slate-600 px-2 py-1 font-semibold text-slate-300 transition hover:bg-slate-700 disabled:opacity-50"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          Atualizar
        </button>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-4">
        <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-slate-800 p-6">
          <Users className="absolute right-4 top-4 text-slate-700" size={64} />
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400">Usuários Cadastrados</h3>
          <div className="mt-2 text-4xl font-bold text-white">{stats.totalUsers}</div>
          <div
            className="mt-2 flex flex-wrap items-center gap-1 text-xs text-green-500"
            title="Contas jogador (não-admin, não desactivadas) com sessão válida e last_seen nos últimos 5 minutos."
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
            {stats.onlineUsers} online (últimos 5 min)
            {stats.deactivatedUsers > 0 && (
              <span className="text-slate-500">
                · {stats.deactivatedUsers.toLocaleString('pt-PT')} desactivados excluídos
              </span>
            )}
          </div>
        </div>

        <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-slate-800 p-6">
          <Zap className="absolute right-4 top-4 text-yellow-900/50" size={64} />
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400">
            Poder de Mineração Global
          </h3>
          <div className="mt-2 text-4xl font-bold text-yellow-500">{formatHash(stats.totalHashrate)}</div>
          <div className="mt-2 text-xs text-slate-500">Soma de todos os jogadores</div>
        </div>

        <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-slate-800 p-6">
          <DollarSign className="absolute right-4 top-4 text-green-900/50" size={64} />
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400">USDC Depositado</h3>
          <div className="mt-2 text-4xl font-bold text-green-500">{formatMoney(stats.totalDeposited)}</div>
          <p className="mt-2 text-[11px] leading-snug text-slate-500">
            Soma de <span className="text-slate-400">total_usdc_deposited</span> na base (registo interno do
            jogo). On-chain (Etherscan) quando a rota treasury for portada.
          </p>
        </div>

        <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-slate-800 p-6">
          <Download className="absolute right-4 top-4 text-red-900/50" size={64} />
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400">Criptos Sacadas</h3>
          <div className="mt-2 text-4xl font-bold text-red-500">{formatMoney(stats.totalWithdrawn)}</div>
          <div className="mt-2 text-xs text-slate-500">Soma de saques em todas moedas</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-800">
          <div className="flex items-center justify-between border-b border-slate-700 bg-slate-900/50 p-4">
            <h3 className="flex items-center gap-2 font-bold text-white">
              <Clock size={18} className="text-amber-500" /> Últimos Registros
            </h3>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900/30 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Usuário</th>
                <th className="px-4 py-2 text-right">Email</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {stats.last10.map((u, i) => (
                <tr key={i} className="hover:bg-slate-700/30">
                  <td className="px-4 py-2 font-bold text-slate-200">{u.username}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-slate-400">{u.email}</td>
                </tr>
              ))}
              {stats.last10.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-4 py-4 text-center italic text-slate-500">
                    Sem registros recentes.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-800">
          <div className="flex items-center justify-between border-b border-slate-700 bg-slate-900/50 p-4">
            <h3 className="flex items-center gap-2 font-bold text-white">
              <Trophy size={18} className="text-yellow-500" /> Top 10 Mineradores
            </h3>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900/30 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Rank</th>
                <th className="px-4 py-2">Usuário</th>
                <th className="px-4 py-2 text-right">Hashrate de Mineração</th>
                <th className="px-4 py-2 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {stats.top10.map((item, i) => (
                <tr key={i} className={`hover:bg-slate-700/30 ${i === 0 ? 'bg-yellow-900/10' : ''}`}>
                  <td className="px-4 py-2">
                    {i === 0 && <span className="font-bold text-yellow-500">#1</span>}
                    {i === 1 && <span className="font-bold text-slate-300">#2</span>}
                    {i === 2 && <span className="font-bold text-orange-400">#3</span>}
                    {i > 2 && <span className="text-slate-500">#{i + 1}</span>}
                  </td>
                  <td className="px-4 py-2">
                    <div className="font-bold text-slate-200">{item.username}</div>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-yellow-400">
                    {formatHash(item.power)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={async () => {
                        if (
                          !window.confirm(
                            `Ocultar ${item.username} do ranking público? Você pode voltar a mostrar na seção abaixo.`
                          )
                        )
                          return;
                        const r = await toggleRankingExclusion(item.email, true);
                        if (!r.ok) {
                          alert(r.error || 'Falha ao atualizar');
                          return;
                        }
                        await refreshAfterExclusion();
                      }}
                      className="text-slate-500 hover:text-red-400"
                      title="Ocultar do ranking público"
                    >
                      <EyeOff size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {stats.top10.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-center italic text-slate-500">
                    Sem mineradores ativos.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {stats.rankingExcluded.length > 0 && (
            <div className="border-t border-slate-700 bg-slate-900/40 p-4">
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">
                Ocultos do ranking ({stats.rankingExcluded.length})
              </h4>
              <p className="mb-3 text-xs text-slate-500">
                Estas contas não aparecem no leaderboard público. Clica no olho para voltarem ao ranking.
              </p>
              <ul className="max-h-48 space-y-2 overflow-y-auto">
                {stats.rankingExcluded.map((row) => (
                  <li
                    key={row.id ?? row.email ?? row.username}
                    className="flex items-center justify-between gap-2 text-sm text-slate-300"
                  >
                    <span className="truncate">
                      <span className="font-semibold text-slate-200">{row.username}</span>{' '}
                      {row.isAdmin ? (
                        <span className="text-[10px] font-bold uppercase text-red-400/90">Admin</span>
                      ) : null}{' '}
                      <span className="text-xs text-slate-500">{row.email}</span>
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!window.confirm(`Mostrar ${row.username} de novo no ranking?`)) return;
                        const r = await toggleRankingExclusion(row.email, false);
                        if (!r.ok) {
                          alert(r.error || 'Falha ao atualizar');
                          return;
                        }
                        await refreshAfterExclusion();
                      }}
                      className="shrink-0 rounded p-1.5 text-slate-500 hover:bg-slate-700/50 hover:text-emerald-400"
                      title="Voltar a mostrar no ranking"
                    >
                      <Eye size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-800">
          <div className="flex items-center justify-between border-b border-slate-700 bg-slate-900/50 p-4">
            <h3 className="flex items-center gap-2 font-bold text-white">
              <DollarSign size={18} className="text-green-500" /> Top 10 Depósitos USDC
            </h3>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900/30 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Rank</th>
                <th className="px-4 py-2">Usuário</th>
                <th className="px-4 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {stats.topDeposits.map((item, i) => (
                <tr key={i} className={`hover:bg-slate-700/30 ${i === 0 ? 'bg-green-900/10' : ''}`}>
                  <td className="px-4 py-2">
                    {i === 0 && <span className="font-bold text-green-500">#1</span>}
                    {i === 1 && <span className="font-bold text-slate-300">#2</span>}
                    {i === 2 && <span className="font-bold text-green-400">#3</span>}
                    {i > 2 && <span className="text-slate-500">#{i + 1}</span>}
                  </td>
                  <td className="px-4 py-2 font-bold text-slate-200">{item.username}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-green-400">
                    {formatMoney(item.amount)}
                  </td>
                </tr>
              ))}
              {stats.topDeposits.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-4 text-center italic text-slate-500">
                    Sem depósitos registrados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-800">
          <div className="flex items-center justify-between border-b border-slate-700 bg-slate-900/50 p-4">
            <h3 className="flex items-center gap-2 font-bold text-white">
              <Download size={18} className="text-red-500" /> Top 10 Saques •{' '}
              {miningCoins.find((c) => c.id === selectedCoinId)?.name || '—'}
            </h3>
            <select
              value={selectedCoinId}
              onChange={(e) => setSelectedCoinId(e.target.value)}
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
            >
              {miningCoins.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900/30 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Rank</th>
                <th className="px-4 py-2">Usuário</th>
                <th className="px-4 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {(stats.topWithdrawalsByCoin.find((c) => c.coinId === selectedCoinId)?.top || []).map(
                (item, i) => (
                  <tr key={i} className={`hover:bg-slate-700/30 ${i === 0 ? 'bg-red-900/10' : ''}`}>
                    <td className="px-4 py-2">
                      {i === 0 && <span className="font-bold text-red-500">#1</span>}
                      {i === 1 && <span className="font-bold text-slate-300">#2</span>}
                      {i === 2 && <span className="font-bold text-orange-400">#3</span>}
                      {i > 2 && <span className="text-slate-500">#{i + 1}</span>}
                    </td>
                    <td className="px-4 py-2 font-bold text-slate-200">{item.username}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-red-400">
                      {formatMoney(item.total)}
                    </td>
                  </tr>
                )
              )}
              {(stats.topWithdrawalsByCoin.find((c) => c.coinId === selectedCoinId)?.top || []).length ===
                0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-4 text-center italic text-slate-500">
                    Sem saques registrados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
