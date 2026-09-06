// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { PlusCircle, Minus, Plus, Trash2, Search } from 'lucide-react';
import type { Upgrade } from '../../lib/adminTypes';
import { isAdminCatalogProtectedUpgrade } from '../../lib/upgradeCatalogLifecycle';
import { adminStockEntriesForEditor } from '../lib/adminStock';

/** Itens que o admin não deve conceder pelo picker de estoque (legacy + resultados de merge). */
function isAdminStockGrantBlocked(u: { id?: string; category?: string | null; type?: string | null }): boolean {
  if (isAdminCatalogProtectedUpgrade(u)) return true;
  const id = String(u.id || '').trim();
  if (id.startsWith('merge_')) return true;
  return false;
}

/** Normaliza para pesquisa: minúsculas, sem acentos, espaços colapsados. */
function normalizeSearchText(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s./-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Todas as palavras da query têm de aparecer no haystack (ordem livre). */
function matchesCatalogQuery(hayRaw: string, queryRaw: string): boolean {
  const hay = normalizeSearchText(hayRaw);
  const q = normalizeSearchText(queryRaw);
  if (!q) return true;
  const tokens = q.split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((t) => hay.includes(t));
}

function itemImageSrc(u: Upgrade | undefined): string | null {
  if (!u) return null;
  const raw =
    (typeof u.image === 'string' && u.image.trim()) ||
    (typeof (u as { imageUrl?: string }).imageUrl === 'string' &&
      String((u as { imageUrl?: string }).imageUrl).trim()) ||
    '';
  if (!raw) return null;
  if (raw.startsWith('data:') || raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('/')) {
    return raw;
  }
  return raw.startsWith('img/') ? `/${raw}` : `/img/${raw.replace(/^\/+/, '')}`;
}

function ItemThumb({ item, size = 'md' }: { item: Upgrade | undefined; size?: 'sm' | 'md' }) {
  const src = itemImageSrc(item);
  const box = size === 'sm' ? 'h-8 w-8' : 'h-10 w-10';
  const iconCls = size === 'sm' ? 'text-sm' : 'text-lg';
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => {
    setBroken(false);
  }, [src]);

  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setBroken(true)}
        className={`${box} shrink-0 rounded border border-slate-600 object-contain bg-slate-950 p-0.5`}
        loading="lazy"
      />
    );
  }
  return (
    <div
      className={`${box} shrink-0 rounded border border-slate-600 bg-slate-950 flex items-center justify-center ${iconCls}`}
    >
      {item?.icon || '📦'}
    </div>
  );
}

export type UserStockEditorProps = {
  stock: Record<string, number> | undefined;
  gameUpgrades: Upgrade[];
  onUpdateQty: (itemId: string, qty: number) => void;
  onAddItem: (itemId: string, qty: number) => void;
};

const CATALOG_RESULT_LIMIT = 60;

/** Painel de estoque: dois painéis iguais (adicionar | estoque), altura fixa, tipografia alinhada ao resto do admin. */
export function UserStockEditor({ stock, gameUpgrades, onUpdateQty, onAddItem }: UserStockEditorProps) {
  const [listQuery, setListQuery] = useState('');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [newItemId, setNewItemId] = useState('');
  const [newItemQty, setNewItemQty] = useState(1);

  const byId = useMemo(() => {
    const m = new Map<string, Upgrade>();
    for (const u of gameUpgrades || []) m.set(u.id, u);
    return m;
  }, [gameUpgrades]);

  const grantableCatalog = useMemo(() => {
    return (gameUpgrades || [])
      .filter((u) => !isAdminStockGrantBlocked(u))
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'pt'));
  }, [gameUpgrades]);

  const entries = useMemo(() => {
    return adminStockEntriesForEditor(stock).filter(([itemId]) => {
      const def = byId.get(itemId);
      const hay = `${itemId} ${def?.name || ''} ${def?.category || ''} ${def?.type || ''}`;
      return matchesCatalogQuery(hay, listQuery);
    });
  }, [stock, listQuery, byId]);

  const catalogMatches = useMemo(() => {
    const q = catalogQuery.trim();
    const filtered = q
      ? grantableCatalog.filter((u) =>
          matchesCatalogQuery(`${u.id} ${u.name} ${u.category} ${u.type}`, q)
        )
      : grantableCatalog;
    return filtered.slice(0, CATALOG_RESULT_LIMIT);
  }, [grantableCatalog, catalogQuery]);

  const catalogMatchTotal = useMemo(() => {
    const q = catalogQuery.trim();
    if (!q) return grantableCatalog.length;
    return grantableCatalog.filter((u) =>
      matchesCatalogQuery(`${u.id} ${u.name} ${u.category} ${u.type}`, q)
    ).length;
  }, [grantableCatalog, catalogQuery]);

  useEffect(() => {
    if (newItemId && !catalogMatches.some((u) => u.id === newItemId)) {
      setNewItemId(catalogMatches.length === 1 ? catalogMatches[0].id : '');
      return;
    }
    if (!newItemId && catalogQuery.trim() && catalogMatches.length === 1) {
      setNewItemId(catalogMatches[0].id);
    }
  }, [catalogMatches, catalogQuery, newItemId]);

  const selectedDef = newItemId ? byId.get(newItemId) : undefined;

  const handleAdd = () => {
    if (!newItemId) return;
    const def = byId.get(newItemId);
    if (def && isAdminStockGrantBlocked(def)) return;
    if (!def && (newItemId.startsWith('merge_') || newItemId.startsWith('temp_legacy_'))) return;
    const qty = Math.max(1, Math.floor(Number(newItemQty) || 1));
    onAddItem(newItemId, qty);
    setNewItemQty(1);
  };

  const panelCls =
    'flex h-[34rem] flex-col rounded-xl border border-slate-600 bg-slate-900/80';

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Adicionar */}
      <section className={panelCls}>
        <header className="shrink-0 border-b border-slate-700 px-4 py-3">
          <h4 className="text-xs font-black uppercase tracking-wider text-amber-400">Adicionar ao estoque</h4>
          <div className="relative mt-2.5">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-500" />
            <input
              type="text"
              value={catalogQuery}
              onChange={(e) => setCatalogQuery(e.target.value)}
              placeholder="Pesquisar nome, id ou categoria…"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 py-2 pl-8 pr-3 text-sm text-white placeholder:text-slate-500"
            />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-slate-800 custom-scrollbar">
          {catalogMatches.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">
              {catalogQuery.trim() ? 'Nenhum item encontrado.' : 'Catálogo vazio.'}
            </div>
          ) : (
            catalogMatches.map((u) => {
              const selected = u.id === newItemId;
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setNewItemId(u.id)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-800/70 ${
                    selected ? 'bg-orange-950/35 ring-1 ring-inset ring-orange-500/40' : ''
                  }`}
                >
                  <ItemThumb item={u} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white">{u.name || u.id}</div>
                    <div className="truncate text-[11px] text-slate-500">
                      {u.id}
                      {u.type ? ` · ${u.type}` : ''}
                      {u.category ? ` · ${u.category}` : ''}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        <footer className="shrink-0 space-y-2 border-t border-slate-700 bg-slate-950/40 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {selectedDef ? (
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <ItemThumb item={selectedDef} size="md" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-white">{selectedDef.name}</div>
                  <div className="truncate font-mono text-[11px] text-slate-500">{selectedDef.id}</div>
                </div>
              </div>
            ) : (
              <div className="flex-1 text-sm text-slate-500">Selecciona um item na lista.</div>
            )}
            <input
              type="number"
              min={1}
              value={newItemQty}
              onChange={(e) => setNewItemQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
              className="w-16 rounded-lg border border-slate-500 bg-slate-900 py-1.5 text-center text-sm font-bold text-white"
              title="Quantidade"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newItemId}
              className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-green-500 disabled:opacity-40"
            >
              <PlusCircle size={16} /> Adicionar
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            {gameUpgrades.length === 0
              ? 'Catálogo vazio — recarrega o painel admin.'
              : `A mostrar ${catalogMatches.length}${
                  catalogMatchTotal > catalogMatches.length ? ` de ${catalogMatchTotal}` : ''
                } · ${grantableCatalog.length} concedíveis · ${gameUpgrades.length} no catálogo`}
          </p>
        </footer>
      </section>

      {/* Estoque do jogador */}
      <section className={panelCls}>
        <header className="shrink-0 border-b border-slate-700 px-4 py-3">
          <h4 className="text-xs font-black uppercase tracking-wider text-amber-400">Estoque do jogador</h4>
          <div className="relative mt-2.5">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-500" />
            <input
              type="text"
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
              placeholder="Filtrar estoque…"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 py-2 pl-8 pr-3 text-sm text-white placeholder:text-slate-500"
            />
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 custom-scrollbar">
          {entries.map(([itemId, qty]) => {
            const itemDef = byId.get(itemId);
            const qtyNum = Number(qty);
            const label = itemDef?.name?.trim() || itemId;
            return (
              <div
                key={itemId}
                className={`flex items-center justify-between gap-3 rounded-lg border bg-slate-950/70 px-3 py-2.5 ${
                  qtyNum <= 0 ? 'border-red-800/70' : 'border-slate-700'
                }`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <ItemThumb item={itemDef} size="md" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-white">{label}</div>
                    <div className="truncate text-[11px] text-slate-500">
                      {itemId}
                      {itemDef?.type ? ` · ${itemDef.type}` : ''}
                      {itemDef?.category ? ` · ${itemDef.category}` : ''}
                    </div>
                    {qtyNum <= 0 ? (
                      <div className="mt-0.5 text-[11px] text-red-400">Será removido ao salvar</div>
                    ) : null}
                    {!itemDef ? (
                      <div className="mt-0.5 text-[11px] text-amber-400">Fora do catálogo (id órfão)</div>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    title="-1"
                    onClick={() => onUpdateQty(itemId, Math.max(0, qtyNum - 1))}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-600 bg-slate-800 text-white hover:bg-slate-700"
                  >
                    <Minus size={14} />
                  </button>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={qtyNum}
                    onChange={(e) => onUpdateQty(itemId, parseInt(e.target.value, 10) || 0)}
                    className="w-14 rounded-md border border-slate-600 bg-slate-800 py-1 text-center text-sm font-bold text-white"
                  />
                  <button
                    type="button"
                    title="+1"
                    onClick={() => onUpdateQty(itemId, qtyNum + 1)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-600 bg-slate-800 text-white hover:bg-slate-700"
                  >
                    <Plus size={14} />
                  </button>
                  <button
                    type="button"
                    title="Remover (qty 0)"
                    onClick={() => onUpdateQty(itemId, 0)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-red-800 bg-red-950/40 text-red-300 hover:bg-red-900/50"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
          {entries.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-slate-500">
              {listQuery.trim() ? 'Nenhum item corresponde à pesquisa.' : 'Estoque vazio.'}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
