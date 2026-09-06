import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Share2, Users, TrendingUp, Sparkles, Clock, ChevronRight, History } from 'lucide-react';
import { getReferralOverview, type ReferralOverview } from '../../../shared/api/profile';
import { useT } from '../../../shared/i18n';

function formatUsdc(n: number, opts?: { hideZeroDecimals?: boolean }): string {
  if (!Number.isFinite(n)) return '0.00';
  if (Math.abs(n) >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n === 0) return opts?.hideZeroDecimals ? '0' : '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    return new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return '—';
  }
}

function describeReferred(u: { username: string | null; emailMasked: string | null }): string {
  return (u.username && u.username.trim()) || u.emailMasked || 'Operador';
}

type Props = {
  /** Sinal para forçar reload (ex.: após vincular código). */
  reloadNonce?: number;
};

/**
 * Painel de resumo + histórico do Programa Genesis Referral.
 * Lê de `/api/profile/referral/overview` (idempotente) e renderiza cards de
 * resumo, lista de indicados e histórico de comissões.
 */
export const ReferralOverviewPanel: React.FC<Props> = ({ reloadNonce = 0 }) => {
  const t = useT();
  const [data, setData] = useState<ReferralOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await getReferralOverview();
      if (!r) {
        setErr('Não foi possível carregar o histórico de indicações.');
        setData(null);
      } else {
        setData(r);
      }
    } catch {
      setErr('Erro de rede ao carregar indicações.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, reloadNonce]);

  const summary = useMemo(() => {
    if (!data) return null;
    const stats = data.stats ?? {
      invitedCount: 0,
      totalReferredDepositsUsdc: 0,
      totalCommissionUsdc: 0,
      pendingCommissionUsdc: 0,
      commissionRate: 0,
      commissionPercent: 0
    };
    return {
      invited: Number(stats.invitedCount) || 0,
      totalDeposits: Number(stats.totalReferredDepositsUsdc) || 0,
      totalCommission: Number(stats.totalCommissionUsdc) || 0,
      pending: Number(stats.pendingCommissionUsdc) || 0,
      rate: Number(stats.commissionRate) || 0,
      percent: Number(stats.commissionPercent) || 0
    };
  }, [data]);

  if (loading && !data) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles size={18} className="text-amber-500" />
          <h3 className="text-lg font-bold text-slate-800 dark:text-white">{t('profile.programHistory')}</h3>
        </div>
        <div className="py-8 text-center text-slate-500 dark:text-slate-400 animate-pulse text-sm">
          {t('profile.loadingReferralHistory')}
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-red-300 dark:border-red-800/60 rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles size={18} className="text-red-500" />
          <h3 className="text-lg font-bold text-slate-800 dark:text-white">{t('profile.programHistory')}</h3>
        </div>
        <p className="text-sm text-rose-500 dark:text-rose-300">{err}</p>
        <button
          type="button"
          onClick={() => void reload()}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold px-3 py-1.5"
        >
          {t('profile.tryAgain')}
        </button>
      </div>
    );
  }

  if (!summary || !data) return null;

  const cards: Array<{ label: string; value: string; hint?: string; icon: React.ReactNode; tint: string }> = [
    {
      label: t('profile.invitedOperators'),
      value: String(summary.invited),
      icon: <Users size={16} />,
      tint: 'from-amber-500/10 to-orange-500/10 border-amber-200 dark:border-amber-800/60 text-amber-700 dark:text-amber-300'
    },
    {
      label: 'Total depositado pelos indicados',
      value: `$${formatUsdc(summary.totalDeposits)}`,
      hint: 'soma dos depósitos USDC creditados aos indicados',
      icon: <TrendingUp size={16} />,
      tint: 'from-emerald-500/10 to-green-500/10 border-emerald-200 dark:border-emerald-800/60 text-emerald-700 dark:text-emerald-300'
    },
    {
      label: 'Comissão total recebida',
      value: `$${formatUsdc(summary.totalCommission)}`,
      hint: `Taxa actual: ${summary.percent}%`,
      icon: <Sparkles size={16} />,
      tint: 'from-violet-500/10 to-fuchsia-500/10 border-violet-200 dark:border-violet-800/60 text-violet-700 dark:text-violet-300'
    },
    {
      label: 'Comissão pendente',
      value: `$${formatUsdc(summary.pending)}`,
      hint: 'comissões pagas imediatamente na confirmação do depósito',
      icon: <Clock size={16} />,
      tint: 'from-slate-500/10 to-zinc-500/10 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
    }
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((c) => (
          <div
            key={c.label}
            className={`bg-gradient-to-br ${c.tint} border rounded-xl p-4 flex flex-col gap-1`}
          >
            <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold tracking-wider opacity-90">
              {c.icon}
              <span>{c.label}</span>
            </div>
            <div className="text-2xl font-bold font-mono">{c.value}</div>
            {c.hint && <div className="text-[10px] opacity-70">{c.hint}</div>}
          </div>
        ))}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-amber-500" />
            <h3 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wide">{t('profile.myReferrals')}</h3>
          </div>
          <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400">{(data.referredUsers ?? []).length} operador(es)</span>
        </div>
        {(data.referredUsers ?? []).length === 0 ? (
          <div className="text-center py-8 text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg text-sm">
            Você ainda não tem indicados. Partilha o teu link e ganha {summary.percent}% sobre cada depósito USDC dos operadores que entrarem por ti.
          </div>
        ) : (
          <div className="overflow-x-auto -mx-2 px-2">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <th className="py-2 pr-3 font-bold">{t('profile.colOperator')}</th>
                  <th className="py-2 pr-3 font-bold text-right">{t('profile.colTotalDeposited')}</th>
                  <th className="py-2 pr-3 font-bold text-right">{t('profile.colCommission')}</th>
                  <th className="py-2 pr-3 font-bold text-right">{t('profile.colPayments')}</th>
                </tr>
              </thead>
              <tbody>
                {(data.referredUsers ?? []).map((u) => (
                  <tr key={u.id} className="border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-2 pr-3">
                      <div className="font-bold text-slate-700 dark:text-slate-200 truncate max-w-[14rem]">{describeReferred(u)}</div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-500">
                        {u.commissionsCount > 0 ? `1.ª comissão: ${formatDate(u.createdAt)}` : 'Aguarda primeiro depósito'}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-emerald-600 dark:text-emerald-400">
                      ${formatUsdc(u.totalDepositedUsdc)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-amber-600 dark:text-amber-400">
                      ${formatUsdc(u.totalCommissionUsdc)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-slate-600 dark:text-slate-400">{u.commissionsCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <History size={16} className="text-amber-500" />
            <h3 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wide">{t('profile.commissionHistory')}</h3>
          </div>
          <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400">{(data.commissions ?? []).length} registo(s)</span>
        </div>
        {(data.commissions ?? []).length === 0 ? (
          <div className="text-center py-8 text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg text-sm">
            Nenhuma comissão ainda. Convide operadores e ganhe {summary.percent}% quando eles depositarem USDC.
          </div>
        ) : (
          <div className="overflow-x-auto -mx-2 px-2">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <th className="py-2 pr-3 font-bold">Data</th>
                  <th className="py-2 pr-3 font-bold">Indicado</th>
                  <th className="py-2 pr-3 font-bold text-right">Depósito</th>
                  <th className="py-2 pr-3 font-bold text-right">Taxa</th>
                  <th className="py-2 pr-3 font-bold text-right">Comissão</th>
                  <th className="py-2 pr-3 font-bold text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {(data.commissions ?? []).map((c) => (
                  <tr key={c.id} className="border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-2 pr-3 whitespace-nowrap font-mono text-slate-600 dark:text-slate-400">{formatDate(c.createdAt)}</td>
                    <td className="py-2 pr-3 truncate max-w-[14rem] text-slate-700 dark:text-slate-200">{describeReferred(c.referredUser)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-emerald-600 dark:text-emerald-400">${formatUsdc(c.depositAmountUsdc)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-slate-500">{(c.commissionRate * 100).toFixed(2)}%</td>
                    <td className="py-2 pr-3 text-right font-mono text-amber-600 dark:text-amber-400">${formatUsdc(c.commissionAmountUsdc)}</td>
                    <td className="py-2 pr-3 text-right">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                        <ChevronRight size={10} /> {t('profile.paid')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-500">
              <Share2 size={10} className="inline mr-1" /> Comissão de {summary.percent}% creditada automaticamente em USDC na sua carteira no momento em que o depósito do indicado é confirmado.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default ReferralOverviewPanel;
