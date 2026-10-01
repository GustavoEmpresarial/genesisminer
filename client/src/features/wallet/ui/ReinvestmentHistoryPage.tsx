import React, { useEffect, useState } from 'react';
import type { AppLocale } from '../../../shared/i18n';
import { useI18n, useT } from '../../../shared/i18n';
import { Search, RefreshCw, History, Coins, DollarSign } from 'lucide-react';
import {
  getMyReinvestmentHistory,
  type ReinvestmentHistoryEntry
} from '../../../shared/api/wallet';
import {
  dateLocaleFor,
  formatMinedCoinAmount,
  formatUsdcAmount
} from '../../../shared/utils/locale-format';

function formatEntryDate(ts: number, locale: AppLocale): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts).toLocaleString(dateLocaleFor(locale));
}

function coinLabel(row: ReinvestmentHistoryEntry): string {
  const symbol = row.coinSymbol.trim();
  return symbol || row.coinId;
}

export const ReinvestmentHistoryPage: React.FC = () => {
  const t = useT();
  const { locale } = useI18n();
  const [entries, setEntries] = useState<ReinvestmentHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getMyReinvestmentHistory();
      if (data === null) {
        setEntries([]);
        setLoadError(t('wallet.reinvestmentHistoryLoadError'));
        return;
      }
      setEntries(data);
    } catch {
      setEntries([]);
      setLoadError(t('wallet.reinvestmentHistoryLoadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = entries.filter((row) => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return true;
    return (
      row.coinId.toLowerCase().includes(q) || row.coinSymbol.toLowerCase().includes(q)
    );
  });

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-2">
          <History className="text-orange-500 shrink-0" size={28} />
          {t('wallet.reinvestmentHistoryTitle')}
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t('wallet.reinvestmentHistorySubtitle')}
        </p>
      </header>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            placeholder={t('wallet.searchReinvestmentCoin')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 text-slate-800 dark:text-slate-100"
          />
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center justify-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white rounded-lg text-sm font-bold transition-all shadow-lg shadow-orange-900/20"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          {loading ? '…' : t('inventory.refresh')}
        </button>
      </div>

      {loadError ? (
        <div className="text-sm text-amber-700 dark:text-amber-300 py-1 px-1">{loadError}</div>
      ) : null}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[760px]">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 text-[10px] uppercase tracking-wider font-bold">
                <th className="px-4 py-3">{t('wallet.colDate')}</th>
                <th className="px-4 py-3">{t('wallet.colCoin')}</th>
                <th className="px-4 py-3">{t('wallet.colSold')}</th>
                <th className="px-4 py-3">{t('wallet.colGrossUsdc')}</th>
                <th className="px-4 py-3">{t('wallet.colFeeUsdc')}</th>
                <th className="px-4 py-3">{t('wallet.colNetUsdc')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-12 text-center text-slate-500 dark:text-slate-400 text-sm italic"
                  >
                    {loading
                      ? t('wallet.reinvestmentHistoryLoading')
                      : loadError
                        ? loadError
                        : t('wallet.reinvestmentHistoryEmpty')}
                  </td>
                </tr>
              ) : (
                filtered.map((row) => (
                  <tr
                    key={row.id}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                  >
                    <td className="px-4 py-3 text-xs font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                      {formatEntryDate(row.createdAt, locale)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 dark:text-slate-200">
                        <Coins size={14} className="text-orange-500" />
                        {coinLabel(row)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-sm text-slate-700 dark:text-slate-200">
                      {formatMinedCoinAmount(row.soldCrypto)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 font-mono text-sm">
                        <DollarSign size={14} />
                        {formatUsdcAmount(row.grossUsdc, locale, {
                          minFractionDigits: 2,
                          maxFractionDigits: 2
                        })}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-sm text-amber-600 dark:text-amber-400">
                      {formatUsdcAmount(row.feeUsdc, locale, {
                        minFractionDigits: 2,
                        maxFractionDigits: 2
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400 font-mono font-bold text-sm">
                        <DollarSign size={14} />
                        {formatUsdcAmount(row.netUsdc, locale, {
                          minFractionDigits: 2,
                          maxFractionDigits: 2
                        })}
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
  );
};
