import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Store,
  Ticket,
  ArrowLeftRight,
  Package,
  Search,
  RefreshCw,
  Loader2,
  DollarSign,
  TrendingDown,
  TrendingUp,
  Layers,
  Clock,
  AlertCircle
} from 'lucide-react';
import {
  getAdminPurchasesReport,
  type AdminPurchasesReportResult,
  type AdminPurchaseItemRow,
  type AdminShopCheckoutRow,
  type AdminSeasonPurchaseRow,
  type AdminP2pTradeRow
} from '../../../shared/api/admin-users';
import { formatUsdcAmount } from '../../../shared/utils/locale-format';

function formatWhen(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

type HubSubTab = 'items' | 'ledger' | 'shop' | 'season' | 'p2p';

export type AdminUserPurchasesHubProps = {
  userId: number | null;
  userEmail: string;
};

export const AdminUserPurchasesHub: React.FC<AdminUserPurchasesHubProps> = ({
  userId,
  userEmail: _userEmail
}) => {
  const [activeSubTab, setActiveSubTab] = useState<HubSubTab>('items');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AdminPurchasesReportResult | null>(null);

  // Filtros internos
  const [searchItem, setSearchItem] = useState('');
  const [originFilter, setOriginFilter] = useState<'all' | 'shop' | 'season' | 'p2p'>('all');
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState<'all' | 'shop' | 'season' | 'p2p_buy' | 'p2p_sell'>('all');
  const [p2pRoleFilter, setP2pRoleFilter] = useState<'all' | 'buy' | 'sell'>('all');

  const loadData = useCallback(async () => {
    if (userId == null || !Number.isFinite(userId) || userId <= 0) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await getAdminPurchasesReport({ userId: String(userId) });
      if (res.error && !res.ok) {
        setError(res.error);
      } else {
        setData(res);
      }
    } catch {
      setError('Erro de conexão ao carregar dados financeiros.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Cálculos de KPIs consolidados
  const kpis = useMemo(() => {
    if (!data) {
      return {
        shopTotal: 0,
        shopCheckouts: 0,
        shopItemQty: 0,
        seasonTotal: 0,
        seasonCount: 0,
        p2pBuyTotal: 0,
        p2pBuyCount: 0,
        p2pBuyQty: 0,
        p2pSellTotal: 0,
        p2pSellTax: 0,
        p2pSellCount: 0,
        p2pSellQty: 0,
        grossSpent: 0,
        netSpent: 0
      };
    }

    const shopSource = data.sources.find((s) => s.id === 'shop');
    const seasonSource = data.sources.find((s) => s.id === 'season');
    const p2pBuySource = data.sources.find((s) => s.id === 'p2p');
    const p2pSellSource = data.sources.find((s) => s.id === 'p2p_sell');

    const shopTotal = shopSource?.usdc ?? 0;
    const shopCheckouts = shopSource?.events ?? 0;
    const shopItemQty = shopSource?.itemQty ?? 0;

    const seasonTotal = seasonSource?.usdc ?? data.seasonTotals?.totalUsdc ?? 0;
    const seasonCount = seasonSource?.events ?? data.seasonTotals?.passCount ?? 0;

    const p2pBuyTotal = p2pBuySource?.usdc ?? 0;
    const p2pBuyCount = p2pBuySource?.events ?? 0;
    const p2pBuyQty = p2pBuySource?.itemQty ?? 0;

    const p2pSellTotal = p2pSellSource?.usdc ?? data.p2pSalesTotals?.totalReceivedUsdc ?? 0;
    const p2pSellTax = data.p2pSalesTotals?.totalTaxUsdc ?? 0;
    const p2pSellCount = p2pSellSource?.events ?? data.p2pSalesTotals?.tradeCount ?? 0;
    const p2pSellQty = p2pSellSource?.itemQty ?? data.p2pSalesTotals?.itemQty ?? 0;

    const grossSpent = shopTotal + seasonTotal + p2pBuyTotal;
    const netSpent = grossSpent - p2pSellTotal;

    return {
      shopTotal,
      shopCheckouts,
      shopItemQty,
      seasonTotal,
      seasonCount,
      p2pBuyTotal,
      p2pBuyCount,
      p2pBuyQty,
      p2pSellTotal,
      p2pSellTax,
      p2pSellCount,
      p2pSellQty,
      grossSpent,
      netSpent
    };
  }, [data]);

  // Lista agregada de itens ("Total de Compra em Cada Item") filtrada
  const filteredByItem = useMemo(() => {
    if (!data?.byItem) return [];
    let list = data.byItem;
    if (originFilter !== 'all') {
      list = list.filter((item) => item.source === originFilter);
    }
    const q = searchItem.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (item) =>
          item.id.toLowerCase().includes(q) ||
          item.name.toLowerCase().includes(q) ||
          item.sourceLabel.toLowerCase().includes(q)
      );
    }
    return list;
  }, [data?.byItem, originFilter, searchItem]);

  // Extrato unificado "Compra por Compra" (Ledger Cronológico)
  type LedgerEntry = {
    id: string;
    createdAt: number;
    kind: 'shop' | 'season' | 'p2p_buy' | 'p2p_sell';
    kindLabel: string;
    title: string;
    description: string;
    counterparty: string;
    qty: number;
    unitPrice: number;
    totalUsdc: number;
    linesCount?: number;
    linesPreview?: string;
  };

  const unifiedLedger = useMemo(() => {
    if (!data) return [];
    const entries: LedgerEntry[] = [];

    // 1. Loja Oficial
    for (const shop of data.recentShop) {
      const linesDesc = shop.lines
        .map((l) => `${l.qty}x ${l.name || l.id}`)
        .join(', ');
      const totalQty = shop.lines.reduce((sum, l) => sum + (l.qty || 0), 0);
      entries.push({
        id: `shop:${shop.id}`,
        createdAt: shop.createdAt,
        kind: 'shop',
        kindLabel: 'Loja Oficial',
        title: `Compra na Loja (${shop.lines.length} itens)`,
        description: linesDesc || 'Checkout da loja',
        counterparty: 'Genesis Store',
        qty: totalQty || 1,
        unitPrice: totalQty > 0 ? shop.totalCost / totalQty : shop.totalCost,
        totalUsdc: shop.totalCost,
        linesCount: shop.lines.length,
        linesPreview: linesDesc
      });
    }

    // 2. Passes de Temporada
    for (const pass of data.recentSeason) {
      entries.push({
        id: `season:${pass.id}`,
        createdAt: pass.purchasedAt,
        kind: 'season',
        kindLabel: 'Passe de Temporada',
        title: pass.passName || pass.passId,
        description: `Temporada: ${pass.seasonId || 'Ativa'} · ID: ${pass.passId}`,
        counterparty: 'Genesis DAO',
        qty: 1,
        unitPrice: pass.priceUsdc,
        totalUsdc: pass.priceUsdc
      });
    }

    // 3. Mercado P2P (Compras e Vendas)
    for (const trade of data.recentP2p) {
      const isSeller = trade.role === 'seller';
      const kind = isSeller ? ('p2p_sell' as const) : ('p2p_buy' as const);
      const kindLabel = isSeller ? 'Venda P2P' : 'Compra P2P';
      const counterparty = isSeller
        ? trade.buyerUsername || trade.buyerEmail || `ID #${trade.buyerId}`
        : trade.sellerUsername || trade.sellerEmail || `ID #${trade.sellerId}`;

      entries.push({
        id: `p2p:${trade.id}`,
        createdAt: trade.createdAt,
        kind,
        kindLabel,
        title: trade.itemName || trade.itemId,
        description: `ID: ${trade.itemId} · Preço Unit: ${formatUsdcAmount(trade.unitPrice, 'pt-BR')}${trade.taxUsdc > 0 ? ` · Taxa: ${formatUsdcAmount(trade.taxUsdc, 'pt-BR')}` : ''}`,
        counterparty,
        qty: trade.qty,
        unitPrice: trade.unitPrice,
        totalUsdc: isSeller ? trade.sellerReceivedUsdc : trade.buyerPaidUsdc
      });
    }

    // Ordenação decrescente por data
    entries.sort((a, b) => b.createdAt - a.createdAt);

    // Filtros de busca e tipo
    return entries.filter((e) => {
      if (ledgerTypeFilter !== 'all' && e.kind !== ledgerTypeFilter) return false;
      const q = searchItem.trim().toLowerCase();
      if (!q) return true;
      return (
        e.title.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.counterparty.toLowerCase().includes(q) ||
        e.kindLabel.toLowerCase().includes(q)
      );
    });
  }, [data, ledgerTypeFilter, searchItem]);

  // Lista P2P filtrada
  const filteredP2pTrades = useMemo(() => {
    if (!data?.recentP2p) return [];
    let list = data.recentP2p;
    if (p2pRoleFilter === 'buy') list = list.filter((t) => t.role === 'buyer');
    if (p2pRoleFilter === 'sell') list = list.filter((t) => t.role === 'seller');
    const q = searchItem.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (t) =>
          t.itemId.toLowerCase().includes(q) ||
          t.itemName.toLowerCase().includes(q) ||
          t.buyerUsername.toLowerCase().includes(q) ||
          t.sellerUsername.toLowerCase().includes(q)
      );
    }
    return list;
  }, [data?.recentP2p, p2pRoleFilter, searchItem]);

  if (userId == null || userId <= 0) {
    return (
      <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-6 text-center text-slate-400">
        Selecione um jogador para visualizar o histórico de compras e gastos.
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in">
      {/* HEADER DE RECARREGAR & STATUS */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700/80 pb-4">
        <div>
          <h3 className="text-lg font-black tracking-wide text-white flex items-center gap-2">
            <DollarSign size={20} className="text-amber-500" />
            Central de Gastos & Transações Financeiras
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Rastreamento completo e consolidado de gastos na lojinha, passes de época e negociações P2P do jogador.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadData()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-xs font-bold text-slate-300 transition-colors hover:bg-slate-700 hover:text-white disabled:opacity-50 shadow-sm"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin text-amber-500' : ''} />
          {loading ? 'Atualizando…' : 'Recarregar Gastos'}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200">
          <AlertCircle size={16} className="text-rose-400 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* TOP CARDS: KPIS EXECUTIVOS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {/* KPI 1: Loja Oficial */}
        <div className="rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 via-slate-900 to-slate-900 p-3.5 shadow-sm">
          <div className="flex items-center justify-between text-amber-400 mb-1">
            <span className="text-[10px] uppercase font-black tracking-wider text-slate-400">
              Loja Oficial
            </span>
            <Store size={15} />
          </div>
          <p className="text-xl font-black text-amber-300">
            {formatUsdcAmount(kpis.shopTotal, 'pt-BR')}
          </p>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-400">
            <span>{kpis.shopCheckouts} checkouts</span>
            <span className="font-mono text-slate-300">{kpis.shopItemQty} itens</span>
          </div>
        </div>

        {/* KPI 2: Passes de Temporada */}
        <div className="rounded-xl border border-purple-500/30 bg-gradient-to-br from-purple-500/10 via-slate-900 to-slate-900 p-3.5 shadow-sm">
          <div className="flex items-center justify-between text-purple-400 mb-1">
            <span className="text-[10px] uppercase font-black tracking-wider text-slate-400">
              Passes de Temporada
            </span>
            <Ticket size={15} />
          </div>
          <p className="text-xl font-black text-purple-300">
            {formatUsdcAmount(kpis.seasonTotal, 'pt-BR')}
          </p>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-400">
            <span>Passes adquiridos</span>
            <span className="font-mono text-purple-200 font-bold">{kpis.seasonCount} un.</span>
          </div>
        </div>

        {/* KPI 3: Compras P2P */}
        <div className="rounded-xl border border-sky-500/30 bg-gradient-to-br from-sky-500/10 via-slate-900 to-slate-900 p-3.5 shadow-sm">
          <div className="flex items-center justify-between text-sky-400 mb-1">
            <span className="text-[10px] uppercase font-black tracking-wider text-slate-400">
              Compras P2P
            </span>
            <TrendingDown size={15} />
          </div>
          <p className="text-xl font-black text-sky-300">
            {formatUsdcAmount(kpis.p2pBuyTotal, 'pt-BR')}
          </p>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-400">
            <span>{kpis.p2pBuyCount} compras</span>
            <span className="font-mono text-slate-300">{kpis.p2pBuyQty} itens</span>
          </div>
        </div>

        {/* KPI 4: Vendas P2P */}
        <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-slate-900 to-slate-900 p-3.5 shadow-sm">
          <div className="flex items-center justify-between text-emerald-400 mb-1">
            <span className="text-[10px] uppercase font-black tracking-wider text-slate-400">
              Vendas P2P
            </span>
            <TrendingUp size={15} />
          </div>
          <p className="text-xl font-black text-emerald-300">
            {formatUsdcAmount(kpis.p2pSellTotal, 'pt-BR')}
          </p>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-400">
            <span>{kpis.p2pSellCount} vendas</span>
            <span className="font-mono text-slate-300">Taxas: {formatUsdcAmount(kpis.p2pSellTax, 'pt-BR')}</span>
          </div>
        </div>

        {/* KPI 5: Gasto Líquido / Balanço */}
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-3.5 shadow-sm">
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-[10px] uppercase font-black tracking-wider text-slate-400">
              Balanço Geral
            </span>
            <DollarSign size={15} className="text-amber-500" />
          </div>
          <p
            className={`text-xl font-black ${
              kpis.netSpent > 0 ? 'text-amber-400' : 'text-emerald-400'
            }`}
          >
            {formatUsdcAmount(kpis.netSpent, 'pt-BR')}
          </p>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-400">
            <span>Bruto Gasto:</span>
            <span className="font-mono text-slate-300">{formatUsdcAmount(kpis.grossSpent, 'pt-BR')}</span>
          </div>
        </div>
      </div>

      {/* NAVEGAÇÃO DE SUB-ABAS */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-2">
        <div className="flex flex-wrap items-center gap-1.5 bg-slate-950/60 p-1 rounded-xl border border-slate-800">
          <button
            type="button"
            onClick={() => setActiveSubTab('items')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'items'
                ? 'bg-amber-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
            }`}
          >
            <Package size={14} />
            Total por Item ({data?.byItem.length || 0})
          </button>

          <button
            type="button"
            onClick={() => setActiveSubTab('ledger')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'ledger'
                ? 'bg-amber-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
            }`}
          >
            <Layers size={14} />
            Compra por Compra ({unifiedLedger.length})
          </button>

          <button
            type="button"
            onClick={() => setActiveSubTab('shop')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'shop'
                ? 'bg-amber-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
            }`}
          >
            <Store size={14} />
            Loja Oficial ({data?.recentShop.length || 0})
          </button>

          <button
            type="button"
            onClick={() => setActiveSubTab('season')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'season'
                ? 'bg-amber-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
            }`}
          >
            <Ticket size={14} />
            Passes ({data?.recentSeason.length || 0})
          </button>

          <button
            type="button"
            onClick={() => setActiveSubTab('p2p')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeSubTab === 'p2p'
                ? 'bg-amber-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
            }`}
          >
            <ArrowLeftRight size={14} />
            Mercado P2P ({data?.recentP2p.length || 0})
          </button>
        </div>

        {/* BARRA DE PESQUISA RÁPIDA */}
        <div className="relative min-w-[240px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={searchItem}
            onChange={(e) => setSearchItem(e.target.value)}
            placeholder="Filtrar por item, jogador ou ID…"
            className="w-full rounded-lg border border-slate-700 bg-slate-900/80 pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none"
          />
        </div>
      </div>

      {loading && !data && (
        <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-3">
          <Loader2 size={28} className="animate-spin text-amber-500" />
          <p className="text-xs">Carregando relatório financeiro detalhado…</p>
        </div>
      )}

      {/* ========================================================================= */}
      {/* SUB-ABA 1: TOTAL POR ITEM ("CONSOLIDADO POR ITEM")                        */}
      {/* ========================================================================= */}
      {activeSubTab === 'items' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-slate-400">Origem:</span>
              <button
                type="button"
                onClick={() => setOriginFilter('all')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${
                  originFilter === 'all'
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Todas ({data?.byItem.length || 0})
              </button>
              <button
                type="button"
                onClick={() => setOriginFilter('shop')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${
                  originFilter === 'shop'
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Loja Oficial
              </button>
              <button
                type="button"
                onClick={() => setOriginFilter('season')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${
                  originFilter === 'season'
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Passes de Temporada
              </button>
              <button
                type="button"
                onClick={() => setOriginFilter('p2p')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${
                  originFilter === 'p2p'
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Mercado P2P
              </button>
            </div>
            <span className="text-xs text-slate-400">
              {filteredByItem.length} item(ns) listado(s)
            </span>
          </div>

          <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 overflow-hidden shadow-lg">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs min-w-[760px]">
                <thead className="bg-slate-950/80 text-slate-400 uppercase text-[10px] font-black border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3">Item / Descrição</th>
                    <th className="px-3 py-3">ID do Item</th>
                    <th className="px-3 py-3">Origem</th>
                    <th className="px-3 py-3 text-right">Qtd Acumulada</th>
                    <th className="px-3 py-3 text-right">Total Gasto (USDC)</th>
                    <th className="px-3 py-3 text-right">Preço Médio</th>
                    <th className="px-3 py-3 text-center">Operações</th>
                    <th className="px-4 py-3">Primeira Compra</th>
                    <th className="px-4 py-3">Última Compra</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredByItem.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-slate-500 italic">
                        {loading ? 'Carregando itens…' : 'Nenhum item encontrado com os filtros selecionados.'}
                      </td>
                    </tr>
                  ) : (
                    filteredByItem.map((item: AdminPurchaseItemRow) => {
                      const avgPrice = item.qty > 0 ? item.usdc / item.qty : 0;
                      return (
                        <tr key={`${item.source}-${item.id}`} className="hover:bg-slate-800/40 transition-colors">
                          <td className="px-4 py-2.5 font-bold text-slate-100 flex items-center gap-2">
                            {item.source === 'shop' && <Store size={14} className="text-amber-400 shrink-0" />}
                            {item.source === 'season' && <Ticket size={14} className="text-purple-400 shrink-0" />}
                            {item.source === 'p2p' && <ArrowLeftRight size={14} className="text-sky-400 shrink-0" />}
                            <span>{item.name || item.id}</span>
                          </td>
                          <td className="px-3 py-2.5 font-mono text-slate-400 text-[11px]">{item.id}</td>
                          <td className="px-3 py-2.5">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                item.source === 'shop'
                                  ? 'bg-amber-500/10 text-amber-300 border border-amber-500/30'
                                  : item.source === 'season'
                                  ? 'bg-purple-500/10 text-purple-300 border border-purple-500/30'
                                  : 'bg-sky-500/10 text-sky-300 border border-sky-500/30'
                              }`}
                            >
                              {item.sourceLabel || item.source}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono font-bold text-white">
                            {item.qty.toLocaleString('pt-BR')}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono font-black text-amber-300">
                            {formatUsdcAmount(item.usdc, 'pt-BR')}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-slate-300">
                            {formatUsdcAmount(avgPrice, 'pt-BR')}
                          </td>
                          <td className="px-3 py-2.5 text-center font-mono text-slate-400">
                            {item.events}
                          </td>
                          <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap text-[11px]">
                            {formatWhen(item.firstAt)}
                          </td>
                          <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap text-[11px]">
                            {formatWhen(item.lastAt)}
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
      )}

      {/* ========================================================================= */}
      {/* SUB-ABA 2: COMPRA POR COMPRA ("EXTRATO GERAL CRONOLÓGICO")                */}
      {/* ========================================================================= */}
      {activeSubTab === 'ledger' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-slate-400">Tipo:</span>
              <button
                type="button"
                onClick={() => setLedgerTypeFilter('all')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${
                  ledgerTypeFilter === 'all'
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Todas as Compras
              </button>
              <button
                type="button"
                onClick={() => setLedgerTypeFilter('shop')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${
                  ledgerTypeFilter === 'shop'
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Só Loja Oficial
              </button>
              <button
                type="button"
                onClick={() => setLedgerTypeFilter('season')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${
                  ledgerTypeFilter === 'season'
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Só Passes de Temporada
              </button>
              <button
                type="button"
                onClick={() => setLedgerTypeFilter('p2p_buy')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${
                  ledgerTypeFilter === 'p2p_buy'
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Compras P2P
              </button>
              <button
                type="button"
                onClick={() => setLedgerTypeFilter('p2p_sell')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${
                  ledgerTypeFilter === 'p2p_sell'
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Vendas P2P
              </button>
            </div>
            <span className="text-xs text-slate-400">
              {unifiedLedger.length} transações registradas
            </span>
          </div>

          <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 overflow-hidden shadow-lg">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs min-w-[760px]">
                <thead className="bg-slate-950/80 text-slate-400 uppercase text-[10px] font-black border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3">Data / Hora (BRT)</th>
                    <th className="px-3 py-3">Origem</th>
                    <th className="px-4 py-3">Item / Operação</th>
                    <th className="px-3 py-3">Contraparte</th>
                    <th className="px-3 py-3 text-right">Qtd</th>
                    <th className="px-3 py-3 text-right">Preço Unit.</th>
                    <th className="px-4 py-3 text-right">Valor Total (USDC)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {unifiedLedger.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-500 italic">
                        {loading ? 'Carregando extrato…' : 'Nenhuma transação encontrada no histórico.'}
                      </td>
                    </tr>
                  ) : (
                    unifiedLedger.map((entry) => {
                      const isSell = entry.kind === 'p2p_sell';
                      return (
                        <tr key={entry.id} className="hover:bg-slate-800/40 transition-colors">
                          <td className="px-4 py-2.5 text-slate-300 font-mono text-[11px] whitespace-nowrap">
                            {formatWhen(entry.createdAt)}
                          </td>
                          <td className="px-3 py-2.5">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                entry.kind === 'shop'
                                  ? 'bg-amber-500/10 text-amber-300 border border-amber-500/30'
                                  : entry.kind === 'season'
                                  ? 'bg-purple-500/10 text-purple-300 border border-purple-500/30'
                                  : isSell
                                  ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                                  : 'bg-sky-500/10 text-sky-300 border border-sky-500/30'
                              }`}
                            >
                              {entry.kindLabel}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <p className="font-bold text-white text-xs">{entry.title}</p>
                            <p className="text-[11px] text-slate-400 line-clamp-1">{entry.description}</p>
                          </td>
                          <td className="px-3 py-2.5 text-slate-300 font-mono text-[11px]">
                            {entry.counterparty}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-white">
                            {entry.qty}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-slate-400">
                            {formatUsdcAmount(entry.unitPrice, 'pt-BR')}
                          </td>
                          <td
                            className={`px-4 py-2.5 text-right font-mono font-black ${
                              isSell ? 'text-emerald-400' : 'text-amber-400'
                            }`}
                          >
                            {isSell ? '+' : '-'}
                            {formatUsdcAmount(entry.totalUsdc, 'pt-BR')}
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
      )}

      {/* ========================================================================= */}
      {/* SUB-ABA 3: DETALHE DA LOJA OFICIAL (CHECKOUTS & CARRINHOS)                */}
      {/* ========================================================================= */}
      {activeSubTab === 'shop' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Checkouts Realizados na Loja ({data?.recentShop.length || 0})
            </h4>
            <span className="text-xs text-slate-400">
              Débito efetuado do saldo USDC in-game.
            </span>
          </div>

          {data?.recentShop.length === 0 && !loading ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-slate-500 italic">
              Nenhuma compra na loja oficial para este jogador.
            </div>
          ) : (
            <div className="space-y-3">
              {data?.recentShop.map((row: AdminShopCheckoutRow) => (
                <article
                  key={`${row.userId}-${row.id}`}
                  className="rounded-xl border border-slate-700/80 bg-slate-900/70 p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2 mb-3">
                    <div className="flex items-center gap-2">
                      <Clock size={14} className="text-amber-400" />
                      <span className="text-xs font-mono font-bold text-amber-200">
                        {formatWhen(row.createdAt)}
                      </span>
                      <span className="text-[10px] text-slate-500 font-mono">ID: {row.id}</span>
                    </div>
                    <div className="text-xs">
                      <span className="text-slate-400">Total Pago: </span>
                      <span className="font-mono font-black text-amber-300">
                        {formatUsdcAmount(row.totalCost, 'pt-BR')}
                      </span>
                      <span className="text-slate-500 mx-2">|</span>
                      <span className="text-slate-400">Saldo Após: </span>
                      <span className="font-mono text-slate-300">
                        {formatUsdcAmount(row.newUsdc, 'pt-BR')}
                      </span>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="text-slate-400 uppercase text-[9px] font-bold border-b border-slate-800/80">
                        <tr>
                          <th className="py-1.5 pr-3">Item Comprado</th>
                          <th className="py-1.5 pr-3">Identificador (ID)</th>
                          <th className="py-1.5 text-right">Quantidade</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/40">
                        {row.lines.length === 0 ? (
                          <tr>
                            <td colSpan={3} className="py-2 text-slate-500 italic">
                              Checkout sem linhas discriminadas.
                            </td>
                          </tr>
                        ) : (
                          row.lines.map((line) => (
                            <tr key={`${row.id}-${line.id}`}>
                              <td className="py-1.5 pr-3 text-slate-100 font-bold">
                                {line.name || line.id}
                              </td>
                              <td className="py-1.5 pr-3 font-mono text-slate-400 text-[11px]">
                                {line.id}
                              </td>
                              <td className="py-1.5 text-right font-mono font-bold text-white">
                                {line.qty}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* SUB-ABA 4: PASSES DE TEMPORADA                                            */}
      {/* ========================================================================= */}
      {activeSubTab === 'season' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Passes de Temporada Adquiridos ({data?.recentSeason.length || 0})
            </h4>
            <span className="text-xs text-purple-300 font-semibold">
              Total investido: {formatUsdcAmount(kpis.seasonTotal, 'pt-BR')}
            </span>
          </div>

          {data?.recentSeason.length === 0 && !loading ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-slate-500 italic">
              Nenhum passe de temporada adquirido por este jogador.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {data?.recentSeason.map((pass: AdminSeasonPurchaseRow) => (
                <div
                  key={pass.id}
                  className="rounded-xl border border-purple-500/30 bg-purple-950/20 p-4 flex items-start gap-3.5 shadow-sm"
                >
                  <div className="rounded-lg bg-purple-900/40 p-2.5 text-purple-300 border border-purple-500/30 shrink-0">
                    <Ticket size={24} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <h5 className="text-sm font-black text-white truncate">
                        {pass.passName || pass.passId}
                      </h5>
                      <span className="text-xs font-mono font-black text-purple-300">
                        {formatUsdcAmount(pass.priceUsdc, 'pt-BR')}
                      </span>
                    </div>
                    <p className="text-xs text-purple-200/70 font-mono mt-0.5">
                      Temporada: {pass.seasonId || 'Padrão'} · ID: {pass.passId}
                    </p>
                    <div className="mt-2.5 flex items-center justify-between border-t border-purple-900/40 pt-2 text-[11px] text-slate-400">
                      <span>Adquirido em:</span>
                      <span className="text-slate-300 font-mono">{formatWhen(pass.purchasedAt)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* SUB-ABA 5: MERCADO P2P (COMPRAS E VENDAS DETALHADAS)                      */}
      {/* ========================================================================= */}
      {activeSubTab === 'p2p' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-slate-400">Operações:</span>
              <button
                type="button"
                onClick={() => setP2pRoleFilter('all')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${
                  p2pRoleFilter === 'all'
                    ? 'bg-amber-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Todas ({data?.recentP2p.length || 0})
              </button>
              <button
                type="button"
                onClick={() => setP2pRoleFilter('buy')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${
                  p2pRoleFilter === 'buy'
                    ? 'bg-sky-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Compras ({kpis.p2pBuyCount})
              </button>
              <button
                type="button"
                onClick={() => setP2pRoleFilter('sell')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${
                  p2pRoleFilter === 'sell'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Vendas ({kpis.p2pSellCount})
              </button>
            </div>
            <div className="text-xs text-slate-400">
              Taxa retida pela plataforma em vendas: {formatUsdcAmount(kpis.p2pSellTax, 'pt-BR')}
            </div>
          </div>

          <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 overflow-hidden shadow-lg">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs min-w-[760px]">
                <thead className="bg-slate-950/80 text-slate-400 uppercase text-[10px] font-black border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3">Data / Hora (BRT)</th>
                    <th className="px-3 py-3">Tipo</th>
                    <th className="px-4 py-3">Item Negociado</th>
                    <th className="px-3 py-3">Contraparte</th>
                    <th className="px-3 py-3 text-right">Qtd</th>
                    <th className="px-3 py-3 text-right">Preço Unit.</th>
                    <th className="px-3 py-3 text-right">Valor Negociado</th>
                    <th className="px-4 py-3 text-right">Líquido do Jogador</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredP2pTrades.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-slate-500 italic">
                        {loading ? 'Carregando negociações…' : 'Nenhuma negociação P2P registrada para os critérios.'}
                      </td>
                    </tr>
                  ) : (
                    filteredP2pTrades.map((trade: AdminP2pTradeRow) => {
                      const isSeller = trade.role === 'seller';
                      const counterpartyName = isSeller
                        ? trade.buyerUsername || trade.buyerEmail || `#${trade.buyerId}`
                        : trade.sellerUsername || trade.sellerEmail || `#${trade.sellerId}`;

                      return (
                        <tr key={trade.id} className="hover:bg-slate-800/40 transition-colors">
                          <td className="px-4 py-2.5 text-slate-300 font-mono text-[11px] whitespace-nowrap">
                            {formatWhen(trade.createdAt)}
                          </td>
                          <td className="px-3 py-2.5">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                isSeller
                                  ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                                  : 'bg-sky-500/10 text-sky-300 border border-sky-500/30'
                              }`}
                            >
                              {isSeller ? 'Venda P2P' : 'Compra P2P'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <p className="font-bold text-white text-xs">{trade.itemName || trade.itemId}</p>
                            <p className="text-[10px] font-mono text-slate-500">{trade.itemId}</p>
                          </td>
                          <td className="px-3 py-2.5 text-slate-300 font-mono text-[11px]">
                            {counterpartyName}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono font-bold text-white">
                            {trade.qty}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-slate-400">
                            {formatUsdcAmount(trade.unitPrice, 'pt-BR')}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-slate-300">
                            {formatUsdcAmount(trade.buyerPaidUsdc, 'pt-BR')}
                          </td>
                          <td
                            className={`px-4 py-2.5 text-right font-mono font-black ${
                              isSeller ? 'text-emerald-400' : 'text-sky-400'
                            }`}
                          >
                            {isSeller ? '+' : '-'}
                            {formatUsdcAmount(
                              isSeller ? trade.sellerReceivedUsdc : trade.buyerPaidUsdc,
                              'pt-BR'
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
      )}
    </div>
  );
};
