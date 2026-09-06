import React, { useState, useEffect } from 'react';
import { RefreshCcw, Coins } from 'lucide-react';
import { useT } from '../../../shared/i18n';
import { formatMinedCoinAmount } from '../../../shared/utils/locale-format';
import { MiningCoinGlyph } from '../../../shared/ui/MiningCoinGlyph';

interface ExchangeProps {
  coinBalances: Record<string, number>;
  miningCoins: { id: string; name: string; symbol?: string; usdcRate: number; showInExchange?: boolean }[];
  /** Atalhos 10 / 50 / 100 — o servidor recalcula a quantidade. */
  onSellCoin: (coinId: string, percentagePoints: 10 | 50 | 100) => Promise<void>;
  /** Piso e taxa vindos de GET /api/wallet/state (evita divergência com /exchange-settings). */
  serverDeskSettings?: { minExchangeAmount: number; exchangeFeePercent: number } | null;
}

export const Exchange: React.FC<ExchangeProps> = ({
  coinBalances,
  miningCoins,
  onSellCoin,
  serverDeskSettings = null
}) => {
  const t = useT();
  const [settings, setSettings] = useState<{ minExchangeAmount: number; exchangeFeePercent: number } | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  useEffect(() => {
    if (serverDeskSettings) {
      setSettings({
        minExchangeAmount: Math.max(0, Number(serverDeskSettings.minExchangeAmount) || 0),
        exchangeFeePercent: Math.max(0, Math.min(100, Number(serverDeskSettings.exchangeFeePercent) || 0))
      });
      return;
    }
    // Sem bootstrap/exchange-settings no current — desk fica à espera de serverDeskSettings.
    setSettings(null);
  }, [serverDeskSettings]);

  const runDeskPct = async (coinId: string, pct: 10 | 50 | 100) => {
    const key = `${coinId}-${pct}`;
    if (pendingKey) return;
    setPendingKey(key);
    try {
      await onSellCoin(coinId, pct);
    } catch (e) {
      console.error('[Exchange desk]', e);
    } finally {
      setPendingKey(null);
    }
  };

  const formatMoney = (val: number) => {
    if (val === 0) return "0.00";
    if (val < 0.01) return val.toFixed(8);
    return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-lg relative overflow-hidden group transition-colors">
      {/* Background decoration */}
      <div className="absolute top-0 right-0 p-4 opacity-5 dark:opacity-10 pointer-events-none">
        <RefreshCcw size={100} />
      </div>

      <div className="relative z-10">
        <div className="flex flex-col gap-4 mb-6 border-b border-slate-200 dark:border-slate-800 pb-4">
          <div className="flex justify-between items-center">
            <h3 className="text-amber-600 dark:text-amber-500 font-black text-xl flex items-center gap-2 tracking-tight">
              <Coins size={24} className="stroke-[3]" /> {t('wallet.exchangeDeskTitle')}
            </h3>
          </div>

          {settings && (
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gradient-to-br from-amber-500/10 to-orange-500/10 dark:from-amber-900/40 dark:to-orange-900/40 border border-amber-200 dark:border-amber-800/50 rounded-xl p-3 flex flex-col items-center justify-center text-center shadow-sm">
                <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-widest mb-1 font-sans">{t('wallet.deskMinFloor')}</span>
                <span className="text-2xl font-black text-slate-800 dark:text-white leading-none font-mono">
                  ${formatMoney(settings.minExchangeAmount)} <span className="text-xs font-bold text-slate-500">USDC</span>
                </span>
              </div>

              <div className="bg-gradient-to-br from-amber-500/10 to-orange-500/10 dark:from-amber-900/40 dark:to-orange-900/40 border border-amber-200 dark:border-amber-800/50 rounded-xl p-3 flex flex-col items-center justify-center text-center shadow-sm">
                <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-widest mb-1 font-sans">{t('wallet.deskFee')}</span>
                <span className="text-2xl font-black text-slate-800 dark:text-white leading-none font-mono">
                  {settings.exchangeFeePercent}<span className="text-sm font-bold text-slate-500">%</span>
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <div className="mt-1">
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-2">{t('wallet.eligiblePairs')}</div>
            <div className="space-y-2">
              {miningCoins.filter(c => (c as any).showInExchange !== false).length === 0 ? (
                <div className="text-[12px] text-slate-500">{t('wallet.noPairsListed')}</div>
              ) : miningCoins.filter(c => (c as any).showInExchange !== false).sort((a, b) => {
                const aUsdc = String(a.name || '').toUpperCase().includes('USDC') || String((a as any).symbol || '').toUpperCase() === 'USDC';
                const bUsdc = String(b.name || '').toUpperCase().includes('USDC') || String((b as any).symbol || '').toUpperCase() === 'USDC';
                if (aUsdc && !bUsdc) return -1;
                if (!aUsdc && bUsdc) return 1;
                return a.name.localeCompare(b.name);
              }).map(c => {
                const bal = coinBalances[c.id] || 0;
                const est = bal * c.usdcRate;
                const fee = settings ? est * (settings.exchangeFeePercent / 100) : 0;
                const net = est - fee;
                const minUsdc = settings?.minExchangeAmount ?? 0;
                const isBelowMin =
                  !!settings && minUsdc > 0 && bal > 0 && est < minUsdc;

                return (
                  <div key={c.id} className="bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded p-2 flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <MiningCoinGlyph
                          coin={{ id: c.id, name: c.name, symbol: c.symbol || c.name }}
                          size={22}
                        />
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate text-[12px] font-mono text-slate-700 dark:text-slate-200 font-bold">{c.name}</span>
                          <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">Saldo minerado: {formatMinedCoinAmount(bal)}</span>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[12px] text-green-600 dark:text-green-400 font-mono font-bold">${formatMoney(net)}</div>
                        <div className="text-[10px] text-slate-400">Pré-taxa: ${formatMoney(est)}</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-1">
                      <button
                        type="button"
                        onClick={() => void runDeskPct(c.id, 10)}
                        disabled={bal <= 0 || isBelowMin || pendingKey !== null}
                        className="bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed text-slate-700 dark:text-slate-300 text-[10px] py-1 px-2 rounded border border-slate-200 dark:border-slate-700 transition-colors"
                      >
                        {pendingKey === `${c.id}-10` ? '…' : '10%'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void runDeskPct(c.id, 50)}
                        disabled={bal <= 0 || isBelowMin || pendingKey !== null}
                        className="bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed text-slate-700 dark:text-slate-300 text-[10px] py-1 px-2 rounded border border-slate-200 dark:border-slate-700 transition-colors"
                      >
                        {pendingKey === `${c.id}-50` ? '…' : '50%'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void runDeskPct(c.id, 100)}
                        disabled={bal <= 0 || isBelowMin || pendingKey !== null}
                        className="bg-green-100 dark:bg-green-900/40 hover:bg-green-200 dark:hover:bg-green-800/60 disabled:opacity-50 disabled:cursor-not-allowed text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800/50 text-[10px] py-1 px-2 rounded font-bold transition-colors"
                      >
                        {pendingKey === `${c.id}-100` ? '…' : 'Comprar USDC'}
                      </button>
                    </div>
                    {isBelowMin && (
                      <div className="text-[9px] text-red-500 text-center">{t('wallet.belowMinUsdc')}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

