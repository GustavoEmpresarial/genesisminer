/**
 * Ranking global de mineração — player view (público).
 * Ported from `legacy/frontend/components/AdminRanking.tsx` (`isPublic={true}`).
 */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  getPublicRanking,
  type PublicRankingPayload,
  type PublicRankingUser
} from '../../../shared/api/ranking';
import { useT } from '../../../shared/i18n';
import { isNftRoomExclusiveMiningCoin } from '../../servers/types';

type RankedUser = PublicRankingUser & { power: number };

function sumGeneralPower(u: PublicRankingUser, data: PublicRankingPayload): number {
  // generalCoins presente (mesmo {}) = fonte de verdade — não fallback para coins (ASIC-only → 0).
  if (u.generalCoins != null && typeof u.generalCoins === 'object') {
    return Object.values(u.generalCoins).reduce((acc, curr) => acc + (Number(curr) || 0), 0);
  }
  if (typeof u.generalPower === 'number' && Number.isFinite(u.generalPower)) {
    return u.generalPower;
  }
  return Object.entries(u.coins).reduce((acc, [coinId, curr]) => {
    const meta = data.coins.find((c) => c.id === coinId);
    if (meta && isNftRoomExclusiveMiningCoin(meta)) return acc;
    if (isNftRoomExclusiveMiningCoin(coinId)) return acc;
    return acc + curr;
  }, 0);
}

function getSortedRanking(
  data: PublicRankingPayload,
  selectedCoin: string
): { list: RankedUser[]; activeCoin: string } {
  const activeCoin = selectedCoin;

  if (activeCoin === 'ALL') {
    const filtered = data.ranking
      .map((u) => ({ ...u, power: sumGeneralPower(u, data) }))
      .filter((u) => u.power > 0)
      .sort((a, b) => b.power - a.power);

    return { list: filtered, activeCoin: 'ALL' };
  }

  const result = data.ranking
    .map((u) => ({
      ...u,
      power: u.coins[activeCoin] || 0
    }))
    .filter((u) => u.power > 0)
    .sort((a, b) => b.power - a.power);

  return { list: result, activeCoin };
}

export function RankingPage() {
  const t = useT();
  const [data, setData] = useState<PublicRankingPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedCoin, setSelectedCoin] = useState<string>('ALL');

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const json = await getPublicRanking(ac.signal);
        setData(json);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : t('common.networkError'));
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [t]);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center p-8 text-white">
        <Loader2 className="mr-2 animate-spin text-amber-400" size={20} />
        {t('ranking.loading')}
      </div>
    );
  }

  if (error) {
    return <div className="p-8 text-red-500">{t('ranking.errorPrefix', { message: error })}</div>;
  }

  if (!data) return null;

  const { list, activeCoin } = getSortedRanking(data, selectedCoin);
  const totalPower = list.reduce((acc, curr) => acc + curr.power, 0);
  const activeCoinInfo = data.coins.find((c) => c.id === activeCoin);
  const isGlobal = activeCoin === 'ALL';

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#1a1b26] p-3 font-sans text-white sm:p-6">
      <div className="mx-auto w-full min-w-0 max-w-6xl">
        <div className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-bold bg-gradient-to-r from-amber-400 to-orange-700 bg-clip-text text-transparent sm:text-3xl">
              {isGlobal
                ? t('ranking.titleGlobal')
                : t('ranking.titleCoin', {
                    name: activeCoinInfo?.name ?? '',
                    symbol: activeCoinInfo?.symbol ?? ''
                  })}
            </h1>
            <p className="text-sm leading-relaxed text-gray-400">
              {t('ranking.sortedBy')}
              {isGlobal ? t('ranking.sortedByGlobalHint') : null}
            </p>
          </div>

          <div className="flex shrink-0 items-baseline gap-2 rounded-xl border border-gray-800 bg-[#16161e] px-3 py-2 sm:flex-col sm:items-end sm:gap-0 sm:border-0 sm:bg-transparent sm:p-0 sm:text-right">
            <div className="text-xs text-gray-400 sm:text-sm">{t('ranking.totalListed')}</div>
            <div className="text-lg font-bold text-white sm:text-xl">{list.length}</div>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-2 rounded-xl border border-gray-800 bg-[#16161e] p-2 sm:mb-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          <button
            type="button"
            onClick={() => setSelectedCoin('ALL')}
            className={`min-h-10 min-w-0 truncate rounded-lg px-2 py-2 text-left text-xs font-medium transition sm:px-3 sm:text-sm ${
              selectedCoin === 'ALL'
                ? 'bg-orange-600 text-white shadow-lg shadow-orange-500/20'
                : 'text-gray-400 hover:bg-gray-800 hover:text-white'
            }`}
          >
            {t('ranking.filterGlobal')}
          </button>
          {data.coins
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((coin) => (
              <button
                key={coin.id}
                type="button"
                title={`${coin.name} (${coin.symbol})`}
                onClick={() => setSelectedCoin(coin.id)}
                className={`min-h-10 min-w-0 truncate rounded-lg px-2 py-2 text-left text-xs font-medium transition sm:px-3 sm:text-sm ${
                  selectedCoin === coin.id
                    ? 'bg-orange-600 text-white shadow-lg shadow-orange-500/20'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                }`}
              >
                <span className="sm:hidden">{coin.symbol || coin.name}</span>
                <span className="hidden sm:inline">
                  {coin.name} ({coin.symbol})
                </span>
              </button>
            ))}
        </div>

        <div className="mb-6 grid grid-cols-1 gap-4 sm:mb-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
          <div className="bg-[#16161e] p-4 sm:p-6 rounded-2xl border border-gray-800 flex items-center gap-4 relative overflow-hidden group">
            <div className="absolute right-0 top-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
              <span className="text-6xl">⚡</span>
            </div>
            <div className="p-3 bg-orange-500/10 rounded-full text-orange-400 text-2xl">⚡</div>
            <div className="min-w-0">
              <div className="text-gray-400 text-sm">
                {isGlobal
                  ? t('ranking.powerGlobal')
                  : t('ranking.powerTotalCoin', { symbol: activeCoinInfo?.symbol ?? '' })}
              </div>
              <div className="text-xl font-bold text-white sm:text-2xl">
                {totalPower.toLocaleString(undefined, { maximumFractionDigits: 0 })}{' '}
                <span className="text-xs font-normal text-gray-500">H/s</span>
              </div>
            </div>
          </div>

          <div className="bg-[#16161e] p-4 sm:p-6 rounded-2xl border border-gray-800 flex items-center gap-4 relative overflow-hidden group">
            <div className="absolute right-0 top-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
              <span className="text-6xl">📊</span>
            </div>
            <div className="p-3 bg-amber-500/10 rounded-full text-amber-400 text-2xl">📊</div>
            <div className="min-w-0">
              <div className="text-gray-400 text-sm">{t('ranking.avgPerPlayer')}</div>
              <div className="text-xl font-bold text-white sm:text-2xl">
                {(list.length > 0 ? totalPower / list.length : 0).toLocaleString(undefined, {
                  maximumFractionDigits: 0
                })}{' '}
                <span className="text-xs font-normal text-gray-500">H/s</span>
              </div>
            </div>
          </div>

          <div className="bg-[#16161e] p-4 sm:p-6 rounded-2xl border border-gray-800 flex items-center gap-4 relative overflow-hidden group">
            <div className="absolute right-0 top-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
              <span className="text-6xl">🌍</span>
            </div>
            <div className="p-3 bg-green-500/10 rounded-full text-green-400 text-2xl">🌍</div>
            <div className="min-w-0">
              <div className="text-gray-400 text-sm">{t('ranking.activeMining')}</div>
              <div className="text-xl font-bold text-white sm:text-2xl">
                {list.length}{' '}
                <span className="text-xs font-normal text-gray-500">{t('ranking.players')}</span>
              </div>
              <div className="text-xs text-green-500 mt-1">
                {isGlobal
                  ? t('ranking.anyCoin')
                  : t('ranking.inCoin', { name: activeCoinInfo?.name ?? '' })}
              </div>
            </div>
          </div>

          <div className="bg-[#16161e] p-4 sm:p-6 rounded-2xl border border-gray-800 flex flex-col justify-center relative overflow-hidden sm:col-span-2 lg:col-span-1">
            <div className="text-gray-400 text-xs mb-2 font-bold uppercase tracking-wider">
              {t('ranking.averagesByCoin')}
            </div>
            <div className="space-y-1 overflow-y-auto max-h-24 pr-1 scrollbar-thin scrollbar-thumb-gray-700">
              {data.coins
                .map((c) => {
                  const cUsers = data.ranking
                    .map((u) => (isGlobal ? u.generalCoins?.[c.id] : undefined) ?? (isGlobal ? 0 : u.coins[c.id] || 0))
                    .filter((p) => p > 0);
                  const cTotal = cUsers.reduce((a, b) => a + b, 0);
                  const cAvg = cUsers.length > 0 ? cTotal / cUsers.length : 0;
                  return { ...c, avg: cAvg };
                })
                .filter((c) => !isGlobal || !isNftRoomExclusiveMiningCoin(c))
                .sort((a, b) => b.avg - a.avg)
                .map((c) => (
                  <div key={c.id} className="flex justify-between text-xs gap-2">
                    <span className="min-w-0 truncate text-gray-300">{c.symbol}:</span>
                    <span className="shrink-0 font-mono text-white">
                      {c.avg.toLocaleString(undefined, { notation: 'compact' })} H/s
                    </span>
                  </div>
                ))}
            </div>
          </div>
        </div>

        {/* Mobile: cards */}
        <div className="space-y-2 md:hidden">
          {list.length === 0 ? (
            <div className="rounded-2xl border border-gray-800 bg-[#16161e] p-8 text-center text-gray-500">
              {t('ranking.empty')}
            </div>
          ) : (
            list.map((user, index) => {
              const share = totalPower > 0 ? (user.power / totalPower) * 100 : 0;
              return (
                <div
                  key={user.user_id}
                  className="flex items-center gap-3 rounded-xl border border-gray-800 bg-[#16161e] px-3 py-3"
                >
                  <div className="w-8 shrink-0 text-center font-mono text-sm text-gray-500">{index + 1}</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-white">
                      {user.username}
                      {index === 0 && <span className="ml-1 text-yellow-500">👑</span>}
                      {index === 1 && <span className="ml-1 text-gray-400">🥈</span>}
                      {index === 2 && <span className="ml-1 text-orange-700">🥉</span>}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-700">
                        <div className="h-full bg-orange-500" style={{ width: `${Math.min(100, share)}%` }} />
                      </div>
                      <span className="shrink-0 text-[11px] tabular-nums text-gray-400">{share.toFixed(2)}%</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right font-mono text-sm text-orange-300">
                    {user.power.toLocaleString()}
                    <span className="ml-0.5 text-[10px] text-gray-600">H/s</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Desktop: table */}
        <div className="hidden overflow-hidden rounded-2xl border border-gray-800 bg-[#16161e] shadow-xl md:block">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-left">
              <thead>
                <tr className="bg-[#1f2937] text-sm uppercase tracking-wider text-gray-400">
                  <th className="w-24 p-4 text-center">{t('ranking.colRank')}</th>
                  <th className="p-4">{t('ranking.colUser')}</th>
                  <th className="p-4 text-right">
                    {isGlobal ? t('ranking.colPowerTotal') : t('ranking.colPowerMining')}
                  </th>
                  <th className="w-48 p-4 text-right">{t('ranking.colShare')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {list.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-8 text-center text-gray-500">
                      {t('ranking.empty')}
                    </td>
                  </tr>
                ) : (
                  list.map((user, index) => {
                    const share = totalPower > 0 ? (user.power / totalPower) * 100 : 0;

                    return (
                      <tr key={user.user_id} className="transition duration-150 hover:bg-gray-800/50">
                        <td className="p-4 text-center font-mono text-gray-500">{index + 1}</td>
                        <td className="p-4 font-medium text-white">
                          {user.username}
                          {index === 0 && <span className="ml-2 text-yellow-500">👑</span>}
                          {index === 1 && <span className="ml-2 text-gray-400">🥈</span>}
                          {index === 2 && <span className="ml-2 text-orange-700">🥉</span>}
                        </td>
                        <td className="p-4 text-right font-mono text-orange-300">
                          {user.power.toLocaleString()}{' '}
                          <span className="text-xs text-gray-600">H/s</span>
                        </td>
                        <td className="p-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <span className="w-12 text-sm text-gray-400">{share.toFixed(2)}%</span>
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-700">
                              <div className="h-full bg-orange-500" style={{ width: `${share}%` }} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
