import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, Store } from 'lucide-react';
import {
  getAdminPurchasesReport,
  type AdminPurchasesReportResult
} from '../../../shared/api/admin-users';
import {
  ADMIN_SHOP_ITEM_ID_MAX,
  ADMIN_SHOP_SEARCH_MAX
} from '../../../shared/constants/formLimits';
import { formatUsdcAmount } from '../../../shared/utils/locale-format';

function formatWhen(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function localInputToMs(value: string): string {
  const t = value.trim();
  if (!t) return '';
  const ms = new Date(t).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return String(Math.floor(ms));
}

const EMPTY: AdminPurchasesReportResult = {
  ok: true,
  sources: [],
  byItem: [],
  topBuyersShop: [],
  topBuyersP2p: [],
  recentShop: [],
  recentSeason: [],
  recentP2p: [],
  seasonTotals: {
    totalUsdc: 0,
    passCount: 0,
    buyers: 0
  },
  p2pSalesTotals: {
    totalReceivedUsdc: 0,
    totalTaxUsdc: 0,
    tradeCount: 0,
    itemQty: 0
  },
  shopTruncated: false,
  limit: 0
};

export const AdminShopCheckouts: React.FC = () => {
  const [itemId, setItemId] = useState('');
  const [userId, setUserId] = useState('');
  const [search, setSearch] = useState('');
  const [fromLocal, setFromLocal] = useState('');
  const [toLocal, setToLocal] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'shop' | 'p2p'>('all');
  const [result, setResult] = useState<AdminPurchasesReportResult>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (filters: {
      itemId: string;
      userId: string;
      q: string;
      fromMs: string;
      toMs: string;
    }) => {
      setLoading(true);
      setError(null);
      try {
        const data = await getAdminPurchasesReport(filters);
        setResult(data);
        if (!data.ok) setError(data.error ?? 'Não foi possível carregar o relatório.');
      } catch {
        setResult(EMPTY);
        setError('Erro de rede.');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load({ itemId: '', userId: '', q: '', fromMs: '', toMs: '' });
  }, [load]);

  const apply = () => {
    void load({
      itemId,
      userId,
      q: search,
      fromMs: localInputToMs(fromLocal),
      toMs: localInputToMs(toLocal)
    });
  };

  const filteredItems = useMemo(() => {
    if (sourceFilter === 'all') return result.byItem;
    return result.byItem.filter((row) => row.source === sourceFilter);
  }, [result.byItem, sourceFilter]);

  const shop = result.sources.find((s) => s.id === 'shop');
  const p2p = result.sources.find((s) => s.id === 'p2p');

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        Relatório geral de compras. Loja = saldo USDC do jogo (não OpenSea). P2P = compra a outro
        jogador no mercado interno.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <p className="text-xs uppercase tracking-wider text-slate-400 font-bold">Loja</p>
          <p className="mt-1 text-2xl font-black text-amber-400">
            {formatUsdcAmount(shop?.usdc ?? 0, 'pt-BR')}
          </p>
          <p className="mt-2 text-sm text-slate-300">
            {shop?.itemQty ?? 0} itens · {shop?.events ?? 0} checkouts · {shop?.buyers ?? 0}{' '}
            compradores
          </p>
          <p className="mt-1 text-xs text-slate-500">{shop?.hint}</p>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <p className="text-xs uppercase tracking-wider text-slate-400 font-bold">Mercado P2P</p>
          <p className="mt-1 text-2xl font-black text-emerald-400">
            {formatUsdcAmount(p2p?.usdc ?? 0, 'pt-BR')}
          </p>
          <p className="mt-2 text-sm text-slate-300">
            {p2p?.itemQty ?? 0} itens · {p2p?.events ?? 0} compras · {p2p?.buyers ?? 0} compradores
          </p>
          <p className="mt-1 text-xs text-slate-500">{p2p?.hint}</p>
        </div>
      </div>

      <form
        className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <p className="text-sm font-bold text-white">Filtros</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          <label className="text-sm text-slate-300 font-semibold">
            Item (id)
            <input
              type="text"
              value={itemId}
              maxLength={ADMIN_SHOP_ITEM_ID_MAX}
              onChange={(e) => setItemId(e.target.value)}
              placeholder="ex. nft"
              className="mt-1 w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-normal text-slate-100"
            />
          </label>
          <label className="text-sm text-slate-300 font-semibold">
            User id
            <input
              type="text"
              inputMode="numeric"
              value={userId}
              onChange={(e) => setUserId(e.target.value.replace(/\D/g, ''))}
              placeholder="17"
              className="mt-1 w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-normal text-slate-100"
            />
          </label>
          <label className="text-sm text-slate-300 font-semibold">
            Nick ou email
            <div className="relative mt-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input
                type="text"
                value={search}
                maxLength={ADMIN_SHOP_SEARCH_MAX}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="usuário ou email"
                className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-normal text-slate-100"
              />
            </div>
          </label>
          <label className="text-sm text-slate-300 font-semibold">
            Desde
            <input
              type="datetime-local"
              value={fromLocal}
              onChange={(e) => setFromLocal(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-normal text-slate-100"
            />
          </label>
          <label className="text-sm text-slate-300 font-semibold">
            Até
            <input
              type="datetime-local"
              value={toLocal}
              onChange={(e) => setToLocal(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-normal text-slate-100"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg text-sm font-bold"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          {loading ? 'A carregar…' : 'Aplicar filtros'}
        </button>
      </form>

      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="rounded-xl border border-slate-800 overflow-hidden bg-slate-900">
        <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap items-center gap-2">
          <Store className="text-amber-500" size={18} />
          <h3 className="text-sm font-bold text-white uppercase tracking-wide">Por item</h3>
          <div className="ml-auto flex flex-wrap gap-2">
            {(
              [
                { id: 'all', label: 'Todas as origens' },
                { id: 'shop', label: 'Só loja' },
                { id: 'p2p', label: 'Só P2P' }
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setSourceFilter(opt.id)}
                className={`px-3 py-1.5 rounded-lg text-sm font-bold ${
                  sourceFilter === opt.id
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm min-w-[960px]">
            <thead className="bg-slate-950 text-slate-400 uppercase text-xs font-bold">
              <tr>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Id</th>
                <th className="px-4 py-3">Onde</th>
                <th className="px-4 py-3">Qtd</th>
                <th className="px-4 py-3">Eventos</th>
                <th className="px-4 py-3">Compradores</th>
                <th className="px-4 py-3">USDC</th>
                <th className="px-4 py-3">Primeira</th>
                <th className="px-4 py-3">Última</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-slate-400">
                    {loading ? 'A carregar…' : 'Nenhuma compra neste filtro.'}
                  </td>
                </tr>
              ) : (
                filteredItems.map((row) => (
                  <tr key={`${row.source}-${row.id}`}>
                    <td className="px-4 py-3 font-bold text-white">{row.name || row.id}</td>
                    <td className="px-4 py-3 font-mono text-slate-400">{row.id}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                          row.source === 'shop'
                            ? 'bg-amber-900/50 text-amber-200'
                            : 'bg-emerald-900/50 text-emerald-200'
                        }`}
                      >
                        {row.sourceLabel || row.source}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-white">{row.qty}</td>
                    <td className="px-4 py-3 font-mono text-slate-300">{row.events}</td>
                    <td className="px-4 py-3 font-mono text-slate-300">{row.buyers}</td>
                    <td className="px-4 py-3 font-mono text-amber-300">
                      {formatUsdcAmount(row.usdc, 'pt-BR')}
                    </td>
                    <td className="px-4 py-3 text-slate-400 whitespace-nowrap">{formatWhen(row.firstAt)}</td>
                    <td className="px-4 py-3 text-slate-400 whitespace-nowrap">{formatWhen(row.lastAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <BuyersTable title="Top compradores — Loja" rows={result.topBuyersShop} loading={loading} />
        <BuyersTable title="Top compradores — P2P" rows={result.topBuyersP2p} loading={loading} />
      </div>

      <div className="rounded-xl border border-slate-800 overflow-hidden bg-slate-900">
        <div className="px-4 py-3 border-b border-slate-800">
          <h3 className="text-sm font-bold text-white uppercase tracking-wide">
            Checkouts recentes da loja
          </h3>
          {result.shopTruncated && (
            <p className="mt-1 text-xs text-amber-300">
              Lista limitada aos {result.limit} mais recentes. Os totais e a tabela por item cobrem o
              filtro inteiro.
            </p>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm min-w-[900px]">
            <thead className="bg-slate-950 text-slate-400 uppercase text-xs font-bold">
              <tr>
                <th className="px-4 py-3">Quando</th>
                <th className="px-4 py-3">Quem</th>
                <th className="px-4 py-3">Itens</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">Saldo depois</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {result.recentShop.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-slate-400">
                    {loading ? 'A carregar…' : 'Sem checkouts da loja neste filtro.'}
                  </td>
                </tr>
              ) : (
                result.recentShop.map((row) => (
                  <tr key={`${row.userId}-${row.id}`}>
                    <td className="px-4 py-3 text-slate-400 whitespace-nowrap">
                      {formatWhen(row.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-bold text-white">{row.username || `#${row.userId}`}</div>
                      <div className="text-xs text-slate-500">{row.email}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {row.lines.length === 0
                        ? '—'
                        : row.lines
                            .map((line) => `${line.name || line.id} × ${line.qty}`)
                            .join(', ')}
                    </td>
                    <td className="px-4 py-3 font-mono font-bold text-amber-300 whitespace-nowrap">
                      {formatUsdcAmount(row.totalCost, 'pt-BR')}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-300 whitespace-nowrap">
                      {formatUsdcAmount(row.newUsdc, 'pt-BR')}
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

function BuyersTable({
  title,
  rows,
  loading
}: {
  title: string;
  rows: AdminPurchasesReportResult['topBuyersShop'];
  loading: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-800 overflow-hidden bg-slate-900">
      <div className="px-4 py-3 border-b border-slate-800">
        <h3 className="text-sm font-bold text-white uppercase tracking-wide">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-950 text-slate-400 uppercase text-xs font-bold">
            <tr>
              <th className="px-4 py-3">Jogador</th>
              <th className="px-4 py-3">USDC</th>
              <th className="px-4 py-3">Eventos</th>
              <th className="px-4 py-3">Itens</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  {loading ? 'A carregar…' : 'Sem dados.'}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={`${row.source}-${row.userId}`}>
                  <td className="px-4 py-3">
                    <div className="font-bold text-white">{row.username || `#${row.userId}`}</div>
                    <div className="text-xs text-slate-500">{row.email}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-amber-300">
                    {formatUsdcAmount(row.usdc, 'pt-BR')}
                  </td>
                  <td className="px-4 py-3 font-mono text-slate-300">{row.events}</td>
                  <td className="px-4 py-3 font-mono text-slate-300">{row.itemQty}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
