import React, { useEffect, useState } from 'react';
import { useT } from '../../../shared/i18n';
import {
  Search,
  RefreshCw,
  DollarSign,
  ExternalLink,
  History,
  ArrowDownCircle
} from 'lucide-react';
import { getMyDepositHistory, type DepositHistoryEntry } from '../../../shared/api/wallet';

function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts).toLocaleString('pt-BR');
}

function getNetworkExplorer(network?: string): string {
  const net = String(network || '').trim().toLowerCase();
  if (net === 'bnb' || net === 'bsc') return 'https://bscscan.com';
  if (net === 'base') return 'https://basescan.org';
  return 'https://polygonscan.com';
}

function formatNetworkLabel(network?: string): string {
  const net = String(network || '').trim().toLowerCase();
  if (net === 'bnb' || net === 'bsc') return 'BNB Chain';
  if (net === 'base') return 'Base';
  if (net === 'polygon' || net === 'matic') return 'Polygon';
  return net || '—';
}

export const DepositHistoryPage: React.FC = () => {
  const t = useT();
  const [deposits, setDeposits] = useState<DepositHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await getMyDepositHistory();
      setDeposits(data);
    } catch {
      setDeposits([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = deposits.filter((dep) => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return true;
    return (
      dep.walletAddress?.toLowerCase().includes(q) ||
      dep.txHash?.toLowerCase().includes(q) ||
      dep.network?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-2">
          <History className="text-green-500 shrink-0" size={28} />
          {t('wallet.depositHistoryTitle')}
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t('wallet.depositHistorySubtitle')}
        </p>
      </header>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            placeholder={t('wallet.searchWalletTxNetwork')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 text-slate-800 dark:text-slate-100"
          />
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center justify-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-lg text-sm font-bold transition-all shadow-lg shadow-green-900/20"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          {loading ? '…' : t('inventory.refresh')}
        </button>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[760px]">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 text-[10px] uppercase tracking-wider font-bold">
                <th className="px-4 py-3">{t('wallet.colDate')}</th>
                <th className="px-4 py-3">{t('wallet.colUsdcValue')}</th>
                <th className="px-4 py-3">{t('wallet.network')}</th>
                <th className="px-4 py-3">{t('wallet.originWallet')}</th>
                <th className="px-4 py-3 text-center">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-slate-500 dark:text-slate-400 text-sm italic">
                    {loading ? 'A carregar depósitos…' : 'Ainda não tens depósitos registados.'}
                  </td>
                </tr>
              ) : (
                filtered.map((dep) => {
                  const explorer = getNetworkExplorer(dep.network);
                  return (
                    <tr
                      key={dep.id}
                      className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                    >
                      <td className="px-4 py-3 text-xs font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                        {formatDate(dep.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400 font-mono font-bold text-sm">
                          <DollarSign size={14} />
                          {dep.amountUsdc != null && dep.amountUsdc > 0
                            ? Number(dep.amountUsdc).toFixed(2)
                            : '—'}
                        </span>
                        {dep.amountUsdc == null && (
                          <div className="text-[9px] text-slate-400 mt-0.5">{t('wallet.historicalValueUnavailable')}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
                          <ArrowDownCircle size={14} className="text-green-500" />
                          {formatNetworkLabel(dep.network)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 max-w-[200px]">
                          <span
                            className="text-[10px] font-mono text-slate-500 truncate bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded flex-1"
                            title={dep.walletAddress}
                          >
                            {dep.walletAddress || '—'}
                          </span>
                          {dep.walletAddress ? (
                            <a
                              href={`${explorer}/address/${dep.walletAddress}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-slate-400 hover:text-green-500 shrink-0"
                              title={t('wallet.viewWalletExplorer')}
                            >
                              <ExternalLink size={14} />
                            </a>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {dep.txHash ? (
                          <a
                            href={`${explorer}/tx/${dep.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[10px] font-mono text-green-600 dark:text-green-400 hover:underline"
                            title={dep.txHash}
                          >
                            {dep.txHash.slice(0, 6)}…{dep.txHash.slice(-4)}
                            <ExternalLink size={10} />
                          </a>
                        ) : (
                          <span className="text-[10px] text-slate-400 italic">—</span>
                        )}
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
  );
};
