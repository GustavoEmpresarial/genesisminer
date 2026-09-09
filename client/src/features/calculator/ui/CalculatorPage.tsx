/**
 * Calculadora de mineração — player view.
 * Ported from `legacy/frontend/components/PlayerCalculator.tsx`.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, TrendingUp, Box, Server, Sparkles } from 'lucide-react';
import {
  getPlayerCalculatorMe,
  postPlayerCalculatorAiAnalyze,
  type PlayerCalculatorMeOk
} from '../../../shared/api/calculator';
import { isIndependentNetworkPoolMiningCoin, isNftRoomExclusiveMiningCoin } from '../../servers/types';
import { useT } from '../../../shared/i18n';

export type CalculatorPageProps = {
  onBack: () => void;
  isAdmin?: boolean;
};

function formatDateTime(valueMs: number): string {
  if (!Number.isFinite(valueMs) || valueMs <= 0) return '—';
  return new Date(valueMs).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatHashrate(hps: number): string {
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let value = Number(hps) || 0;
  let idx = 0;
  while (value >= 1000 && idx < units.length - 1) {
    value /= 1000;
    idx += 1;
  }
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: value < 10 && idx > 0 ? 2 : 0,
    maximumFractionDigits: value < 10 && idx > 0 ? 2 : 0
  })} ${units[idx]}`;
}

/** Markdown mínimo sem deps: headings + listas + parágrafos. */
function SimpleMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let listBuf: string[] = [];
  const flushList = (keyBase: number) => {
    if (listBuf.length === 0) return;
    nodes.push(
      <ul key={`ul-${keyBase}`} className="list-disc space-y-1 pl-5 text-sm text-slate-300">
        {listBuf.map((item, j) => (
          <li key={`li-${keyBase}-${j}`}>{item}</li>
        ))}
      </ul>
    );
    listBuf = [];
  };
  lines.forEach((line, i) => {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      listBuf.push(trimmed.slice(2));
      return;
    }
    flushList(i);
    if (trimmed.startsWith('### ')) {
      nodes.push(
        <h4 key={`h-${i}`} className="mt-3 text-sm font-bold text-amber-200">
          {trimmed.slice(4)}
        </h4>
      );
      return;
    }
    if (trimmed.startsWith('## ')) {
      nodes.push(
        <h3 key={`h-${i}`} className="mt-4 text-base font-bold text-amber-300">
          {trimmed.slice(3)}
        </h3>
      );
      return;
    }
    if (trimmed.startsWith('# ')) {
      nodes.push(
        <h2 key={`h-${i}`} className="mt-4 text-lg font-black text-white">
          {trimmed.slice(2)}
        </h2>
      );
      return;
    }
    if (!trimmed) {
      nodes.push(<div key={`sp-${i}`} className="h-2" />);
      return;
    }
    nodes.push(
      <p key={`p-${i}`} className="text-sm leading-relaxed text-slate-300">
        {trimmed}
      </p>
    );
  });
  flushList(lines.length);
  return <div className="space-y-1">{nodes}</div>;
}

export const CalculatorPage: React.FC<CalculatorPageProps> = ({ onBack, isAdmin }) => {
  const t = useT();
  const [scope, setScope] = useState<string>('total');
  const [payload, setPayload] = useState<PlayerCalculatorMeOk | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedCoinId, setSelectedCoinId] = useState<string | null>(null);
  const fetchGenRef = useRef(0);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiMarkdown, setAiMarkdown] = useState<string | null>(null);
  const [aiModel, setAiModel] = useState<string | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    const gen = ++fetchGenRef.current;
    setLoading(true);
    setLoadError(null);
    setAiMarkdown(null);
    setAiModel(null);
    setAiError(null);
    aiAbortRef.current?.abort();
    void (async () => {
      const r = await getPlayerCalculatorMe(scope, ac.signal);
      if (gen !== fetchGenRef.current) return;
      if (r.ok !== true) {
        if (r.status === 0 && r.code === 'ABORTED') return;
        setPayload(null);
        setLoadError(r.error || `Erro ${r.status}`);
        setLoading(false);
        return;
      }
      setPayload(r);
      setSelectedCoinId((prev) => {
        const activelyMining = r.coins.filter((c) => c.userPowerHps > 0);
        if (prev && activelyMining.some((c) => c.id === prev)) return prev;
        const flagged = r.coinComparisons?.find((c) => c.isActivelyMining);
        if (flagged) return flagged.id;
        return activelyMining[0]?.id ?? r.coins[0]?.id ?? null;
      });
      setLoading(false);
    })();
    return () => ac.abort();
  }, [scope]);

  const runAiAnalyze = () => {
    if (loading || aiLoading || !payload) return;
    aiAbortRef.current?.abort();
    const ac = new AbortController();
    aiAbortRef.current = ac;
    setAiLoading(true);
    setAiError(null);
    void (async () => {
      const r = await postPlayerCalculatorAiAnalyze(scope, ac.signal);
      if (ac.signal.aborted) return;
      setAiLoading(false);
      if (r.ok !== true) {
        if (r.status === 0 && r.code === 'ABORTED') return;
        if (r.code === 'AI_NOT_CONFIGURED') {
          setAiError(t('calculator.aiNotConfigured'));
          return;
        }
        if (r.code === 'RATE_LIMIT' || r.status === 429) {
          setAiError(t('calculator.aiRateLimit'));
          return;
        }
        setAiError(r.error || t('calculator.aiError'));
        return;
      }
      setAiMarkdown(r.analysisMarkdown);
      setAiModel(r.model);
    })();
  };

  const selectedCoin = payload?.coins.find((c) => c.id === selectedCoinId) ?? null;
  const scopesUi = payload?.scopesUi ?? [{ id: 'total', name: t('calculator.totalPower') }];
  const generalPowerHps = payload?.generalPowerHps ?? 0;
  const detailTabCoins = useMemo(() => {
    const mining = (payload?.coins ?? []).filter((c) => c.userPowerHps > 0);
    const general = mining.filter((c) => !isIndependentNetworkPoolMiningCoin(c));
    const independent = mining.filter((c) => isIndependentNetworkPoolMiningCoin(c));
    return [...general, ...independent];
  }, [payload?.coins]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-slate-950 text-slate-200 lg:flex-row">
      <div className="flex w-full min-w-0 shrink-0 flex-col border-b border-slate-800 bg-slate-900 lg:w-72 lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2 border-b border-slate-800/80 px-3 py-2 lg:border-b-0 lg:px-4 lg:pt-4 lg:pb-0">
          <button
            type="button"
            onClick={onBack}
            className="flex shrink-0 items-center gap-2 rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
          >
            <ArrowLeft size={18} />
            <span className="font-bold text-sm lg:inline">{t('calculator.back')}</span>
          </button>
          <h2 className="min-w-0 truncate text-sm font-bold text-amber-400 lg:hidden">{t('calculator.title')}</h2>
        </div>

        <div className="min-w-0 px-3 py-2 lg:px-4 lg:py-0">
          <div className="mb-2 hidden px-2 text-xs font-bold uppercase tracking-widest text-slate-500 lg:block">
            {t('calculator.analysisScope')}
          </div>

          <div className="flex max-w-full flex-wrap gap-2 pb-1 lg:flex-col lg:flex-nowrap lg:overflow-visible lg:pb-0">
            {scopesUi.map((opt) => (
              <button
                key={opt.id}
                type="button"
                disabled={loading}
                onClick={() => setScope(opt.id)}
                title={opt.name}
                className={`flex min-w-0 max-w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-xs font-medium transition-all sm:py-2 lg:w-full lg:p-3 lg:text-sm ${
                  scope === opt.id
                    ? 'border border-amber-500/50 bg-amber-600/10 text-amber-400'
                    : 'border border-slate-800 text-slate-400 hover:bg-white/5 hover:text-slate-200 lg:border-transparent'
                } ${loading ? 'cursor-wait opacity-60' : ''}`}
              >
                {opt.id === 'total' ? (
                  <Box size={14} className="shrink-0 lg:h-4 lg:w-4" />
                ) : (
                  <Server size={14} className="shrink-0 lg:h-4 lg:w-4" />
                )}
                <span className="min-w-0 truncate">{opt.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="hidden rounded-xl border border-slate-800 bg-slate-950/50 p-4 m-4 lg:block lg:mt-auto">
          <div className="text-xs text-slate-500 mb-1">{t('calculator.gpuPowerComparative')}</div>
          <div className="break-words text-lg font-mono font-bold text-white sm:text-xl">
            {generalPowerHps > 0
              ? `${generalPowerHps.toLocaleString('en-US', { maximumFractionDigits: 0 })} H/s`
              : '—'}
          </div>
          {selectedCoin && selectedCoin.userPowerHps > 0 && (
            <div className="mt-3 border-t border-slate-800 pt-3">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                {t('calculator.miningCoin', { symbol: selectedCoin.symbol })}
              </div>
              <div className="mt-1 break-words font-mono text-sm font-bold text-amber-400">
                {selectedCoin.userPowerHps.toLocaleString('en-US', { maximumFractionDigits: 0 })} H/s
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden custom-scrollbar p-3 sm:p-4 lg:p-6">
        <div className="flex w-full max-w-full flex-col gap-4 sm:gap-5 lg:max-w-5xl lg:gap-6 mx-auto">
          {generalPowerHps > 0 && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 lg:hidden">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{t('calculator.gpuPowerComparative')}</div>
              <div className="mt-1 break-words font-mono text-sm font-bold text-white">
                {`${generalPowerHps.toLocaleString('en-US', { maximumFractionDigits: 0 })} H/s`}
              </div>
            </div>
          )}
          {selectedCoin && selectedCoin.userPowerHps > 0 && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 lg:hidden">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                {t('calculator.miningCoin', { symbol: selectedCoin.symbol })}
              </div>
              <div className="mt-1 break-words font-mono text-sm font-bold text-amber-400">
                {`${selectedCoin.userPowerHps.toLocaleString('en-US', { maximumFractionDigits: 0 })} H/s`}
              </div>
            </div>
          )}
          {loadError && (
            <div className="rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
              {loadError}
            </div>
          )}

          {loading && !payload && (
            <div className="text-center text-slate-500 text-sm py-16">{t('calculator.loading')}</div>
          )}

          {!loading && payload && payload.coins.length === 0 && (
            <div className="text-center text-slate-500 text-sm py-16">{t('calculator.noActiveCoins')}</div>
          )}

          {payload && !loading && (
            <div className="rounded-3xl border border-violet-800/40 bg-violet-950/20 p-4 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-violet-200">
                    <Sparkles size={18} className="text-violet-300" />
                    {t('calculator.aiTitle')}
                  </h3>
                  <p className="mt-1 text-xs text-slate-500 max-w-2xl">{t('calculator.aiHint')}</p>
                </div>
                <button
                  type="button"
                  disabled={aiLoading || loading}
                  onClick={runAiAnalyze}
                  className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-bold transition ${
                    aiLoading
                      ? 'cursor-wait border-violet-700/50 bg-violet-900/40 text-violet-300 opacity-70'
                      : 'border-violet-500/50 bg-violet-600/20 text-violet-100 hover:bg-violet-600/30'
                  }`}
                >
                  <Sparkles size={16} />
                  {aiLoading ? t('calculator.aiAnalyzing') : t('calculator.aiAnalyze')}
                </button>
              </div>
              {aiError && (
                <div className="mt-4 rounded-xl border border-red-800/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                  {aiError}
                </div>
              )}
              {aiMarkdown && (
                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                  {aiModel ? (
                    <div className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                      {t('calculator.aiModel', { model: aiModel })}
                    </div>
                  ) : null}
                  <SimpleMarkdown text={aiMarkdown} />
                </div>
              )}
            </div>
          )}

          {payload && payload.coins.length > 0 && detailTabCoins.length > 0 && (
            <>
              <div className="flex w-full items-center justify-center overflow-x-hidden">
                <div className="flex w-full flex-wrap justify-center gap-1 rounded-lg border border-slate-800 bg-slate-900/50 p-1 sm:w-auto">
                  {detailTabCoins.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedCoinId(c.id)}
                      className={`min-w-0 flex-[1_1_calc(50%-0.25rem)] rounded-md px-3 py-2 text-xs font-bold uppercase tracking-wider transition-all sm:min-w-[88px] sm:flex-1 sm:text-sm md:min-w-0 md:flex-none md:px-6 ${
                        selectedCoinId === c.id
                          ? 'bg-amber-600 text-white shadow-lg shadow-amber-900/50'
                          : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
                      }`}
                    >
                      {c.symbol || c.name}
                    </button>
                  ))}
                </div>
              </div>

              {selectedCoin && (
                <>
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
                    <div className="group relative flex min-h-[160px] min-w-0 flex-col justify-between overflow-hidden rounded-3xl border border-slate-800 bg-slate-900 p-4 sm:min-h-[190px] sm:p-6 lg:h-48 lg:p-8">
                      <div className="absolute top-0 left-0 w-2 h-full bg-gradient-to-b from-amber-400 to-orange-500 rounded-sm"></div>
                      <div className="z-10">
                        <div className="text-[10px] font-bold uppercase text-slate-400 tracking-widest mb-1">
                          {t('calculator.earnings24h', { symbol: selectedCoin.symbol })}
                        </div>
                        <div className="flex min-w-0 items-end gap-2 break-all text-[clamp(1.85rem,8vw,2.8rem)] font-black tracking-tight text-white">
                          $
                          {selectedCoin.dailyUsd.toLocaleString('en-US', {
                            minimumFractionDigits: 6,
                            maximumFractionDigits: 6
                          })}
                        </div>
                        <div className="mt-2 break-words font-mono text-sm font-bold text-amber-400">
                          {selectedCoin.dailyCoins.toFixed(8)} {selectedCoin.symbol}
                        </div>
                      </div>
                      <div className="pointer-events-none absolute right-[-12px] top-[12px] rotate-12 opacity-5 sm:right-[-20px] sm:top-[20px]">
                        <TrendingUp size={140} />
                      </div>
                    </div>

                    <div className="group relative flex min-h-[160px] min-w-0 flex-col justify-between overflow-hidden rounded-3xl border border-slate-800 bg-slate-900 p-4 sm:min-h-[190px] sm:p-6 lg:h-48 lg:p-8">
                      <div className="absolute top-0 left-0 w-2 h-full bg-gradient-to-b from-amber-400 to-orange-600 rounded-sm"></div>
                      <div className="z-10">
                        <div className="text-[10px] font-bold uppercase text-slate-400 tracking-widest mb-1">
                          {t('calculator.projection30d')}
                        </div>
                        <div className="break-all text-[clamp(1.85rem,8vw,2.8rem)] font-black tracking-tight text-white">
                          $
                          {selectedCoin.projection30Usd.toLocaleString('en-US', {
                            minimumFractionDigits: 6,
                            maximumFractionDigits: 6
                          })}
                        </div>
                        <div className="mt-3 break-words font-mono text-xs italic text-orange-400">
                          {t('calculator.exchangeRate', {
                            symbol: selectedCoin.symbol,
                            price: (selectedCoin.priceUSD || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })
                          })}
                        </div>
                      </div>
                      <div className="absolute right-5 top-5 text-orange-500 opacity-20 sm:right-8 sm:top-8">
                        <ArrowUpRight size={48} />
                      </div>
                    </div>
                  </div>

                  <div className="rounded-3xl border border-slate-800 bg-slate-900 p-4 sm:p-6 lg:p-8">
                    <h3 className="flex items-center gap-2 text-slate-300 font-bold mb-2">
                      <TrendingUp size={18} className="text-amber-400" />
                      {t('calculator.currentMining', { symbol: selectedCoin.symbol })}
                    </h3>
                    <p className="text-xs text-slate-500 mb-6">
                      {t('calculator.projectionsDesc', {
                        power: selectedCoin.userPowerHps.toLocaleString('en-US', { maximumFractionDigits: 0 }),
                        nftNote: [
                          isIndependentNetworkPoolMiningCoin(selectedCoin)
                            ? t('calculator.independentPoolNote')
                            : '',
                          isNftRoomExclusiveMiningCoin(selectedCoin)
                            ? t('calculator.nftBonusExcludeNote')
                            : ''
                        ].join('')
                      })}
                    </p>

                    <div className="hidden w-full lg:block">
                      <div className="grid grid-cols-3 items-center border-b border-slate-800 px-4 pb-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        <div>{t('calculator.period')}</div>
                        <div>{t('calculator.coinSymbol', { symbol: selectedCoin.symbol })}</div>
                        <div className="text-right">{t('calculator.usdcEquivalent')}</div>
                      </div>
                      <div className="flex flex-col">
                        {selectedCoin.rows.map((period) => (
                          <div
                            key={period.label}
                            className="grid grid-cols-3 py-4 border-b border-slate-800/50 hover:bg-white/5 transition-colors px-4 items-center"
                          >
                            <div className="text-sm font-medium text-slate-300">{period.label}</div>
                            <div className="text-sm font-mono text-slate-300">{period.coins.toFixed(8)}</div>
                            <div className="text-right font-mono font-bold text-green-400">
                              $
                              {period.usd.toLocaleString('en-US', {
                                minimumFractionDigits: 6,
                                maximumFractionDigits: 6
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3 lg:hidden">
                      {selectedCoin.rows.map((period) => (
                        <div
                          key={period.label}
                          className="rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-3"
                        >
                          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                            {period.label}
                          </div>
                          <div className="mt-3 text-xs text-slate-500">{t('calculator.coinSymbol', { symbol: selectedCoin.symbol })}</div>
                          <div className="mt-1 break-words font-mono text-sm text-slate-200">
                            {period.coins.toFixed(8)}
                          </div>
                          <div className="mt-3 text-xs text-slate-500">{t('calculator.usdcEquivalent')}</div>
                          <div className="mt-1 break-words font-mono text-sm font-bold text-green-400">
                            $
                            {period.usd.toLocaleString('en-US', {
                              minimumFractionDigits: 6,
                              maximumFractionDigits: 6
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-3xl border border-slate-800 bg-slate-900 p-4 sm:p-6 lg:p-8">
                    <div className="flex flex-col gap-2 mb-6 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h3 className="flex items-center gap-2 text-slate-300 font-bold">
                          <Box size={18} className="text-amber-400" />
                          {t('calculator.creditsHistory')}
                        </h3>
                        <p className="text-xs text-slate-500 mt-1">
                          {t('calculator.creditsHistoryDesc', { symbol: selectedCoin.symbol })}
                        </p>
                      </div>
                      <div className="text-xs text-slate-500">
                        {t('calculator.recordsCount', { count: selectedCoin.blockHistory.length })}
                      </div>
                    </div>

                    {selectedCoin.blockHistory.length === 0 ? (
                      <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-8 text-center text-sm text-slate-500">
                        {t('calculator.noCreditsYet')}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {selectedCoin.blockHistory.map((entry) => (
                          <div
                            key={entry.id}
                            className="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-4"
                          >
                            <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                              <div className="min-w-0">
                                <div className="text-sm font-bold text-white">{t('calculator.windowCredit')}</div>
                                <div className="mt-1 break-words text-xs text-slate-500">
                                  {t('calculator.window', {
                                    start: formatDateTime(entry.windowStartMs),
                                    end: formatDateTime(entry.windowEndMs)
                                  })}
                                </div>
                                <div className="mt-1 break-words text-xs text-slate-500">
                                  {t('calculator.room', { room: entry.roomId || t('calculator.allRoomsScope') })}
                                </div>
                              </div>

                              <div className="min-w-0 text-left lg:text-right">
                                <div className="break-words text-sm font-mono font-bold text-amber-400">
                                  {entry.amountCoins.toFixed(8)} {selectedCoin.symbol}
                                </div>
                                <div className="mt-1 break-words text-xs font-mono text-green-400">
                                  $
                                  {entry.amountUsd.toLocaleString('en-US', {
                                    minimumFractionDigits: 6,
                                    maximumFractionDigits: 6
                                  })}
                                </div>
                              </div>
                            </div>

                            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                              <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2">
                                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                                  {t('calculator.yourHashrate')}
                                </div>
                                <div className="mt-1 text-sm font-mono text-slate-200">
                                  {formatHashrate(entry.userHashHps)}
                                </div>
                              </div>

                              <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2">
                                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                                  {t('calculator.network')}
                                </div>
                                <div className="mt-1 text-sm font-mono text-slate-200">
                                  {formatHashrate(entry.networkHashrate)}
                                </div>
                              </div>

                              <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2">
                                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                                  {t('calculator.reward')}
                                </div>
                                <div className="mt-1 text-sm font-mono text-slate-200">
                                  {entry.blockReward.toFixed(8)} {selectedCoin.symbol}
                                </div>
                              </div>

                              <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2">
                                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                                  {t('calculator.blockTime')}
                                </div>
                                <div className="mt-1 text-sm font-mono text-slate-200">
                                  {entry.blockTime.toLocaleString(undefined, {
                                    maximumFractionDigits: 2
                                  })}
                                  s
                                </div>
                                <div className="mt-0.5 text-[10px] text-slate-600">{t('calculator.coinParamFootnote')}</div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {isAdmin && (
            <div className="mt-12 pt-8 border-t border-slate-800 animate-in slide-in-from-bottom-5 fade-in duration-500">
              <div className="min-w-0 overflow-x-hidden rounded-3xl border border-slate-700/50 bg-slate-900 p-4 shadow-2xl sm:p-6">
                <p className="text-sm text-slate-500">{t('calculator.adminEconomyPending')}</p>
              </div>
            </div>
          )}

          <div className="text-center text-[10px] text-slate-600 mt-4 max-w-2xl mx-auto">
            {t('calculator.disclaimer')}
          </div>
        </div>
      </div>
    </div>
  );
};
