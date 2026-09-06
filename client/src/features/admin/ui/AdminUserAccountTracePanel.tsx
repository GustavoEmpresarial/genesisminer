// @ts-nocheck — markup legado; o client usa strict+noUnusedLocals.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  Loader2,
  Download,
  AlertTriangle,
  Package,
  ShoppingCart,
  Store,
  Cpu,
  Wallet
} from 'lucide-react';
import {
  getAdminUserAccountTrace,
  type AdminAccountTraceResponse,
  type AdminAccountTraceTimelineEvent
} from '../../../shared/api/admin-users';
import { formatActivityLogBrt } from './AdminActivityLogTable';

export type AdminUserAccountTracePanelProps = {
  userId: number | null;
};

const TIMELINE_FILTERS: { id: string; label: string; test: (e: AdminAccountTraceTimelineEvent) => boolean }[] = [
  { id: 'all', label: 'Todas', test: () => true },
  { id: 'p2p', label: 'P2P', test: (e) => e.category === 'p2p' || /^p2p_/.test(e.action) },
  { id: 'shop', label: 'Loja', test: (e) => /shop|hardware_buy/.test(e.action) },
  { id: 'inventory', label: 'Inventário', test: (e) => e.category === 'inventory' || /stock|inventory/.test(e.action) },
  { id: 'rigs', label: 'Rigs', test: (e) => e.category === 'rigs' || /^rack_/.test(e.action) },
  { id: 'economy', label: 'Economia', test: (e) => e.category === 'economy' || /deposit|exchange|wallet/.test(e.action) },
  { id: 'boxes', label: 'Caixas', test: (e) => e.category === 'boxes' || /box|promo|roleta|lucky/.test(e.action) }
];

function fmtUsdc(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function exportTraceCsv(data: AdminAccountTraceResponse): void {
  const lines: string[] = ['secção,campo,valor'];
  const s = data.summary;
  lines.push(`resumo,userId,${s.userId}`);
  lines.push(`resumo,email,${s.email}`);
  lines.push(`resumo,usdc,${s.usdc}`);
  lines.push(`resumo,blackMarket,${s.blackMarketBalance}`);
  for (const row of data.itemDisposition) {
    lines.push(
      `item,${row.itemId},adq=${row.acquired};stock=${row.inStock};rig=${row.onRigs.length};p2p=${row.listedP2p};vendido=${row.soldP2p};sem_loc=${row.unaccounted};${row.hint}`
    );
  }
  for (const e of data.timeline) {
    lines.push(`timeline,${new Date(e.atMs).toISOString()},${e.title};${e.summary}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rastreio_${s.userId}_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export const AdminUserAccountTracePanel: React.FC<AdminUserAccountTracePanelProps> = ({ userId }) => {
  const [data, setData] = useState<AdminAccountTraceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timelineFilter, setTimelineFilter] = useState('all');
  const [dispositionFilter, setDispositionFilter] = useState('');
  const [showUnaccountedOnly, setShowUnaccountedOnly] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getAdminUserAccountTrace(userId, { timelineLimit: 100 });
      if (res.error || !res.data) {
        setError(res.error || 'Falha ao carregar rastreio');
        setData(null);
      } else {
        setData(res.data);
      }
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredDisposition = useMemo(() => {
    if (!data) return [];
    let rows = data.itemDisposition;
    if (showUnaccountedOnly) rows = rows.filter((r) => r.unaccounted > 0);
    const q = dispositionFilter.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (r) => r.itemId.toLowerCase().includes(q) || r.itemName.toLowerCase().includes(q) || r.hint.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [data, dispositionFilter, showUnaccountedOnly]);

  const filteredTimeline = useMemo(() => {
    if (!data) return [];
    const f = TIMELINE_FILTERS.find((x) => x.id === timelineFilter) ?? TIMELINE_FILTERS[0];
    return data.timeline.filter(f.test);
  }, [data, timelineFilter]);

  if (!userId) {
    return <p className="text-sm text-slate-500 italic">Utilizador não identificado.</p>;
  }

  if (loading && !data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="animate-spin text-slate-500" size={28} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="rounded-lg border border-red-800/50 bg-red-950/30 px-3 py-2 text-sm text-red-200">{error}</div>
    );
  }

  if (!data) return null;

  const s = data.summary;
  const stockQty = data.currentInventory.reduce((a, i) => a + i.qty, 0);
  const rigMiners = data.currentRigs.reduce((a, r) => a + r.miners.length, 0);

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <p className="text-xs text-slate-500">
          Rastreio unificado — estado actual, P2P, loja, caixas e timeline.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => exportTraceCsv(data)}
            className="px-2 py-1 text-[10px] font-bold uppercase bg-slate-800 text-slate-300 rounded flex items-center gap-1 hover:bg-slate-700"
          >
            <Download size={12} /> Exportar CSV
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="px-2 py-1 text-[10px] font-bold uppercase bg-slate-800 text-slate-300 rounded flex items-center gap-1 hover:bg-slate-700 disabled:opacity-50"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Actualizar
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
          <div className="flex items-center gap-1 text-[10px] uppercase text-slate-500 font-bold">
            <Wallet size={12} /> USDC
          </div>
          <div className="text-lg font-bold text-emerald-400">{fmtUsdc(s.usdc)}</div>
          <div className="text-[10px] text-slate-500">Mercado negro: {fmtUsdc(s.blackMarketBalance)}</div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
          <div className="flex items-center gap-1 text-[10px] uppercase text-slate-500 font-bold">
            <Package size={12} /> Stock
          </div>
          <div className="text-lg font-bold text-slate-200">{data.currentInventory.length} tipos</div>
          <div className="text-[10px] text-slate-500">{stockQty} unidades</div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
          <div className="flex items-center gap-1 text-[10px] uppercase text-slate-500 font-bold">
            <Cpu size={12} /> Rigs
          </div>
          <div className="text-lg font-bold text-slate-200">{data.currentRigs.length} rigs</div>
          <div className="text-[10px] text-slate-500">{rigMiners} miners montados</div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
          <div className="flex items-center gap-1 text-[10px] uppercase text-slate-500 font-bold">
            <Store size={12} /> P2P activo
          </div>
          <div className="text-lg font-bold text-slate-200">{data.currentMarket.length}</div>
          <div className="text-[10px] text-slate-500">Hash total: {s.totalHash.toFixed(2)}</div>
        </div>
      </div>

      <section>
        <h3 className="text-xs font-bold uppercase text-amber-500 mb-2 flex items-center gap-1">
          <AlertTriangle size={14} /> Onde está cada item
        </h3>
        <div className="flex flex-wrap gap-2 mb-2">
          <input
            type="search"
            placeholder="Filtrar item…"
            value={dispositionFilter}
            onChange={(e) => setDispositionFilter(e.target.value)}
            className="flex-1 min-w-[140px] px-2 py-1 text-xs bg-slate-900 border border-slate-700 rounded"
          />
          <label className="flex items-center gap-1 text-[10px] text-slate-400">
            <input
              type="checkbox"
              checked={showUnaccountedOnly}
              onChange={(e) => setShowUnaccountedOnly(e.target.checked)}
            />
            Só sem localização
          </label>
        </div>
        <div className="rounded-lg border border-slate-700 overflow-x-auto max-h-64 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-500 uppercase text-[10px] sticky top-0">
              <tr>
                <th className="px-2 py-2">Item</th>
                <th className="px-2 py-2">Adq.</th>
                <th className="px-2 py-2">Stock</th>
                <th className="px-2 py-2">Rig</th>
                <th className="px-2 py-2">P2P</th>
                <th className="px-2 py-2">Vendido</th>
                <th className="px-2 py-2">?</th>
                <th className="px-2 py-2">Nota</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filteredDisposition.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-slate-500 italic">
                    Nenhum item corresponde ao filtro.
                  </td>
                </tr>
              ) : (
                filteredDisposition.map((row) => (
                  <tr key={row.itemId} className={row.unaccounted > 0 ? 'bg-red-950/20' : ''}>
                    <td className="px-2 py-1.5">
                      <div className="font-medium text-slate-200">{row.itemName}</div>
                      <div className="font-mono text-[9px] text-slate-600">{row.itemId}</div>
                    </td>
                    <td className="px-2 py-1.5">{row.acquired}</td>
                    <td className="px-2 py-1.5">{row.inStock}</td>
                    <td className="px-2 py-1.5">{row.onRigs.length}</td>
                    <td className="px-2 py-1.5">{row.listedP2p}</td>
                    <td className="px-2 py-1.5">{row.soldP2p}</td>
                    <td className="px-2 py-1.5 font-bold text-red-400">{row.unaccounted > 0 ? row.unaccounted : '—'}</td>
                    <td className="px-2 py-1.5 text-[10px] text-slate-400 max-w-[200px]">{row.hint}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="text-xs font-bold uppercase text-amber-500 mb-2">Mercado P2P</h3>
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <h4 className="text-[10px] font-bold text-slate-500 mb-1">Vendeu ({data.p2p.sold.length})</h4>
            <ul className="text-xs space-y-1 max-h-32 overflow-y-auto">
              {data.p2p.sold.slice(0, 20).map((t) => (
                <li key={t.id} className="text-slate-300">
                  {formatActivityLogBrt(t.atMs)} — {t.qty}× {t.itemName} → #{t.counterpartyUserId} ({fmtUsdc(t.totalUsdc)} USDC)
                </li>
              ))}
              {data.p2p.sold.length === 0 && <li className="text-slate-500 italic">Nenhuma venda registada.</li>}
            </ul>
          </div>
          <div>
            <h4 className="text-[10px] font-bold text-slate-500 mb-1">Comprou ({data.p2p.bought.length})</h4>
            <ul className="text-xs space-y-1 max-h-32 overflow-y-auto">
              {data.p2p.bought.slice(0, 20).map((t) => (
                <li key={t.id} className="text-slate-300">
                  {formatActivityLogBrt(t.atMs)} — {t.qty}× {t.itemName} de #{t.counterpartyUserId} ({fmtUsdc(t.totalUsdc)} USDC)
                </li>
              ))}
              {data.p2p.bought.length === 0 && <li className="text-slate-500 italic">Nenhuma compra registada.</li>}
            </ul>
          </div>
        </div>
        {data.currentMarket.length > 0 && (
          <div className="mt-2">
            <h4 className="text-[10px] font-bold text-slate-500 mb-1">Anúncios activos</h4>
            <ul className="text-xs space-y-1">
              {data.currentMarket.map((l) => (
                <li key={l.listingId} className="text-slate-300">
                  {l.qty}× {l.itemName} — {fmtUsdc(l.price)} USDC · {l.status}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section>
        <h3 className="text-xs font-bold uppercase text-amber-500 mb-2 flex items-center gap-1">
          <ShoppingCart size={14} /> Loja & caixas
        </h3>
        <div className="grid md:grid-cols-2 gap-3 text-xs">
          <div className="max-h-36 overflow-y-auto space-y-1">
            {data.shopPurchases.slice(0, 15).map((sh, i) => (
              <div key={`${sh.atMs}-${i}`} className="text-slate-300">
                {formatActivityLogBrt(sh.atMs)} — {fmtUsdc(sh.totalCost)} USDC —{' '}
                {sh.lines.map((l) => `${l.qty}× ${l.name || l.id}`).join(', ')}
              </div>
            ))}
            {data.shopPurchases.length === 0 && <p className="text-slate-500 italic">Sem compras na lojinha.</p>}
          </div>
          <div className="max-h-36 overflow-y-auto space-y-1">
            {data.boxOpenings.slice(0, 15).map((b) => (
              <div key={b.id} className="text-slate-300">
                {formatActivityLogBrt(b.atMs)} — caixa {b.boxId.slice(0, 8)}…
                {b.gainedUsdc > 0 ? ` +${fmtUsdc(b.gainedUsdc)} USDC` : ''}
              </div>
            ))}
            {data.boxOpenings.length === 0 && <p className="text-slate-500 italic">Sem aberturas de caixa.</p>}
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-xs font-bold uppercase text-amber-500 mb-2">Rigs (miners montados)</h3>
        <div className="space-y-2 max-h-48 overflow-y-auto text-xs">
          {data.currentRigs.map((r) => (
            <div key={r.rackId} className="rounded border border-slate-800 p-2 bg-slate-900/30">
              <div className="font-mono text-[10px] text-slate-500">{r.rackId.slice(0, 12)}… · {r.chassisName} · {r.roomId || '—'}</div>
              <div className="text-slate-300 mt-1">
                {r.miners.length === 0
                  ? 'Sem miners'
                  : r.miners.map((m) => `slot ${m.slotIndex}: ${m.itemName}`).join(' · ')}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h3 className="text-xs font-bold uppercase text-amber-500">Timeline unificada</h3>
          <select
            value={timelineFilter}
            onChange={(e) => setTimelineFilter(e.target.value)}
            className="text-[10px] bg-slate-900 border border-slate-700 rounded px-2 py-1"
          >
            {TIMELINE_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <span className="text-[10px] text-slate-500">
            {filteredTimeline.length} de {data.timeline.length} evento(s)
          </span>
        </div>
        <div className="rounded-lg border border-slate-700 overflow-hidden max-h-80 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-500 uppercase text-[10px] sticky top-0">
              <tr>
                <th className="px-2 py-2">Data (BRT)</th>
                <th className="px-2 py-2">Evento</th>
                <th className="px-2 py-2">Resumo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filteredTimeline.map((e) => (
                <tr key={e.id} className="hover:bg-slate-800/40">
                  <td className="px-2 py-1.5 font-mono text-[10px] text-slate-400 whitespace-nowrap">
                    {formatActivityLogBrt(e.atMs)}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="font-medium text-slate-200">{e.title}</div>
                    <div className="text-[9px] text-slate-600 font-mono">{e.action}</div>
                  </td>
                  <td className="px-2 py-1.5 text-slate-300">
                    {e.summary}
                    {e.lines?.map((ln, i) => (
                      <div key={i} className="text-[10px] text-slate-500">
                        · {ln}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
