/**
 * Player mining calculator — projections from `/api/calculator/me`.
 * Layout aligned with RankingPage: coin chips → earnings stats → ranked list.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import {
  getCalculatorProjection,
  type CalculatorProjectionPayload,
  type ProjectionCoin,
  type ProjectionPeriodId
} from '../../../shared/api/calculator';
import { useT } from '../../../shared/i18n';
import { formatHashTotal } from '../../../shared/utils/locale-format';
import { MiningCoinGlyph } from '../../../shared/ui/MiningCoinGlyph';

/** Mirrors genesis-core SECONDS_PER_DAY. */
const SECONDS_PER_DAY = 86_400;
/** Mirrors genesis-core HOURS_PER_DAY. */
const HOURS_PER_DAY = 24;
/** Mirrors genesis-core PROJECTION_DAYS_PER_WEEK. */
const PROJECTION_DAYS_PER_WEEK = 7;
/** Mirrors genesis-core PROJECTION_DAYS_PER_MONTH (30d). */
const PROJECTION_DAYS_PER_MONTH = 30;
/** Mirrors genesis-core PROJECTION_DAYS_PER_YEAR. */
const PROJECTION_DAYS_PER_YEAR = 365;
/** Day / week / month / year — tokens + USD (player feedback). */
const HERO_PERIODS: readonly ProjectionPeriodId[] = ['day', 'week', 'month', 'year'];
const LOGO_CHIP_PX = 18;
const LOGO_LIST_PX = 32;

type Translate = (k: string, p?: Record<string, string | number>) => string;

type RankedCoin = ProjectionCoin & {
  usdPerHashPerDay: number;
};

function periodSeconds(periodId: ProjectionPeriodId): number {
  switch (periodId) {
    case 'hour':
      return SECONDS_PER_DAY / HOURS_PER_DAY;
    case 'day':
      return SECONDS_PER_DAY;
    case 'week':
      return PROJECTION_DAYS_PER_WEEK * SECONDS_PER_DAY;
    case 'month':
      return PROJECTION_DAYS_PER_MONTH * SECONDS_PER_DAY;
    case 'year':
      return PROJECTION_DAYS_PER_YEAR * SECONDS_PER_DAY;
    default:
      return SECONDS_PER_DAY;
  }
}

function periodLabel(id: ProjectionPeriodId, t: Translate): string {
  switch (id) {
    case 'day':
      return t('calculator.periodDay');
    case 'month':
      return t('calculator.periodMonth');
    case 'year':
      return t('calculator.periodYear');
    case 'hour':
      return t('calculator.periodHour');
    case 'week':
      return t('calculator.periodWeek');
    default:
      return id;
  }
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0';
  if (Math.abs(n) >= 1) {
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (Math.abs(n) >= 0.01) {
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  }
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function formatCoins(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (Math.abs(n) >= 1) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  if (Math.abs(n) >= 0.0001) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return n.toLocaleString(undefined, { maximumFractionDigits: 10 });
}

function usdPerHashPerDay(coin: ProjectionCoin): number {
  const y = coin.yieldPerHash;
  const p = coin.priceUsd;
  if (!Number.isFinite(y) || y <= 0 || !Number.isFinite(p) || p <= 0) return 0;
  return y * p * SECONDS_PER_DAY;
}

function rankCoins(coins: ProjectionCoin[]): RankedCoin[] {
  return coins
    .map((coin) => ({ ...coin, usdPerHashPerDay: usdPerHashPerDay(coin) }))
    .sort((a, b) => b.usdPerHashPerDay - a.usdPerHashPerDay);
}

/** Token amount for a hashrate over a period (`hps × yph × seconds`). */
function earningsCoins(hps: number, coin: ProjectionCoin, periodId: ProjectionPeriodId): number {
  const h = Number.isFinite(hps) && hps > 0 ? hps : 0;
  const y = Number.isFinite(coin.yieldPerHash) && coin.yieldPerHash > 0 ? coin.yieldPerHash : 0;
  const coins = h * y * periodSeconds(periodId);
  return Number.isFinite(coins) ? coins : 0;
}

/** USD for a hashrate over a period (same identity as the engine). */
function earningsUsd(hps: number, coin: ProjectionCoin, periodId: ProjectionPeriodId): number {
  const coins = earningsCoins(hps, coin, periodId);
  const price = Number.isFinite(coin.priceUsd) && coin.priceUsd > 0 ? coin.priceUsd : 0;
  const usd = coins * price;
  return Number.isFinite(usd) ? usd : 0;
}

export function CalculatorPage() {
  const t = useT();
  const [scope, setScope] = useState('total');
  const [data, setData] = useState<CalculatorProjectionPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selectedCoinId, setSelectedCoinId] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError('');
      try {
        const json = await getCalculatorProjection(scope, signal);
        if (signal?.aborted) return;
        setData(json);
        if (json.scope && json.scope !== scope) setScope(json.scope);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : t('common.networkError'));
        setData(null);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [scope, t]
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load, reloadNonce]);

  const ranked = useMemo(() => (data ? rankCoins(data.coins) : []), [data]);

  const bestPick = useMemo(() => {
    const withYield = ranked.filter((c) => c.usdPerHashPerDay > 0);
    return withYield[0] ?? null;
  }, [ranked]);

  useEffect(() => {
    if (ranked.length === 0) {
      setSelectedCoinId(null);
      return;
    }
    setSelectedCoinId((prev) => {
      if (prev && ranked.some((c) => c.id === prev)) return prev;
      return bestPick?.id ?? ranked[0]?.id ?? null;
    });
  }, [ranked, bestPick]);

  const selected = useMemo(
    () => ranked.find((c) => c.id === selectedCoinId) ?? null,
    [ranked, selectedCoinId]
  );

  const generalPower = data?.generalPowerHps ?? 0;

  /** Hash used for hero earnings: actual on this coin, else total power “what if”. */
  const heroHash = selected
    ? selected.userPowerHps > 0
      ? selected.userPowerHps
      : generalPower
    : 0;
  const heroIsEstimate = Boolean(selected && selected.userPowerHps <= 0 && generalPower > 0);

  if (loading && !data) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center p-8 text-white">
        <Loader2 className="mr-2 animate-spin text-orange-400" size={20} />
        {t('calculator.loading')}
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-red-400">{t('calculator.errorPrefix', { message: error })}</p>
        <button
          type="button"
          onClick={() => setReloadNonce((n) => n + 1)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-orange-500"
        >
          <RefreshCw size={14} /> {t('calculator.retry')}
        </button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="overflow-x-hidden p-3 font-sans text-white sm:p-6">
      <div className="mx-auto w-full min-w-0 max-w-6xl">
        {/* Header — same rhythm as RankingPage */}
        <div className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold bg-gradient-to-r from-amber-400 to-orange-700 bg-clip-text text-transparent sm:text-3xl">
              {t('calculator.title')}
            </h1>
            <p className="mt-1 text-sm leading-relaxed text-gray-400">{t('calculator.subtitle')}</p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              aria-label={t('calculator.scopeLabel')}
              className="min-h-10 rounded-lg border border-gray-800 bg-[#16161e] px-3 py-2 text-sm text-white"
            >
              {data.scopesUi.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              disabled={loading}
              className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-gray-800 bg-[#16161e] text-gray-300 hover:text-white disabled:opacity-50"
              aria-label={t('calculator.retry')}
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <div className="flex min-h-10 flex-col justify-center rounded-xl border border-gray-800 bg-[#16161e] px-3 py-1.5 sm:items-end">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">
                {t('calculator.generalPower')}
              </div>
              <div className="font-mono text-sm font-bold text-white">
                {formatHashTotal(data.generalPowerHps)}
              </div>
            </div>
          </div>
        </div>

        {data.checkinFrozen ? (
          <div className="mb-6 rounded-xl border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            {t('calculator.checkinFrozen')}
          </div>
        ) : null}

        {error ? (
          <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
            {t('calculator.errorPrefix', { message: error })}
          </div>
        ) : null}

        {ranked.length === 0 ? (
          <p className="text-gray-400">{t('calculator.noCoins')}</p>
        ) : (
          <>
            {/* Coin chips — Ranking-style filter grid */}
            <div className="mb-6 grid grid-cols-2 gap-2 rounded-xl border border-gray-800 bg-[#16161e] p-2 sm:mb-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {ranked.map((coin) => {
                const active = coin.id === selectedCoinId;
                return (
                  <button
                    key={coin.id}
                    type="button"
                    title={`${coin.name} (${coin.symbol})`}
                    onClick={() => setSelectedCoinId(coin.id)}
                    className={`flex min-h-10 min-w-0 items-center gap-2 truncate rounded-lg px-2 py-2 text-left text-xs font-medium transition sm:px-3 sm:text-sm ${
                      active
                        ? 'bg-orange-600 text-white shadow-lg shadow-orange-500/20'
                        : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                    }`}
                  >
                    <MiningCoinGlyph
                      coin={{
                        id: coin.id,
                        name: coin.name,
                        symbol: coin.symbol,
                        iconUrl: coin.iconUrl
                      }}
                      size={LOGO_CHIP_PX}
                    />
                    <span className="min-w-0 truncate">{coin.symbol}</span>
                  </button>
                );
              })}
            </div>

            {/* Earnings stats for selected coin */}
            {selected ? (
              <div className="mb-6 sm:mb-8">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <MiningCoinGlyph
                    coin={{
                      id: selected.id,
                      name: selected.name,
                      symbol: selected.symbol,
                      iconUrl: selected.iconUrl
                    }}
                    size={LOGO_LIST_PX}
                  />
                  <div className="min-w-0">
                    <div className="font-bold text-white">
                      {selected.name}{' '}
                      <span className="font-mono text-sm font-normal text-gray-400">
                        ({selected.symbol})
                      </span>
                    </div>
                    <div className="text-xs text-gray-500">
                      {heroIsEstimate
                        ? t('calculator.estimateWithPower')
                        : t('calculator.yourEarnings')}
                      {selected.usdPerHashPerDay > 0 ? (
                        <>
                          {' · '}
                          {formatUsd(selected.usdPerHashPerDay)}
                          {t('calculator.perHashDaySuffix')}
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 lg:gap-6">
                  {HERO_PERIODS.map((periodId) => {
                    const coins = earningsCoins(heroHash, selected, periodId);
                    const usd = earningsUsd(heroHash, selected, periodId);
                    return (
                      <div
                        key={periodId}
                        className="relative overflow-hidden rounded-2xl border border-gray-800 bg-[#16161e] p-4 sm:p-5"
                      >
                        <div className="text-xs font-bold uppercase tracking-wide text-gray-500">
                          {periodLabel(periodId, t)}
                        </div>
                        <div className="mt-2 font-mono text-lg font-bold text-white sm:text-xl">
                          {formatCoins(coins)}{' '}
                          <span className="text-sm font-semibold text-amber-300">{selected.symbol}</span>
                        </div>
                        <div className="mt-1 text-sm font-semibold text-emerald-300">
                          {formatUsd(usd)}
                        </div>
                        <div className="mt-2 font-mono text-[10px] text-gray-600">
                          {formatHashTotal(heroHash)}
                          {heroIsEstimate ? ` · ${t('calculator.ifMoved')}` : ''}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* Ranked efficiency list */}
            <div className="mb-2 text-xs font-bold uppercase tracking-wider text-gray-500">
              {t('calculator.compareTitle')}
            </div>

            <div className="space-y-2">
              {ranked.map((coin, index) => {
                const active = coin.id === selectedCoinId;
                const mining = coin.userPowerHps > 0;
                return (
                  <button
                    key={coin.id}
                    type="button"
                    onClick={() => setSelectedCoinId(coin.id)}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${
                      active
                        ? 'border-orange-600/60 bg-orange-600/15'
                        : 'border-gray-800 bg-[#16161e] hover:border-gray-700'
                    }`}
                  >
                    <span className="w-7 shrink-0 text-center font-mono text-sm text-gray-500">
                      {index + 1}
                    </span>
                    <MiningCoinGlyph
                      coin={{
                        id: coin.id,
                        name: coin.name,
                        symbol: coin.symbol,
                        iconUrl: coin.iconUrl
                      }}
                      size={LOGO_LIST_PX}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white">{coin.symbol}</span>
                        {index === 0 && coin.usdPerHashPerDay > 0 ? (
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-300">
                            {t('calculator.bestBadge')}
                          </span>
                        ) : null}
                        {mining ? (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-300">
                            {t('calculator.miningBadge')}
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-xs text-gray-500">{coin.name}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-sm font-semibold text-orange-300">
                        {formatUsd(coin.usdPerHashPerDay)}
                        <span className="ml-0.5 text-[10px] font-normal text-gray-500">
                          {t('calculator.perHashDaySuffix')}
                        </span>
                      </div>
                      {mining ? (
                        <div className="mt-0.5 font-mono text-[11px] text-gray-400">
                          {formatUsd(earningsUsd(coin.userPowerHps, coin, 'day'))}
                          <span className="text-gray-600">/{t('calculator.periodDay').toLowerCase()}</span>
                        </div>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>

            <p className="mt-6 text-xs leading-relaxed text-gray-500">{t('calculator.disclaimer')}</p>
          </>
        )}
      </div>
    </div>
  );
}
