import React, { useEffect, useMemo, useState } from 'react';
import { Cpu, PiggyBank } from 'lucide-react';
import { useT } from '../../../shared/i18n';
import { computeNftRoomPaybackStats, formatUsdCompact } from '../models/nftRoomPaybackModel';
import { formatHashrateDisplay } from '../models/serverRoomModel';
import type { AsicLeaseDetail, MiningCoin, PlacedRack, Upgrade } from '../types';

type Props = {
  racks: PlacedRack[];
  roomId: string | null | undefined;
  upgrades: Upgrade[];
  miningCoins: MiningCoin[];
  minedUsdTotal?: number;
  asicLeaseDetails?: AsicLeaseDetail[];
};

function PaybackStat({
  label,
  value,
  accent = false
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200/80 bg-white/70 px-3 py-2.5 dark:border-slate-700/80 dark:bg-slate-900/50">
      <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
      <div
        className={`mt-0.5 font-mono text-sm font-bold ${accent ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-900 dark:text-white'}`}
      >
        {value}
      </div>
    </div>
  );
}

export const NftRoomPaybackCard: React.FC<Props> = ({
  racks,
  roomId,
  upgrades,
  miningCoins,
  minedUsdTotal = 0,
  asicLeaseDetails = []
}) => {
  const t = useT();
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const stats = useMemo(
    () =>
      computeNftRoomPaybackStats(
        racks,
        roomId,
        upgrades,
        miningCoins,
        minedUsdTotal,
        asicLeaseDetails,
        nowMs
      ),
    [racks, roomId, upgrades, miningCoins, minedUsdTotal, asicLeaseDetails, nowMs]
  );

  const expiredLabel = t('servers.payback.expired');

  return (
    <div className="group relative flex min-h-[220px] flex-col overflow-hidden rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-white via-emerald-50/40 to-slate-100 p-4 shadow-lg shadow-emerald-900/10 dark:from-slate-900/95 dark:via-emerald-950/30 dark:to-slate-950 dark:border-emerald-600/30 dark:shadow-black/50 lg:col-span-2">
      <div
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: 'radial-gradient(120% 80% at 0% 0%, rgba(16, 185, 129, 0.1) 0%, transparent 55%)'
        }}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="mb-3 flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-300">
            <PiggyBank className="h-5 w-5 shrink-0" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-800 dark:text-emerald-100/95">
              {t('servers.payback.title')}
            </h4>
            <p className="mt-1 text-[11px] leading-snug text-slate-600 dark:text-slate-400">
              {t('servers.payback.subtitle')}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <PaybackStat label={t('servers.payback.asicsInstalled')} value={String(stats.asicCount)} />
          <PaybackStat label={t('servers.payback.invested')} value={formatUsdCompact(stats.totalInvestedUsd)} />
          <PaybackStat label={t('servers.payback.recovered')} value={formatUsdCompact(stats.recoveredUsd)} accent />
          <PaybackStat
            label={t('servers.payback.remaining')}
            value={formatUsdCompact(stats.remainingUsd, stats.totalInvestedUsd)}
          />
        </div>

        <div className="mt-3">
          <p className="mb-1.5 text-[9px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {t('servers.payback.hsByCoin')}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {stats.hashByExclusiveCoin.map((row) => (
              <div
                key={row.coinId}
                className="rounded-lg border border-slate-200/80 bg-white/60 px-2.5 py-2 dark:border-slate-700/80 dark:bg-slate-900/40"
              >
                <div className="text-[9px] font-bold uppercase text-amber-700 dark:text-amber-400">{row.label}</div>
                <div className="font-mono text-xs font-bold text-slate-800 dark:text-slate-100">
                  {formatHashrateDisplay(row.hash)} H/s
                </div>
                <div className="text-[9px] text-slate-500 dark:text-slate-400">
                  {row.asicCount}{' '}
                  {row.asicCount === 1
                    ? t('servers.payback.asicSingular')
                    : t('servers.payback.asicPlural')}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <span>{t('servers.payback.progress')}</span>
            <span className="font-mono text-emerald-700 dark:text-emerald-400">
              {stats.progressPercent.toFixed(1)}%
            </span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full border border-slate-200 bg-slate-200/80 dark:border-slate-700 dark:bg-slate-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-amber-500 transition-all duration-500"
              style={{ width: `${Math.min(100, stats.progressPercent)}%` }}
            />
          </div>
          {stats.estimatedUsdPerDay > 0 && stats.remainingUsd > 0 ? (
            <p className="mt-2 text-[10px] text-slate-600 dark:text-slate-400">
              {t('servers.payback.estimateDay', {
                usd: formatUsdCompact(stats.estimatedUsdPerDay),
                days: Math.max(1, Math.ceil(stats.remainingUsd / stats.estimatedUsdPerDay))
              })}
            </p>
          ) : stats.asicCount === 0 ? (
            <p className="mt-2 text-[10px] text-amber-700/90 dark:text-amber-300/90">
              {t('servers.payback.installHint')}
            </p>
          ) : (
            <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400">
              {t('servers.payback.powerOnHint')}
            </p>
          )}
        </div>

        {stats.asics.length > 0 ? (
          <div className="mt-3 max-h-[min(24rem,50vh)] overflow-y-auto custom-scrollbar rounded-lg border border-slate-200/80 bg-white/50 dark:border-slate-700 dark:bg-slate-900/40">
            <table className="w-full text-left text-[10px]">
              <thead className="sticky top-0 bg-slate-100/95 text-[9px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/95 dark:text-slate-400">
                <tr>
                  <th className="px-2 py-1.5 font-bold">{t('servers.payback.colAsic')}</th>
                  <th className="px-2 py-1.5 font-bold">{t('servers.payback.colCoin')}</th>
                  <th className="px-2 py-1.5 font-bold">{t('servers.payback.colValidity')}</th>
                  <th className="px-2 py-1.5 font-bold">{t('servers.payback.colRemaining')}</th>
                  <th className="px-2 py-1.5 text-right font-bold">{t('servers.payback.colCost')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.asics.map((a, idx) => {
                  const remainingDisplay =
                    a.remainingLabel === 'Expired' ? expiredLabel : a.remainingLabel;
                  return (
                  <tr key={`${a.upgradeId}-${idx}`} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-2 py-1.5 font-medium text-slate-800 dark:text-slate-200">
                      <span className="inline-flex items-center gap-1">
                        <Cpu size={10} className={a.isMining ? 'text-emerald-500' : 'text-slate-400'} />
                        <span className="truncate max-w-[8rem]">{a.name}</span>
                      </span>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-amber-700 dark:text-amber-400">{a.coinLabel}</td>
                    <td className="px-2 py-1.5 text-cyan-700 dark:text-cyan-400">{a.validityLabel}</td>
                    <td
                      className={`px-2 py-1.5 font-mono font-bold ${
                        a.remainingLabel === 'Expired'
                          ? 'text-red-600 dark:text-red-400'
                          : a.remainingLabel !== '—'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {remainingDisplay}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-700 dark:text-slate-300">
                      {formatUsdCompact(a.costUsd)}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
};
