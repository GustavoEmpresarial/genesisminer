import React from 'react';
import { Coins, PiggyBank } from 'lucide-react';
import type { AccountManagerEarningsSummary } from '../api/gerente';

function formatCoinAmount(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  if (abs >= 0.0001) return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200/80 bg-white/70 px-3 py-2.5 dark:border-slate-700/80 dark:bg-slate-900/50">
      <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div
        className={`mt-0.5 font-mono text-sm font-bold ${
          accent ? 'text-amber-600 dark:text-amber-400' : 'text-slate-900 dark:text-white'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

type Props = {
  earnings: AccountManagerEarningsSummary | null | undefined;
  sharePercent?: number;
};

export const GerenteEarningsCard: React.FC<Props> = ({ earnings, sharePercent }) => {
  const byCoin = earnings?.byCoin ?? [];
  const active = earnings?.activeContracts ?? 0;
  const ended = earnings?.endedContracts ?? 0;
  const managed = earnings?.managedContracts ?? 0;
  const pendingTotal = byCoin.reduce((s, c) => s + (c.pendingShare || 0), 0);
  const paidTotal = byCoin.reduce((s, c) => s + (c.paidShare || 0), 0);
  const shareCopy =
    sharePercent != null && Number.isFinite(sharePercent)
      ? `A tua parte (${sharePercent}%) do minerado nas contas que geres ou geriste — por moeda, pago 1× por semana.`
      : 'A tua parte do minerado nas contas que geres ou geriste — por moeda, pago 1× por semana.';

  return (
    <div className="group relative flex min-h-[200px] flex-col overflow-hidden rounded-2xl border border-amber-500/30 bg-gradient-to-br from-white via-amber-50/40 to-slate-100 p-4 shadow-lg shadow-amber-900/10 dark:from-slate-900/95 dark:via-amber-950/25 dark:to-slate-950 dark:border-amber-600/30 dark:shadow-black/50">
      <div
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: 'radial-gradient(120% 80% at 0% 0%, rgba(245, 158, 11, 0.12) 0%, transparent 55%)'
        }}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="mb-3 flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amber-500/35 bg-amber-500/12 text-amber-700 dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-300">
            <PiggyBank className="h-5 w-5 shrink-0" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-800 dark:text-amber-100/95">
              Ganhos como gerente
            </h4>
            <p className="mt-1 text-[11px] leading-snug text-slate-600 dark:text-slate-400">{shareCopy}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Contratos ativos" value={String(active)} />
          <Stat label="Histórico (encerrados)" value={String(ended)} />
          <Stat label="Pendente (a pagar)" value={formatCoinAmount(pendingTotal)} accent />
          <Stat label="Já pago (total)" value={formatCoinAmount(paidTotal)} accent />
        </div>

        <div className="mt-3">
          <p className="mb-1.5 text-[9px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Por moeda (ativo + histórico)
          </p>
          {byCoin.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300/80 bg-white/40 px-3 py-4 text-center text-[11px] text-slate-500 dark:border-slate-700 dark:bg-slate-900/30 dark:text-slate-400">
              {managed === 0
                ? 'Ainda sem contratos como gerente — os ganhos aparecem aqui quando acumulares share.'
                : 'Ainda sem acúmulo de share nestas contas. Os ganhos surgem conforme o dono minera.'}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {byCoin.map((row) => (
                <div
                  key={row.coinId}
                  className="rounded-lg border border-slate-200/80 bg-white/60 px-2.5 py-2 dark:border-slate-700/80 dark:bg-slate-900/40"
                >
                  <div className="flex items-center gap-1 text-[9px] font-bold uppercase text-amber-700 dark:text-amber-400">
                    <Coins size={10} aria-hidden />
                    {row.symbol}
                  </div>
                  <div className="mt-0.5 font-mono text-xs font-bold text-slate-800 dark:text-slate-100">
                    {formatCoinAmount(row.totalShare)}
                  </div>
                  <div className="mt-1 space-y-0.5 text-[9px] text-slate-500 dark:text-slate-400">
                    <div>
                      Pago:{' '}
                      <span className="font-mono text-emerald-600 dark:text-emerald-400">
                        {formatCoinAmount(row.paidShare)}
                      </span>
                    </div>
                    <div>
                      Pendente:{' '}
                      <span className="font-mono text-amber-600 dark:text-amber-400">
                        {formatCoinAmount(row.pendingShare)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
