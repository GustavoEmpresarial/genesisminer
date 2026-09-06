import React, { useEffect, useState } from 'react';
import { useT } from '../../../shared/i18n';
import {
  Search,
  Filter,
  RefreshCw,
  Clock,
  CheckCircle,
  XCircle,
  Coins,
  DollarSign,
  ExternalLink,
  History
} from 'lucide-react';
import { getMyWithdrawalHistory, type WithdrawalHistoryEntry, getWeb3Settings } from '../../../shared/api/wallet';
import { findWithdrawTokenCfg } from '../../../shared/utils/withdrawTokenMatch';

function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts).toLocaleString('pt-BR');
}

function getNetworkInfo(network?: string, symbol?: string) {
  const net = String(network || '').trim().toLowerCase();
  const s = symbol?.toUpperCase() || '';
  if (net === 'bnb' || ['BNB', 'DOGE', 'TRX'].includes(s)) {
    return { explorer: 'https://bscscan.com' };
  }
  if (net === 'base' || ['SOL', 'ETH', 'WETH'].includes(s)) {
    return { explorer: 'https://basescan.org' };
  }
  return { explorer: 'https://polygonscan.com' };
}

function StatusBadge({ status }: { status: string }) {
  const t = useT();
  switch (status) {
    case 'pending':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
          <Clock size={10} /> {t('wallet.historyPending').toUpperCase()}
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-1 text-[10px] font-bold text-green-700 dark:bg-green-900/30 dark:text-green-400">
          <CheckCircle size={10} /> {t('wallet.historyCompleted').toUpperCase()}
        </span>
      );
    case 'rejected':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-1 text-[10px] font-bold text-red-700 dark:bg-red-900/30 dark:text-red-400">
          <XCircle size={10} /> {t('wallet.historyRejected').toUpperCase()}
        </span>
      );
    default:
      return (
        <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {status}
        </span>
      );
  }
}

export const WithdrawalHistoryPage: React.FC = () => {
  const t = useT();
  const [requests, setRequests] = useState<WithdrawalHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'completed' | 'rejected'>('all');
  const [withdrawTokens, setWithdrawTokens] = useState<Array<{ name?: string; symbol?: string; coinId?: string; network?: 'polygon' | 'bnb' | 'base' }> | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await getMyWithdrawalHistory();
      setRequests(data);
    } catch {
      setRequests([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    void (async () => {
      const settings = await getWeb3Settings();
      setWithdrawTokens(Array.isArray(settings?.withdrawTokens) ? settings!.withdrawTokens : []);
    })();
  }, []);

  const filtered = requests.filter((req) => {
    const q = searchTerm.trim().toLowerCase();
    const matchesSearch =
      !q ||
      req.walletAddress?.toLowerCase().includes(q) ||
      req.coinSymbol?.toLowerCase().includes(q);
    const matchesStatus = statusFilter === 'all' || req.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-2">
          <History className="text-amber-500 shrink-0" size={28} />
          {t('wallet.withdrawHistoryTitle')}
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t('wallet.withdrawHistorySubtitle')}
        </p>
      </header>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 flex-1">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              type="text"
              placeholder={t('wallet.searchTokenWallet')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 text-slate-800 dark:text-slate-100"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter size={18} className="text-slate-400 shrink-0" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm p-2 focus:outline-none focus:ring-2 focus:ring-amber-500 text-slate-700 dark:text-slate-300"
            >
              <option value="all">{t('wallet.historyAll')}</option>
              <option value="pending">{t('wallet.historyPending')}</option>
              <option value="completed">{t('wallet.historyCompleted')}</option>
              <option value="rejected">{t('wallet.historyRejected')}</option>
            </select>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center justify-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg text-sm font-bold transition-all shadow-lg shadow-amber-900/20"
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
                <th className="px-4 py-3">{t('wallet.colTokenQty')}</th>
                <th className="px-4 py-3">{t('wallet.colUsdcValue')}</th>
                <th className="px-4 py-3">{t('wallet.colDestWallet')}</th>
                <th className="px-4 py-3 text-center">Tx</th>
                <th className="px-4 py-3">{t('wallet.colStatus')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-500 dark:text-slate-400 text-sm italic">
                    {loading ? 'A carregar pedidos…' : 'Ainda não fizeste nenhum pedido de saque.'}
                  </td>
                </tr>
              ) : (
                filtered.map((req) => {
                  const tokenCfg = findWithdrawTokenCfg(withdrawTokens, {
                    id: req.coinId,
                    symbol: req.coinSymbol
                  });
                  const explorer = getNetworkInfo(tokenCfg?.network, req.coinSymbol).explorer;
                  return (
                    <tr
                      key={req.id}
                      className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                    >
                      <td className="px-4 py-3 text-xs font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                        {formatDate(req.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-amber-600 dark:text-amber-400 shrink-0">
                            <Coins size={16} />
                          </div>
                          <div className="flex flex-col">
                            <span className="text-sm font-bold font-mono text-slate-700 dark:text-slate-200">
                              {req.amountCrypto.toLocaleString('en-US', { maximumFractionDigits: 8 })}{' '}
                              {req.coinSymbol}
                            </span>
                            {req.feeAmount > 0 && (
                              <span className="text-[10px] text-red-500">
                                Taxa: −{req.feeAmount.toLocaleString('en-US', { maximumFractionDigits: 8 })}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400 font-mono font-bold text-sm">
                          <DollarSign size={14} />
                          {Number(req.amountUsdc).toFixed(2)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 max-w-[200px]">
                          <span
                            className="text-[10px] font-mono text-slate-500 truncate bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded flex-1"
                            title={req.walletAddress}
                          >
                            {req.walletAddress || '—'}
                          </span>
                          {req.walletAddress ? (
                            <a
                              href={`${explorer}/address/${req.walletAddress}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-slate-400 hover:text-amber-500 shrink-0"
                              title={t('wallet.viewWalletExplorer')}
                            >
                              <ExternalLink size={14} />
                            </a>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {req.txHash ? (
                          <a
                            href={`${explorer}/tx/${req.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[10px] font-mono text-amber-600 dark:text-amber-400 hover:underline"
                            title={req.txHash}
                          >
                            {req.txHash.slice(0, 6)}…{req.txHash.slice(-4)}
                            <ExternalLink size={10} />
                          </a>
                        ) : (
                          <span className="text-[10px] text-slate-400 italic">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={req.status} />
                        {req.status !== 'pending' && req.processedAt ? (
                          <div className="text-[9px] text-slate-400 mt-1">{formatDate(req.processedAt)}</div>
                        ) : null}
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
