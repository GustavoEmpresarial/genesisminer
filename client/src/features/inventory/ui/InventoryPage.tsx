/**
 * Inventory / depot — self-fetch from GET /api/inventory/state.
 * DECISIONS #104.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useT } from '../../../shared/i18n';
import { getInventoryState, type InventoryStatePayload } from '../../../shared/api/inventory';
import { InventoryView } from './InventoryView';

export function InventoryPage() {
  const t = useT();
  const [data, setData] = useState<InventoryStatePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getInventoryState();
    if (!res.ok) {
      setError(res.error === 'NETWORK' ? t('inventory.networkError') : res.error);
      setData(null);
    } else {
      setData(res.data);
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 py-20 text-slate-500">
        <Loader2 className="animate-spin" size={20} />
        {t('inventory.loading')}
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-20 text-center">
        <p className="text-sm text-red-400">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-600/20 px-4 py-2 text-sm font-bold text-amber-200 hover:bg-amber-600/30"
        >
          <RefreshCw size={14} /> {t('inventory.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex-1">
      <button
        type="button"
        onClick={() => void load()}
        className="absolute top-4 right-4 z-10 rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-amber-300"
        title={t('inventory.refresh')}
        aria-label={t('inventory.refreshTitle')}
      >
        <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
      </button>
      <InventoryView
        stackableCategories={data?.stackableCategories ?? []}
        storedBatteries={data?.storedBatteries ?? []}
      />
    </div>
  );
}
