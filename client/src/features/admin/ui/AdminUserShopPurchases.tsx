import React, { useCallback, useEffect, useState } from 'react';
import { Store } from 'lucide-react';
import {
  getAdminShopCheckouts,
  type AdminShopCheckoutsResult
} from '../../../shared/api/admin-users';
import { formatUsdcAmount } from '../../../shared/utils/locale-format';

function formatWhen(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts).toLocaleString('pt-BR', {
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

const EMPTY_RESULT: AdminShopCheckoutsResult = {
  ok: true,
  rows: [],
  byItem: [],
  totalCost: 0,
  itemQty: 0,
  checkoutCount: 0,
  truncated: false,
  limit: 0
};

export const AdminUserShopPurchases: React.FC<{ userId: number | null }> = ({ userId }) => {
  const [result, setResult] = useState<AdminShopCheckoutsResult>(EMPTY_RESULT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: number) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getAdminShopCheckouts({ userId: String(id) });
      setResult(data);
      if (!data.ok) setError(data.error ?? 'Não foi possível carregar as compras.');
    } catch {
      setResult(EMPTY_RESULT);
      setError('Erro de rede.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (userId == null || !Number.isFinite(userId) || userId <= 0) {
      setResult(EMPTY_RESULT);
      setError(null);
      return;
    }
    void load(userId);
  }, [load, userId]);

  if (userId == null || userId <= 0) {
    return <p className="text-sm text-slate-400">Seleciona um utilizador para ver as compras da loja.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
        Compras da loja desta conta. O débito sai do saldo USDC do jogo, não da carteira OpenSea. Cada
        item fica numa linha; o total USDC é o do checkout (o carrinho inteiro).
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">USDC gasto</p>
          <p className="text-base font-black text-amber-400">{formatUsdcAmount(result.totalCost, 'pt-BR')}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Qtd de itens</p>
          <p className="text-base font-black text-white">{result.itemQty}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Checkouts</p>
          <p className="text-base font-black text-white">{result.checkoutCount}</p>
        </div>
      </div>

      {loading && <p className="text-sm text-slate-400">A carregar compras…</p>}
      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      {result.truncated && (
        <p className="text-xs text-amber-300" role="status">
          A lista abaixo mostra os {result.limit} checkouts mais recentes. Os totais e a tabela por item
          cobrem o histórico inteiro ({result.checkoutCount} checkouts).
        </p>
      )}

      <div className="rounded-xl border border-slate-700 overflow-hidden">
        <div className="px-3 py-2 border-b border-slate-700 flex items-center gap-2 bg-slate-900">
          <Store size={16} className="text-amber-500" />
          <h4 className="text-xs font-bold uppercase text-slate-300">Por item</h4>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px] min-w-[720px]">
            <thead className="bg-slate-950 text-slate-500 uppercase text-[9px] font-bold">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Id</th>
                <th className="px-3 py-2">Qtd</th>
                <th className="px-3 py-2">Checkouts</th>
                <th className="px-3 py-2">Primeira</th>
                <th className="px-3 py-2">Última</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {result.byItem.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-slate-500 italic">
                    {loading ? '…' : 'Nenhuma compra da loja nesta conta.'}
                  </td>
                </tr>
              ) : (
                result.byItem.map((item) => (
                  <tr key={item.id}>
                    <td className="px-3 py-2 text-slate-100 font-bold">{item.name || item.id}</td>
                    <td className="px-3 py-2 font-mono text-slate-400">{item.id}</td>
                    <td className="px-3 py-2 font-mono text-white">{item.qty}</td>
                    <td className="px-3 py-2 font-mono text-slate-300">{item.checkouts}</td>
                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{formatWhen(item.firstAt)}</td>
                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{formatWhen(item.lastAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-bold uppercase text-slate-500">Cada compra</h4>
        {result.rows.length === 0 && !loading ? (
          <p className="text-sm text-slate-500 italic">Sem checkouts para listar.</p>
        ) : (
          result.rows.map((row) => (
            <article key={`${row.userId}-${row.id}`} className="rounded-xl border border-slate-700 bg-slate-900/60 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                <p className="text-xs font-mono text-amber-200">{formatWhen(row.createdAt)}</p>
                <p className="text-xs text-slate-300">
                  Total {formatUsdcAmount(row.totalCost, 'pt-BR')} · saldo depois{' '}
                  {formatUsdcAmount(row.newUsdc, 'pt-BR')}
                </p>
              </div>
              <table className="w-full text-left text-[11px]">
                <thead className="text-slate-500 uppercase text-[9px] font-bold">
                  <tr>
                    <th className="py-1 pr-2">Item</th>
                    <th className="py-1 pr-2">Id</th>
                    <th className="py-1">Qtd</th>
                  </tr>
                </thead>
                <tbody>
                  {row.lines.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-2 text-slate-500 italic">
                        Checkout sem linhas de item.
                      </td>
                    </tr>
                  ) : (
                    row.lines.map((line) => (
                      <tr key={`${row.id}-${line.id}`} className="border-t border-slate-800">
                        <td className="py-1.5 pr-2 text-slate-100">{line.name || line.id}</td>
                        <td className="py-1.5 pr-2 font-mono text-slate-400">{line.id}</td>
                        <td className="py-1.5 font-mono text-white">{line.qty}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </article>
          ))
        )}
      </div>
    </div>
  );
};
