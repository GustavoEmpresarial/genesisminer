/**
 * Depot UI — stackable categories + battery instances from inventory state.
 * DECISIONS #104.
 */
import { Package, Battery, Activity, Hexagon } from 'lucide-react';
import { useT } from '../../../shared/i18n';
import type {
  InventoryBatteryInstance,
  InventoryStackableCategory,
  InventoryStackableRow
} from '../../../shared/api/inventory';
import { normalizePublicAssetUrl } from '../../../shared/utils/public-url';

type InventoryViewProps = {
  stackableCategories: InventoryStackableCategory[];
  storedBatteries: InventoryBatteryInstance[];
};

/** Capacidade -1 no catálogo = bateria infinita (Estelar, etc.). */
function isInfiniteBatteryCapacity(cap: number): boolean {
  return cap === -1;
}

function formatBatteryCapacity(cap: number): string {
  return isInfiniteBatteryCapacity(cap) ? '∞' : `${cap} Wh`;
}

function formatProduction(val: number) {
  if (val < 0.0001) return val.toFixed(8);
  if (val < 1) {
    return val.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(val);
}

function StackableCard({ row }: { row: InventoryStackableRow }) {
  const t = useT();
  const hasImage = normalizePublicAssetUrl(row.image) || row.image;
  const isRack = row.type === 'infrastructure';
  const isMachine = row.type === 'machine';
  const qty =
    row.displayQuantity !== row.availableQuantity
      ? `${row.availableQuantity}/${row.displayQuantity}`
      : String(row.displayQuantity);
  const containerAspectRatio = isRack
    ? 'aspect-[5/6]'
    : isMachine
      ? 'aspect-video'
      : 'aspect-square';

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-all hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700">
      {row.isNft ? (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded bg-orange-600 px-1.5 py-0.5 text-[9px] text-white shadow-lg">
          <Hexagon size={8} /> {t('inventory.nft')}
        </div>
      ) : null}

      <div className="mb-3 flex items-start justify-between">
        <div
          className={`${containerAspectRatio} flex w-20 items-center justify-center overflow-hidden rounded border border-slate-200 bg-slate-50 text-3xl shadow-inner dark:border-slate-800 dark:bg-slate-950`}
        >
          {hasImage ? (
            <img
              src={hasImage}
              className={`h-full w-full ${isRack ? 'object-contain' : 'object-cover'}`}
              alt=""
            />
          ) : (
            row.icon
          )}
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[10px] uppercase text-slate-500">{t('inventory.quantity')}</span>
          <span className="font-mono text-2xl font-bold text-slate-900 dark:text-white">{qty}</span>
        </div>
      </div>

      <div className="mb-4">
        <h4 className="truncate font-bold text-slate-800 dark:text-slate-200">{row.name}</h4>
        <p className="mt-1 line-clamp-2 min-h-[2.5em] text-xs text-slate-500">{row.description}</p>
      </div>

      <div className="mt-auto grid grid-cols-2 gap-2 rounded border border-slate-100 bg-slate-50 p-2 font-mono text-xs dark:border-slate-800/50 dark:bg-slate-950/50">
        {row.type === 'machine' ? (
          <div className="col-span-2 flex justify-between">
            <span className="flex items-center gap-1 text-slate-500">
              <Activity size={10} /> {t('inventory.hash')}
            </span>
            <span className="text-green-600 dark:text-green-400">
              +{formatProduction(row.baseProduction)} H/s
            </span>
          </div>
        ) : null}
        {row.type === 'battery' ? (
          <div className="col-span-2 flex justify-between">
            <span className="flex items-center gap-1 text-slate-500">
              <Battery size={10} /> {t('inventory.capacity')}
            </span>
            <span className="text-yellow-600 dark:text-yellow-400">
              {formatBatteryCapacity(row.powerCapacity)}
            </span>
          </div>
        ) : null}
        {row.type === 'infrastructure' ? (
          <div className="col-span-2 text-center text-[10px] text-slate-400">
            {row.slotsCapacity} Slots • {row.aiSlotsCapacity} IA Slots
          </div>
        ) : null}
        {row.type === 'wiring' ? (
          <div className="col-span-2 text-center text-slate-400">{t('inventory.electricalConductor')}</div>
        ) : null}
      </div>
    </div>
  );
}

export function InventoryView({ stackableCategories, storedBatteries: _storedBatteries }: InventoryViewProps) {
  const t = useT();
  // Inventário jogável = só stock empilhável (baterias incl. infinitas via qty).
  void _storedBatteries;
  const visibleCategories = stackableCategories.filter((block) => block.items.length > 0);
  const empty = visibleCategories.length === 0;

  return (
    <div className="flex animate-in fade-in slide-in-from-bottom-4 flex-col p-6 duration-300">
      <div className="mb-6 flex items-center gap-3 border-b border-slate-200 pb-4 dark:border-slate-800">
        <div className="rounded-lg bg-slate-200 p-2 text-amber-600 dark:bg-slate-800 dark:text-amber-400">
          <Package size={24} />
        </div>
        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-slate-200">{t('inventory.depotTitle')}</h2>
          <p className="text-sm text-slate-500">{t('inventory.depotSubtitle')}</p>
        </div>
      </div>

      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-slate-400 dark:text-slate-600">
          <Package size={64} className="opacity-20" />
          <p className="text-lg">{t('inventory.emptyTitle')}</p>
          <p className="text-sm">{t('inventory.emptyHint')}</p>
        </div>
      ) : (
        <div className="space-y-8">
          {visibleCategories.map((block) => (
            <div key={block.category}>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-amber-600">
                <span className="h-2 w-2 rounded-full bg-amber-600" />
                {block.category}
              </h3>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {block.items.map((row) => (
                  <StackableCard key={row.stockKey} row={row} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
