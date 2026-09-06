/**
 * Aba Métricas — utilizadores activos (DAU/WAU/MAU), cadastros e tendência diária.
 * Snapshot sob pedido (mount + botão Atualizar).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  Calendar,
  CalendarDays,
  CalendarRange,
  Cpu,
  RefreshCw,
  UserCheck,
  UserPlus,
  Users,
  Wallet
} from 'lucide-react';
import { getAdminSiteMetrics, type AdminSiteMetrics } from '../../../shared/api/admin-dashboard';

const EMPTY: AdminSiteMetrics = {
  generatedAtMs: 0,
  registeredUsers: 0,
  deactivatedUsers: 0,
  onlineUsers: 0,
  dau: 0,
  wau: 0,
  mau: 0,
  signupsToday: 0,
  signupsThisWeek: 0,
  signupsThisMonth: 0,
  totalAccounts: 0,
  adminAccounts: 0,
  usersWithWallet: 0,
  usersMiningNow: 0,
  dailySeries: []
};

function fmt(n: number): string {
  return n.toLocaleString('pt-PT');
}

function fmtPct(part: number, total: number): string {
  if (total <= 0) return '—';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function MetricCard({
  title,
  value,
  subtitle,
  icon,
  accent = 'text-white'
}: {
  title: string;
  value: string | number;
  subtitle?: ReactNode;
  icon: ReactNode;
  accent?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-slate-800 p-6">
      <div className="absolute right-4 top-4 text-slate-700">{icon}</div>
      <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400">{title}</h3>
      <div className={`mt-2 text-4xl font-bold ${accent}`}>{value}</div>
      {subtitle ? <div className="mt-2 text-xs text-slate-500">{subtitle}</div> : null}
    </div>
  );
}

export function AdminMetrics() {
  const [stats, setStats] = useState<AdminSiteMetrics>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [loadedOk, setLoadedOk] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const data = await getAdminSiteMetrics();
    if (!data) {
      setError(
        'Não foi possível carregar /api/admin/metrics (resposta vazia ou erro). Confira os logs do servidor.'
      );
      setLoadedOk(false);
      return;
    }
    setError(null);
    setLoadedOk(true);
    setStats(data);
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

  const maxActive = Math.max(1, ...stats.dailySeries.map((d) => d.activeUsers));
  const maxSignups = Math.max(1, ...stats.dailySeries.map((d) => d.signups));

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 space-y-6">
      {error && (
        <div className="rounded-xl border border-amber-600/50 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
          <span className="font-bold text-amber-400">Métricas:</span> {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500" aria-live="polite">
        <span
          className={`inline-block h-2 w-2 rounded-full ${loadedOk ? 'bg-emerald-500' : 'bg-amber-600'}`}
          title={loadedOk ? 'Snapshot carregado' : 'A carregar…'}
        />
        <span>{loadedOk ? 'Métricas (snapshot sob pedido)' : 'A carregar métricas…'}</span>
        {loadedOk && stats.generatedAtMs > 0 && (
          <span className="text-slate-600">
            · {new Date(stats.generatedAtMs).toLocaleString('pt-PT')} (UTC local do browser)
          </span>
        )}
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

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Usuários Cadastrados"
          value={fmt(stats.registeredUsers)}
          accent="text-white"
          icon={<Users size={64} />}
          subtitle={
            <span className="flex flex-wrap items-center gap-1 text-green-500">
              <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
              {fmt(stats.onlineUsers)} online (últimos 5 min)
              {stats.deactivatedUsers > 0 && (
                <span className="text-slate-500">
                  · {fmt(stats.deactivatedUsers)} desactivados excluídos
                </span>
              )}
            </span>
          }
        />

        <MetricCard
          title="Activos hoje (DAU)"
          value={fmt(stats.dau)}
          accent="text-sky-400"
          icon={<Activity size={64} />}
          subtitle={
            <>
              {fmtPct(stats.dau, stats.registeredUsers)} dos cadastrados · sessão com actividade nas
              últimas 24h (UTC)
            </>
          }
        />

        <MetricCard
          title="Activos 7 dias (WAU)"
          value={fmt(stats.wau)}
          accent="text-violet-400"
          icon={<CalendarDays size={64} />}
          subtitle={fmtPct(stats.wau, stats.registeredUsers) + ' dos cadastrados'}
        />

        <MetricCard
          title="Activos 30 dias (MAU)"
          value={fmt(stats.mau)}
          accent="text-amber-400"
          icon={<CalendarRange size={64} />}
          subtitle={fmtPct(stats.mau, stats.registeredUsers) + ' dos cadastrados'}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Cadastros hoje"
          value={fmt(stats.signupsToday)}
          accent="text-emerald-400"
          icon={<UserPlus size={64} />}
          subtitle="Novas contas (proxy: game_states.start_time)"
        />

        <MetricCard
          title="Cadastros esta semana"
          value={fmt(stats.signupsThisWeek)}
          accent="text-emerald-300"
          icon={<Calendar size={64} />}
          subtitle="Semana UTC (segunda → domingo)"
        />

        <MetricCard
          title="Cadastros este mês"
          value={fmt(stats.signupsThisMonth)}
          accent="text-emerald-200"
          icon={<CalendarRange size={64} />}
          subtitle="Mês civil UTC"
        />

        <MetricCard
          title="Com carteira Polygon"
          value={fmt(stats.usersWithWallet)}
          accent="text-fuchsia-400"
          icon={<Wallet size={64} />}
          subtitle={fmtPct(stats.usersWithWallet, stats.registeredUsers) + ' dos cadastrados'}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <MetricCard
          title="A minerar agora"
          value={fmt(stats.usersMiningNow)}
          accent="text-yellow-400"
          icon={<Cpu size={64} />}
          subtitle="Jogadores com pelo menos 1 rig ligada (is_on=1)"
        />

        <MetricCard
          title="Total de contas"
          value={fmt(stats.totalAccounts)}
          accent="text-slate-200"
          icon={<Users size={64} />}
          subtitle={
            <>
              Inclui admins ({fmt(stats.adminAccounts)}) e desactivados (
              {fmt(stats.deactivatedUsers)})
            </>
          }
        />

        <MetricCard
          title="Taxa DAU / MAU"
          value={stats.mau > 0 ? fmtPct(stats.dau, stats.mau).replace('%', '') + '%' : '—'}
          accent="text-cyan-400"
          icon={<UserCheck size={64} />}
          subtitle="Stickiness: utilizadores activos hoje vs. últimos 30 dias"
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-800">
        <div className="border-b border-slate-700 bg-slate-900/50 px-4 py-3">
          <h3 className="font-bold text-white">Últimos 14 dias (UTC)</h3>
          <p className="mt-1 text-xs text-slate-500">
            Barras = utilizadores únicos activos por dia · número = cadastros no dia
          </p>
        </div>
        <div className="overflow-x-auto p-4">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Data</th>
                <th className="px-3 py-2 text-right">Activos</th>
                <th className="px-3 py-2">Tendência</th>
                <th className="px-3 py-2 text-right">Cadastros</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {[...stats.dailySeries].reverse().map((row) => (
                <tr key={row.date} className="hover:bg-slate-900/40">
                  <td className="px-3 py-2 font-mono text-xs text-slate-300">{row.date}</td>
                  <td className="px-3 py-2 text-right font-bold text-sky-300">{fmt(row.activeUsers)}</td>
                  <td className="px-3 py-2">
                    <div className="flex h-5 items-center gap-2">
                      <div className="h-2 flex-1 max-w-[200px] overflow-hidden rounded-full bg-slate-900">
                        <div
                          className="h-full rounded-full bg-sky-600/80"
                          style={{ width: `${Math.round((row.activeUsers / maxActive) * 100)}%` }}
                        />
                      </div>
                      {row.signups > 0 && (
                        <div className="h-2 w-16 overflow-hidden rounded-full bg-slate-900">
                          <div
                            className="h-full rounded-full bg-emerald-600/80"
                            style={{ width: `${Math.round((row.signups / maxSignups) * 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-emerald-400">
                    {row.signups > 0 ? `+${fmt(row.signups)}` : '—'}
                  </td>
                </tr>
              ))}
              {stats.dailySeries.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center italic text-slate-500">
                    Sem dados de série temporal.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-slate-600">
        Jogadores activos: contas não-admin e não bloqueadas com{' '}
        <span className="font-mono text-slate-500">sessions.last_seen_at</span> (ou criação da sessão)
        dentro da janela. Online (5 min) exige sessão ainda válida — igual ao Dashboard. Cadastros usam{' '}
        <span className="font-mono text-slate-500">game_states.start_time</span> como data de criação.
      </p>
    </div>
  );
}
