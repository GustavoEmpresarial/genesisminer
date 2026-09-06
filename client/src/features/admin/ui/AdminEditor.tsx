// @ts-nocheck — template legado 1:1.

import React, { useEffect, useMemo, useState } from 'react';
import {
  Upgrade,
  isAsicMachineUpgrade,
  ASIC_DURATION_UNITS,
  ASIC_DURATION_UNIT_LABELS,
  formatAsicDurationPreview,
  resolveAsicDurationForForm,
  type AsicDurationKind,
  type AsicDurationUnit,
  type MiningCoin
} from '../lib/adminTypes';
import { getMiningCoins } from '../../../shared/api/admin-economy';
import { List, Cpu, Server, Battery, Plug, Zap, PlusCircle, Hexagon, ChevronRight, ChevronDown } from 'lucide-react';
import {
    SHOP_PRODUCT_ID_RE,
    makeSafeShopProductId,
    applyAdminCatalogItemSave
} from '../lib/upgradeCatalogIds';
import { mergeCatalogRootId } from '../../servers/lib/upgradeRackCompat';
import {
    COMMON_CHASSIS_DEFAULT_RACK_ROOM_AFFINITY,
    normalizeRackRoomAffinity,
    rackRoomAffinityKinds,
    resolveChassisRackRoomAffinity,
    type RoomKind
} from '../../servers/types';
import { collectDuplicateNonMergeNameIds } from '../lib/upgradeCatalogDuplicateNames';
import {
    applyAdminCatalogLifecycleSave,
    filterUpgradesByLifecycle,
    isUpgradeRetired,
    type CatalogLifecycleFilter
} from '../lib/upgradeCatalogLifecycle';
import {
    buildCatalogTree,
    catalogItemRarity,
    filterCatalogTree,
    UPGRADE_RARITY_ORDER,
    type CatalogRarityFilter,
    type CatalogTreeNode
} from '../lib/upgradeCatalogTree';
import { apiFetch } from '../../../shared/api/http';

interface AdminEditorProps {
    gameUpgrades: Upgrade[];
    onUpdateGameUpgrades?: (upgrades: Upgrade[]) => Promise<boolean | void> | void;
}

/** Max lines shown in invalid-ID fixes alert after save. */
const ADMIN_CATALOG_FIXES_PREVIEW_LIMIT = 6;
const DEFAULT_CATALOG_ITEM_ICON = '📦';
const RACK_FAMILY_INHERITED_HINT = 'Herdado do rack comum';
const RACK_ROOM_AFFINITY_CHECKBOXES: { kind: RoomKind; label: string }[] = [
    { kind: 'standard', label: 'Sala normal' },
    { kind: 'asic', label: 'Sala ASICs' },
    { kind: 'nft', label: 'Sala NFT' }
];

const IMG_UPLOAD_FOLDERS = [
    { id: '', label: 'uploads (dinâmico)' },
    { id: 'miner', label: 'miner' },
    { id: 'moedas', label: 'moedas' },
    { id: 'carregadores', label: 'carregadores' },
    { id: 'baterias', label: 'baterias' },
    { id: 'favicon', label: 'favicon' }
] as const;

/** Labels iguais ao select «Raridade (Merge)». */
const CATALOG_RARITY_FILTER_OPTIONS: { value: CatalogRarityFilter; label: string }[] = [
    { value: 'all', label: 'Todos' },
    ...UPGRADE_RARITY_ORDER.map((r) => ({
        value: r as CatalogRarityFilter,
        label: r.charAt(0).toUpperCase() + r.slice(1)
    }))
];

export const AdminEditor: React.FC<AdminEditorProps> = ({ gameUpgrades, onUpdateGameUpgrades }) => {
    const [imageUploadFolder, setImageUploadFolder] = useState<string>('');
    const [editItemMode, setEditItemMode] = useState<boolean>(false);
    const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
    const [editorFilter, setEditorFilter] = useState<string>('all');
    /** Default: Ativos — retired não misturado por omissão. */
    const [lifecycleFilter, setLifecycleFilter] = useState<CatalogLifecycleFilter>('active');
    const [catalogSearch, setCatalogSearch] = useState('');
    const [rarityFilter, setRarityFilter] = useState<CatalogRarityFilter>('all');
    const [expandedRootIds, setExpandedRootIds] = useState<Set<string>>(() => new Set());
    const [isLifecycleBusy, setIsLifecycleBusy] = useState(false);    const [itemForm, setItemForm] = useState<Partial<Upgrade>>({
        id: '', name: '', category: '', type: 'machine', baseCost: 0, baseProduction: 0, description: '', status: 'normal', rarity: 'common', compatibleRacks: [], image: '', icon: DEFAULT_CATALOG_ITEM_ICON,
        sellInHardwareMarket: true, sellInBlackMarket: true, isActive: true
    });

    const [isUploadingImage, setIsUploadingImage] = useState(false);
    const [miningCoins, setMiningCoins] = useState<MiningCoin[]>([]);

    useEffect(() => {
        void getMiningCoins().then((list) => {
            if (Array.isArray(list)) {
                setMiningCoins([...list].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'pt')));
            }
        });
    }, []);

    const nftAsicCoinSelectOptions = React.useMemo(() => {
        const byId = new Map(miningCoins.map((c) => [c.id, c]));
        const selectedId = itemForm.nftMiningCoinId?.trim();
        if (selectedId && !byId.has(selectedId)) {
            return [{ id: selectedId, name: selectedId, symbol: selectedId } as MiningCoin, ...miningCoins];
        }
        return miningCoins;
    }, [miningCoins, itemForm.nftMiningCoinId]);

    /**
     * Upload via `multipart/form-data` em `/api/admin/upload-image` — evita o
     * multipart até 50 MB (evita o tecto de 5 MB do JSON) e mostra erros reais do backend.
     */
    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const input = e.target;
        const file = input.files?.[0];
        if (!file) return;
        const okMime = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
        if (!okMime.includes(file.type)) {
            alert('Formato de imagem inválido. Usa PNG, JPG, WEBP ou GIF.');
            input.value = '';
            return;
        }
        const fd = new FormData();
        fd.append('image', file, file.name);
        if (imageUploadFolder) fd.append('assetFolder', imageUploadFolder);
        setIsUploadingImage(true);
        try {
            const res = await apiFetch('/api/admin/upload-image', {
                method: 'POST',
                credentials: 'include',
                body: fd
            });
            let payload: { ok?: boolean; path?: string; url?: string; error?: string } | null = null;
            try { payload = await res.json(); } catch { /* sem JSON */ }
            const url = payload?.path || payload?.url;
            if (res.ok && payload?.ok && url) {
                setItemForm(prev => ({ ...prev, image: url }));
            } else {
                alert(payload?.error || `Falha ao enviar imagem (HTTP ${res.status}).`);
            }
        } catch {
            alert('Falha de rede ao enviar imagem. Verifica a ligação e tenta novamente.');
        } finally {
            setIsUploadingImage(false);
            input.value = '';
        }
    };

    const handleNewItem = () => {
        setEditItemMode(true);
        setEditingSourceId(null);
        const nftTab = editorFilter === 'nft';
        const defaultType = editorFilter === 'all' || nftTab ? 'machine' : editorFilter;
        setItemForm({
            id: '', name: '', category: 'Nova Categoria',
            type: defaultType as Upgrade['type'],
            baseCost: 0.001, baseProduction: 0, description: '',
            status: 'normal', rarity: 'common', compatibleRacks: [], image: '', icon: DEFAULT_CATALOG_ITEM_ICON,
            sellInHardwareMarket: true, sellInBlackMarket: true, isActive: true,
            isNft: nftTab,
            ...(defaultType === 'infrastructure'
                ? { rackRoomAffinity: COMMON_CHASSIS_DEFAULT_RACK_ROOM_AFFINITY }
                : {})
        });
    }

    const handleEditItem = (item: Upgrade) => {
        setEditingSourceId(item.id);
        const dur = resolveAsicDurationForForm(item);
        setItemForm({
            ...item,
            rarity: item.rarity || 'common',
            compatibleRacks: item.compatibleRacks || [],
            asicDurationAmount: dur.permanent ? 0 : dur.amount,
            asicDurationUnit: dur.permanent ? undefined : dur.unit,
            asicDurationKind: 'none' as AsicDurationKind,
            ...(item.type === 'infrastructure'
                ? { rackRoomAffinity: resolveChassisRackRoomAffinity(item.id, item.rackRoomAffinity) }
                : {})
        });
        setEditItemMode(true);
    };

    const [isSaving, setIsSaving] = useState(false);

    /** Item já no catálogo → ID canónico imutável (read-only na UI + lock no save). */
    const isPersistedIdEdit = editingSourceId != null;
    const itemFormId = String(itemForm.id || '');
    const isInfrastructureMerge =
        itemForm.type === 'infrastructure' && itemFormId !== '' && mergeCatalogRootId(itemFormId) !== itemFormId;
    const infrastructureAffinity = resolveChassisRackRoomAffinity(itemFormId, itemForm.rackRoomAffinity);

    const toggleInfrastructureRoomKind = (kind: RoomKind, checked: boolean) => {
        const selected = new Set(rackRoomAffinityKinds(infrastructureAffinity));
        if (checked) selected.add(kind);
        else selected.delete(kind);
        if (selected.size === 0) {
            setItemForm({
                ...itemForm,
                rackRoomAffinity: itemForm.rackRoomAffinity || COMMON_CHASSIS_DEFAULT_RACK_ROOM_AFFINITY
            });
            return;
        }
        setItemForm({
            ...itemForm,
            rackRoomAffinity: normalizeRackRoomAffinity([...selected].join('+'))
        });
    };

    const handleSaveItem = async () => {
        if (!onUpdateGameUpgrades || !itemForm.name) return;
        if (!isPersistedIdEdit && !String(itemForm.id || '').trim()) return;
        setIsSaving(true);
        try {
            const amt = Math.floor(Number(itemForm.asicDurationAmount) || 0);
            const unit =
                itemForm.asicDurationUnit && ASIC_DURATION_UNITS.includes(itemForm.asicDurationUnit as AsicDurationUnit)
                    ? (itemForm.asicDurationUnit as AsicDurationUnit)
                    : undefined;
            const timed = amt > 0 && !!unit;
            const formForSave = {
                ...(itemForm as Upgrade),
                asicDurationKind: 'none' as AsicDurationKind,
                asicDurationAmount: timed ? amt : 0,
                asicDurationUnit: timed ? unit : undefined
            };
            const { upgrades, fixes, lockedId } = applyAdminCatalogItemSave({
                gameUpgrades,
                editingSourceId,
                itemForm: formForSave
            });
            // Sanity: edição nunca muda identidade; payload sem previousId.
            if (editingSourceId && lockedId !== editingSourceId) {
                throw new Error('Identidade canónica imutável.');
            }
            const ok = await onUpdateGameUpgrades(upgrades);
            // Manter item seleccionado após save só se persist OK (void legacy = sucesso).
            if (ok !== false && lockedId) {
                setEditingSourceId(lockedId);
                setEditItemMode(true);
                const updated = upgrades.find((u) => u.id === lockedId);
                if (updated) {
                    setItemForm({
                        ...updated,
                        rarity: updated.rarity || 'common',
                        compatibleRacks: updated.compatibleRacks || []
                    });
                }
            }
            if (ok !== false && fixes.length > 0) {
                const preview = fixes
                    .slice(0, ADMIN_CATALOG_FIXES_PREVIEW_LIMIT)
                    .map((fix) => `${fix.name}: ${fix.to}`)
                    .join('\n');
                const extra =
                    fixes.length > ADMIN_CATALOG_FIXES_PREVIEW_LIMIT
                        ? `\n... e mais ${fixes.length - ADMIN_CATALOG_FIXES_PREVIEW_LIMIT}`
                        : '';
                alert(`IDs de itens NOVOS inválidos corrigidos no save:\n\n${preview}${extra}`);
            }
        } catch (e: any) {
            const rawMessage = String(e?.message || 'Erro desconhecido');
            if (rawMessage.startsWith('ID inválido') || rawMessage.startsWith('ID obrigatório')) {
                alert(rawMessage);
            } else {
                const invalidIdMatch = rawMessage.match(/^ID de item inválido:\s*(.+?)\.\s*Use apenas/i);
                if (invalidIdMatch) {
                    const badId = invalidIdMatch[1]?.trim() || 'desconhecido';
                    const suggestedId = makeSafeShopProductId(badId);
                    alert(
                        `O servidor rejeitou um ID: ${badId}.\n\n` +
                        `IDs já persistidos não são remapeados no admin.\n` +
                        (suggestedId ? `Sugestão só para CREATE: ${suggestedId}` : '')
                    );
                } else {
                    alert(rawMessage);
                }
            }
        } finally {
            setIsSaving(false);
        }
    };

    const handleLifecycleAction = async (mode: 'retire' | 'reactivate') => {
        if (!onUpdateGameUpgrades || !editingSourceId) return;
        const msg =
            mode === 'retire'
                ? 'Retirar este upgrade?\n\nO item sai da loja (status retired) e o ID canónico é preservado.'
                : 'Reativar este upgrade?\n\nO mesmo ID volta ao estado operacional (normal, activo, mercados on).';
        if (!window.confirm(msg)) return;
        setIsLifecycleBusy(true);
        try {
            const { upgrades, lockedId } = applyAdminCatalogLifecycleSave({
                gameUpgrades,
                targetId: editingSourceId,
                mode
            });
            if (lockedId !== editingSourceId) {
                throw new Error('Identidade canónica imutável.');
            }
            const ok = await onUpdateGameUpgrades(upgrades);
            if (ok === false) return;
            const updated = upgrades.find((u) => u.id === lockedId);
            if (updated) {
                setItemForm({
                    ...updated,
                    rarity: updated.rarity || 'common',
                    compatibleRacks: updated.compatibleRacks || []
                });
            }
            if (mode === 'retire') setLifecycleFilter('retired');
            else setLifecycleFilter('active');
        } catch (e: any) {
            alert(String(e?.message || 'Falha na acção de lifecycle.'));
        } finally {
            setIsLifecycleBusy(false);
        }
    };

    const toggleCompatibleRack = (rackId: string) => {
        const current = itemForm.compatibleRacks || [];
        if (current.includes(rackId)) {
            setItemForm({ ...itemForm, compatibleRacks: current.filter(id => id !== rackId) });
        } else {
            setItemForm({ ...itemForm, compatibleRacks: [...current, rackId] });
        }
    };

    const duplicateNameIds = useMemo(
        () => collectDuplicateNonMergeNameIds(gameUpgrades),
        [gameUpgrades]
    );

    const filteredByTypeAndLifecycle = useMemo(
        () =>
            filterUpgradesByLifecycle(gameUpgrades, lifecycleFilter).filter((u) => {
                if (editorFilter !== 'all') {
                    if (editorFilter === 'nft') {
                        if (!u.isNft) return false;
                    } else if (u.type !== editorFilter) {
                        return false;
                    }
                }
                return true;
            }),
        [gameUpgrades, lifecycleFilter, editorFilter]
    );

    const catalogTree = useMemo(() => {
        const tree = buildCatalogTree(filteredByTypeAndLifecycle);
        return filterCatalogTree(tree, { search: catalogSearch, rarity: rarityFilter });
    }, [filteredByTypeAndLifecycle, catalogSearch, rarityFilter]);

    const activeTreeNodes =
        lifecycleFilter === 'all' ? catalogTree.filter((n) => !isUpgradeRetired(n.item)) : catalogTree;
    const retiredTreeNodes =
        lifecycleFilter === 'all' ? catalogTree.filter((n) => isUpgradeRetired(n.item)) : [];

    const visibleRootCount = catalogTree.length;
    const visibleMergedCount = catalogTree.reduce((acc, n) => acc + n.children.length, 0);

    const itemMatchesCatalogSearch = (u: Upgrade, q: string) => {
        if (!q) return false;
        return (
            String(u.id || '').toLowerCase().includes(q) ||
            String(u.name || '').toLowerCase().includes(q) ||
            String(u.category || '').toLowerCase().includes(q)
        );
    };

    const isCatalogNodeExpanded = (node: CatalogTreeNode<Upgrade>) => {
        const rootId = String(node.item.id || '');
        if (expandedRootIds.has(rootId)) return true;
        if (editingSourceId && node.children.some((c) => c.id === editingSourceId)) return true;
        const q = catalogSearch.trim().toLowerCase();
        if (q && node.children.some((c) => itemMatchesCatalogSearch(c, q))) return true;
        if (rarityFilter !== 'all' && rarityFilter !== 'common' && node.children.length > 0) return true;
        return false;
    };

    const toggleCatalogNodeExpand = (rootId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setExpandedRootIds((prev) => {
            const next = new Set(prev);
            if (next.has(rootId)) next.delete(rootId);
            else next.add(rootId);
            return next;
        });
    };

    const infrastructureItems = filterUpgradesByLifecycle(gameUpgrades, 'all').filter(
        (u) => u.type === 'infrastructure' && !isUpgradeRetired(u)
    );

    const formIsRetired = isUpgradeRetired(itemForm);

    const renderCatalogRootCard = (node: CatalogTreeNode<Upgrade>, keyPrefix = '') => {
        const u = node.item;
        const rootId = String(u.id || '');
        const expanded = node.children.length > 0 && isCatalogNodeExpanded(node);
        const Chevron = expanded ? ChevronDown : ChevronRight;
        return (
            <div key={`${keyPrefix}${rootId}`} className="space-y-1">
                <div
                    className={`bg-slate-900 p-2 rounded border cursor-pointer ${
                        isUpgradeRetired(u)
                            ? 'border-rose-900/60 hover:border-rose-500 opacity-90'
                            : 'border-slate-700 hover:border-amber-500'
                    }`}
                    onClick={() => handleEditItem(u)}
                >
                    <div className="flex justify-between items-center gap-2">
                        <div className="min-w-0 flex items-start gap-1">
                            {node.children.length > 0 ? (
                                <button
                                    type="button"
                                    className="mt-0.5 p-0.5 rounded text-slate-400 hover:text-white shrink-0"
                                    aria-label={expanded ? 'Recolher merges' : 'Expandir merges'}
                                    onClick={(e) => toggleCatalogNodeExpand(rootId, e)}
                                >
                                    <Chevron size={14} />
                                </button>
                            ) : (
                                <span className="w-[18px] shrink-0" />
                            )}
                            <div className="min-w-0">
                                <span className="font-bold text-sm text-white">{u.name}</span>
                                <div className="flex gap-2 mt-1 items-center flex-wrap">
                                    <span className="text-xs text-amber-400/90 font-mono">${Number(u.baseCost || 0).toFixed(3)}</span>
                                    {duplicateNameIds.has(u.id) && (
                                        <span className="text-[9px] uppercase font-bold text-amber-300 border border-amber-700/50 rounded px-1 py-0.5" title="Outro produto usa o mesmo nome de exibição">
                                            Nome duplicado
                                        </span>
                                    )}
                                    {isUpgradeRetired(u) ? (
                                        <span className="text-[9px] uppercase font-bold text-rose-300 border border-rose-700/60 rounded px-1 py-0.5">
                                            Retirado
                                        </span>
                                    ) : u.isActive === false ? (
                                        <span className="text-[9px] uppercase font-bold text-slate-400 border border-slate-600 rounded px-1 py-0.5">
                                            Inactivo
                                        </span>
                                    ) : null}
                                            {node.children.length > 0 && (
                                                <span className="text-[9px] uppercase font-bold text-violet-300/90 border border-violet-800/50 rounded px-1 py-0.5">
                                                    {node.children.length} merged
                                                </span>
                                            )}
                                            {u.isNft && (
                                                <span className="text-[9px] uppercase font-bold text-orange-400 border border-orange-700/60 rounded px-1 py-0.5 flex items-center gap-0.5">
                                                    <Hexagon size={8} /> NFT
                                                </span>
                                            )}
                                    {!SHOP_PRODUCT_ID_RE.test(String(u.id || '').trim()) && (
                                        <span className="text-[9px] uppercase font-bold text-red-400 border border-red-700/60 rounded px-1 py-0.5">
                                            ID inválido
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                        {u.image && <div className={`w-8 ${u.type === 'infrastructure' ? 'h-10' : 'h-8'} rounded bg-slate-800 overflow-hidden shrink-0`}><img src={u.image} className={`w-full h-full ${u.type === 'infrastructure' ? 'object-contain' : 'object-cover'}`} alt="" /></div>}
                    </div>
                </div>
                {expanded
                    ? node.children.map((child) => {
                          const childRarity = catalogItemRarity(child);
                          return (
                              <div
                                  key={child.id}
                                  className={`ml-5 bg-slate-950/80 p-2 rounded border cursor-pointer ${
                                      isUpgradeRetired(child)
                                          ? 'border-rose-900/50 hover:border-rose-500 opacity-90'
                                          : 'border-slate-700/80 hover:border-violet-500'
                                  }`}
                                  onClick={() => handleEditItem(child)}
                              >
                                  <div className="flex justify-between items-center gap-2">
                                      <div className="min-w-0">
                                          <span className="font-bold text-sm text-slate-100">{child.name}</span>
                                          <div className="flex gap-2 mt-1 items-center flex-wrap">
                                              <span className="text-[9px] uppercase font-bold text-violet-300 border border-violet-700/50 rounded px-1 py-0.5">
                                                  {childRarity}
                                              </span>
                                              <span className="text-xs text-amber-400/90 font-mono">
                                                  ${Number(child.baseCost || 0).toFixed(3)}
                                              </span>
                                              {isUpgradeRetired(child) ? (
                                                  <span className="text-[9px] uppercase font-bold text-rose-300 border border-rose-700/60 rounded px-1 py-0.5">
                                                      Retirado
                                                  </span>
                                              ) : null}
                                          </div>
                                      </div>
                                      {child.image && (
                                          <div className={`w-8 ${child.type === 'infrastructure' ? 'h-10' : 'h-8'} rounded bg-slate-800 overflow-hidden shrink-0`}>
                                              <img
                                                  src={child.image}
                                                  className={`w-full h-full ${child.type === 'infrastructure' ? 'object-contain' : 'object-cover'}`}
                                                  alt=""
                                              />
                                          </div>
                                      )}
                                  </div>
                              </div>
                          );
                      })
                    : null}
            </div>
        );
    };

    return (
        <div className="animate-in fade-in slide-in-from-right-4">
            <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
                <button
                    type="button"
                    onClick={() => setLifecycleFilter('active')}
                    className={`px-3 py-1.5 rounded text-[10px] font-bold uppercase whitespace-nowrap transition-colors ${lifecycleFilter === 'active' ? 'bg-emerald-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
                >
                    Ativos
                </button>
                <button
                    type="button"
                    onClick={() => setLifecycleFilter('retired')}
                    className={`px-3 py-1.5 rounded text-[10px] font-bold uppercase whitespace-nowrap transition-colors ${lifecycleFilter === 'retired' ? 'bg-rose-800 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
                >
                    Retirados
                </button>
                <button
                    type="button"
                    onClick={() => setLifecycleFilter('all')}
                    className={`px-3 py-1.5 rounded text-[10px] font-bold uppercase whitespace-nowrap transition-colors ${lifecycleFilter === 'all' ? 'bg-slate-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
                >
                    Todos
                </button>
            </div>

            <div className="flex gap-2 mb-3 overflow-x-auto pb-2 border-b border-slate-700">
                <button onClick={() => setEditorFilter('all')} className={`px-3 py-2 rounded text-xs font-bold uppercase flex items-center gap-2 whitespace-nowrap transition-colors ${editorFilter === 'all' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}><List size={14} /> Tipo: Todos</button>
                <button onClick={() => setEditorFilter('machine')} className={`px-3 py-2 rounded text-xs font-bold uppercase flex items-center gap-2 whitespace-nowrap transition-colors ${editorFilter === 'machine' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}><Cpu size={14} /> GPUs</button>
                <button onClick={() => setEditorFilter('infrastructure')} className={`px-3 py-2 rounded text-xs font-bold uppercase flex items-center gap-2 whitespace-nowrap transition-colors ${editorFilter === 'infrastructure' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}><Server size={14} /> Rigs</button>
                <button onClick={() => setEditorFilter('battery')} className={`px-3 py-2 rounded text-xs font-bold uppercase flex items-center gap-2 whitespace-nowrap transition-colors ${editorFilter === 'battery' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}><Battery size={14} /> Baterias</button>
                <button onClick={() => setEditorFilter('wiring')} className={`px-3 py-2 rounded text-xs font-bold uppercase flex items-center gap-2 whitespace-nowrap transition-colors ${editorFilter === 'wiring' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}><Plug size={14} /> Circuito</button>
                <button onClick={() => setEditorFilter('multiplier')} className={`px-3 py-2 rounded text-xs font-bold uppercase flex items-center gap-2 whitespace-nowrap transition-colors ${editorFilter === 'multiplier' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}><Zap size={14} /> Chips IA</button>
                <button onClick={() => setEditorFilter('nft')} className={`px-3 py-2 rounded text-xs font-bold uppercase flex items-center gap-2 whitespace-nowrap transition-colors ${editorFilter === 'nft' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}><Hexagon size={14} /> NFT</button>
            </div>
            <div className="flex gap-2 mb-6 overflow-x-auto pb-2 border-b border-slate-700 items-center">
                <span className="text-[10px] font-bold uppercase text-slate-500 whitespace-nowrap shrink-0">Nível</span>
                {CATALOG_RARITY_FILTER_OPTIONS.map((opt) => (
                    <button
                        key={opt.value}
                        type="button"
                        onClick={() => setRarityFilter(opt.value)}
                        className={`px-3 py-2 rounded text-xs font-bold uppercase whitespace-nowrap transition-colors ${rarityFilter === opt.value ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
                    >
                        {opt.label}
                    </button>
                ))}
            </div>
            <p className="text-xs text-slate-400 mb-4 -mt-2">
                Lojinha Miner / Mercado Negro — tabela <span className="font-mono text-slate-300">upgrades</span>. Não confundir com
                Utilizadores → Upgrades (passes USDC em <span className="font-mono text-slate-300">admin_upgrades</span>).
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 flex flex-col h-[70vh]">
                    <div className="flex justify-between items-center mb-3 gap-2">
                        <h3 className="font-bold text-white">
                            {editorFilter === 'all'
                                ? 'Catálogo Completo'
                                : editorFilter === 'nft'
                                  ? 'Itens NFT'
                                  : `Editando: ${editorFilter.toUpperCase()}`}
                            <span className="text-slate-500 font-normal text-xs ml-1">({visibleRootCount})</span>
                            {visibleMergedCount > 0 ? (
                                <span className="text-slate-600 font-normal text-[10px] ml-1">
                                    {visibleMergedCount} merged
                                </span>
                            ) : null}
                        </h3>
                        <button onClick={handleNewItem} className="bg-green-600 hover:bg-green-500 text-white text-xs px-2 py-1 rounded flex items-center gap-1 shrink-0"><PlusCircle size={12} /> NOVO</button>
                    </div>
                    <input
                        type="search"
                        value={catalogSearch}
                        onChange={(e) => setCatalogSearch(e.target.value)}
                        placeholder="Pesquisar nome, id ou categoria (ex.: krypto, ultimate)…"
                        className="w-full mb-3 rounded-lg bg-slate-950 border border-slate-600 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                    />
                    <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2">
                        {catalogTree.length === 0 ? (
                            <p className="text-sm text-slate-500 text-center py-6">Nenhum item neste filtro.</p>
                        ) : null}
                        {lifecycleFilter === 'all' && activeTreeNodes.length > 0 ? (
                            <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-500/90 px-1 pt-1">Ativos</p>
                        ) : null}
                        {(lifecycleFilter === 'all' ? activeTreeNodes : catalogTree).map((node) =>
                            renderCatalogRootCard(node)
                        )}
                        {lifecycleFilter === 'all' && retiredTreeNodes.length > 0 ? (
                            <>
                                <p className="text-[10px] font-bold uppercase tracking-wide text-rose-400/90 px-1 pt-3">Retirados</p>
                                {retiredTreeNodes.map((node) => renderCatalogRootCard(node, 'retired-'))}
                            </>
                        ) : null}
                    </div>                </div>

                <div className="lg:col-span-2 bg-slate-800 border border-slate-700 rounded-xl p-6 h-[70vh] overflow-y-auto custom-scrollbar">
                    {editItemMode ? (
                        <div className="space-y-4">
                            <div className="flex justify-between items-center border-b border-slate-700 pb-2 mb-4">
                                <h3 className="text-xl font-bold text-white">{itemForm.id ? `Editando: ${itemForm.name}` : 'Criar Novo Item'}</h3>

                                <div className="flex flex-wrap items-center gap-2">
                                    {itemForm.image && (
                                        <div className={`w-12 ${itemForm.type === 'infrastructure' ? 'h-16' : 'h-12'} rounded overflow-hidden border border-slate-600 bg-black shrink-0`}>
                                            <img src={itemForm.image} alt="Preview" className={`w-full h-full ${itemForm.type === 'infrastructure' ? 'object-contain' : 'object-cover'}`} />
                                        </div>
                                    )}
                                    <select
                                        value={imageUploadFolder}
                                        onChange={(e) => setImageUploadFolder(e.target.value)}
                                        className="text-xs bg-slate-900 border border-slate-600 rounded px-2 py-1 text-white max-w-[11rem]"
                                        title="Destino no servidor (só admin grava em subpastas canónicas)"
                                    >
                                        {IMG_UPLOAD_FOLDERS.map((o) => (
                                            <option key={o.id || 'uploads'} value={o.id}>{o.label}</option>
                                        ))}
                                    </select>
                                    <input
                                        type="file"
                                        accept="image/png,image/jpeg,image/webp,image/gif"
                                        onChange={handleImageUpload}
                                        disabled={isUploadingImage}
                                        className="text-xs text-white disabled:opacity-50"
                                    />
                                    {isUploadingImage && (
                                        <span className="text-xs font-bold uppercase tracking-wide text-amber-400">
                                            Enviando…
                                        </span>
                                    )}
                                    <button
                                        onClick={() => setItemForm(prev => ({ ...prev, image: '' }))}
                                        disabled={isUploadingImage}
                                        className="bg-slate-700 hover:bg-slate-600 text-white text-xs px-3 py-2 rounded font-bold disabled:opacity-50"
                                    >
                                        Remover imagem
                                    </button>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                {!isPersistedIdEdit && (
                                <div>
                                    <div className="flex items-center justify-between gap-2 mb-1">
                                        <label className="text-xs font-bold text-slate-500 block">
                                            ID Único
                                        </label>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setItemForm({
                                                    ...itemForm,
                                                    id: makeSafeShopProductId(String(itemForm.id || itemForm.name || ''))
                                                })
                                            }
                                            className="text-[10px] uppercase font-bold px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white"
                                        >
                                            Gerar ID seguro
                                        </button>
                                    </div>
                                    <input
                                        type="text"
                                        value={itemForm.id}
                                        onChange={(e) => setItemForm({ ...itemForm, id: e.target.value })}
                                        className="w-full border rounded p-2 text-sm bg-slate-900 border-slate-600 text-white"
                                    />
                                    <p className="mt-1 text-[10px] text-slate-500">
                                        CREATE: letras, números, ponto, underscore ou hífen. IDs já no catálogo nunca são remapeados.
                                    </p>
                                </div>
                                )}
                                <div><label className="text-xs font-bold text-slate-500 block mb-1">Nome</label><input type="text" value={itemForm.name} onChange={e => setItemForm({ ...itemForm, name: e.target.value })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" /></div>
                                <div><label className="text-xs font-bold text-slate-500 block mb-1">Categoria</label><input type="text" value={itemForm.category} onChange={e => setItemForm({ ...itemForm, category: e.target.value })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" /></div>
                                <div><label className="text-xs font-bold text-slate-500 block mb-1">Tipo</label><select value={itemForm.type} onChange={e => {
                                    const nextType = e.target.value as Upgrade['type'];
                                    setItemForm({
                                        ...itemForm,
                                        type: nextType,
                                        ...(nextType === 'infrastructure' && !itemForm.rackRoomAffinity
                                            ? { rackRoomAffinity: COMMON_CHASSIS_DEFAULT_RACK_ROOM_AFFINITY }
                                            : {})
                                    });
                                }} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm"><option value="machine">GPU</option><option value="infrastructure">Rig</option><option value="battery">Bateria</option><option value="wiring">Circuito</option><option value="multiplier">Chip IA</option></select></div>
                                {(itemForm.type === 'machine' ||
                                  itemForm.type === 'multiplier' ||
                                  itemForm.type === 'infrastructure') && (
                                  <div>
                                    <label className="text-xs font-bold text-slate-500 block mb-1">Raridade (Merge)</label>
                                    <select
                                      value={itemForm.rarity || 'common'}
                                      onChange={(e) =>
                                        setItemForm({
                                          ...itemForm,
                                          rarity: e.target.value as Upgrade['rarity']
                                        })
                                      }
                                      className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm"
                                    >
                                      <option value="common">Common</option>
                                      <option value="uncommon">Uncommon</option>
                                      <option value="rare">Rare</option>
                                      <option value="epic">Epic</option>
                                      <option value="legendary">Legendary</option>
                                      <option value="supreme">Supreme</option>
                                    </select>
                                  </div>
                                )}
                            </div>
                            <div className="mt-4">
                                <label className="text-xs font-bold text-slate-500 block mb-1">Descrição</label>
                                <textarea value={itemForm.description} onChange={e => setItemForm({ ...itemForm, description: e.target.value })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm h-24" />
                            </div>

                            {/* Detailed Fields based on type */}
                            <div className="border-t border-slate-700 pt-4 mt-2">
                                <h4 className="font-bold text-slate-400 text-sm mb-2">Especificações</h4>
                                <div className="grid grid-cols-2 gap-4">
                                    <div><label className="text-xs font-bold text-slate-500 block mb-1">Custo Base ($)</label><input type="number" value={itemForm.baseCost} onChange={e => setItemForm({ ...itemForm, baseCost: parseFloat(e.target.value) })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" /></div>
                                    <div><label className="text-xs font-bold text-slate-500 block mb-1">Status</label><select value={itemForm.status} onChange={e => setItemForm({ ...itemForm, status: e.target.value as Upgrade['status'] })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm"><option value="normal">Normal</option><option value="legacy">Legado (Visível em Doc)</option><option value="exclusive">Exclusivo</option><option value="limited">Edição Limitada</option><option value="retired">Retirado</option></select></div>
                                </div>

                                {itemForm.status === 'limited' && (
                                    <div className="grid grid-cols-2 gap-4 mt-2 bg-yellow-500/10 p-2 rounded border border-yellow-500/30">
                                        <div>
                                            <label className="text-xs font-bold text-yellow-500 block mb-1">Estoque Total (Unidades)</label>
                                            <input
                                                type="number"
                                                value={itemForm.maxGlobalStock || 0}
                                                onChange={e => setItemForm({ ...itemForm, maxGlobalStock: parseInt(e.target.value) })}
                                                className="w-full bg-slate-900 border border-yellow-500/50 rounded p-2 text-white text-sm"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold text-slate-500 block mb-1">Total Vendido (Apenas Leitura)</label>
                                            <div className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-slate-400 text-sm font-mono">
                                                {itemForm.totalSold || 0}
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <div className="mt-3 flex flex-wrap items-center gap-6">
                                    <div className="flex items-center gap-2">
                                        <label className="text-xs font-bold text-slate-500">Exibir no Hardware Market</label>
                                        <input type="checkbox" checked={itemForm.sellInHardwareMarket !== false} onChange={e => setItemForm({ ...itemForm, sellInHardwareMarket: e.target.checked })} />
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <label className="text-xs font-bold text-slate-500">Exibir no Black Market</label>
                                        <input type="checkbox" checked={itemForm.sellInBlackMarket !== false} onChange={e => setItemForm({ ...itemForm, sellInBlackMarket: e.target.checked })} />
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <label className="text-xs font-bold text-green-500">ATIVO</label>
                                        <input type="checkbox" checked={itemForm.isActive !== false} onChange={e => setItemForm({ ...itemForm, isActive: e.target.checked })} />
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <label className="text-xs font-bold text-orange-400 flex items-center gap-1">
                                            <Hexagon size={12} /> Item NFT (on-chain)
                                        </label>
                                        <input
                                            type="checkbox"
                                            checked={!!itemForm.isNft}
                                            onChange={(e) => setItemForm({ ...itemForm, isNft: e.target.checked })}
                                        />
                                    </div>
                                </div>


                                {itemForm.type === 'machine' && (
                                    <>
                                        <div className="grid grid-cols-2 gap-4 mt-2">
                                            <div><label className="text-xs font-bold text-slate-500 block mb-1">Hashrate (H/s)</label><input type="number" value={itemForm.baseProduction} onChange={e => setItemForm({ ...itemForm, baseProduction: parseFloat(e.target.value) })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" /></div>
                                            <div><label className="text-xs font-bold text-slate-500 block mb-1">Consumo (W)</label><input type="number" value={itemForm.powerConsumption} onChange={e => setItemForm({ ...itemForm, powerConsumption: parseFloat(e.target.value) })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" /></div>
                                        </div>
                                        <div className="mt-3">
                                            <label className="text-xs font-bold text-amber-400 block mb-1">Moeda na Sala NFT (por ASIC)</label>
                                            <select
                                                value={itemForm.nftMiningCoinId || ''}
                                                onChange={(e) =>
                                                    setItemForm({
                                                        ...itemForm,
                                                        nftMiningCoinId: e.target.value.trim() || undefined
                                                    })
                                                }
                                                className="w-full bg-slate-900 border border-amber-600/40 rounded p-2 text-white text-sm"
                                            >
                                                <option value="">— Não minera na Sala NFT —</option>
                                                {nftAsicCoinSelectOptions.map((c) => (
                                                    <option key={c.id} value={c.id}>
                                                        {c.name} ({c.symbol || c.id})
                                                        {!c.isActive ? ' — inativa' : ''}
                                                    </option>
                                                ))}
                                            </select>
                                            <p className="text-[10px] text-slate-500 mt-1">
                                                Obrigatório para ASICs na Sala NFT. Ao guardar o catálogo, a moeda escolhida deixa de poder ser farmada em rigs/GPUs normais (só nesta sala, via ASIC).
                                            </p>
                                        </div>
                                        {isAsicMachineUpgrade({
                                            id: itemForm.id || '',
                                            category: itemForm.category || '',
                                            type: itemForm.type || 'machine'
                                        }) && (
                                            <div className="mt-3 space-y-3">
                                                <label className="text-xs font-bold text-cyan-400 block">
                                                    Validade da ASIC (aluguer)
                                                </label>
                                                <label className="flex items-center gap-2 text-sm text-slate-300">
                                                    <input
                                                        type="checkbox"
                                                        checked={
                                                            !itemForm.asicDurationAmount ||
                                                            Number(itemForm.asicDurationAmount) <= 0
                                                        }
                                                        onChange={(e) => {
                                                            if (e.target.checked) {
                                                                setItemForm({
                                                                    ...itemForm,
                                                                    asicDurationAmount: 0,
                                                                    asicDurationUnit: undefined
                                                                });
                                                            } else {
                                                                setItemForm({
                                                                    ...itemForm,
                                                                    asicDurationAmount: Math.max(
                                                                        1,
                                                                        Math.floor(Number(itemForm.asicDurationAmount) || 7)
                                                                    ),
                                                                    asicDurationUnit:
                                                                        (itemForm.asicDurationUnit as AsicDurationUnit) ||
                                                                        'day'
                                                                });
                                                            }
                                                        }}
                                                        className="rounded border-slate-600"
                                                    />
                                                    Permanente (sem validade)
                                                </label>
                                                {Number(itemForm.asicDurationAmount) > 0 && (
                                                    <div className="grid grid-cols-2 gap-3">
                                                        <div>
                                                            <label className="text-xs font-bold text-slate-500 block mb-1">
                                                                Quantidade
                                                            </label>
                                                            <input
                                                                type="number"
                                                                min={1}
                                                                max={9999}
                                                                value={itemForm.asicDurationAmount || 1}
                                                                onChange={(e) =>
                                                                    setItemForm({
                                                                        ...itemForm,
                                                                        asicDurationAmount: Math.max(
                                                                            1,
                                                                            Math.floor(Number(e.target.value) || 1)
                                                                        )
                                                                    })
                                                                }
                                                                className="w-full bg-slate-900 border border-cyan-600/40 rounded p-2 text-white text-sm"
                                                            />
                                                        </div>
                                                        <div>
                                                            <label className="text-xs font-bold text-slate-500 block mb-1">
                                                                Unidade
                                                            </label>
                                                            <select
                                                                value={
                                                                    (itemForm.asicDurationUnit as AsicDurationUnit) ||
                                                                    'day'
                                                                }
                                                                onChange={(e) =>
                                                                    setItemForm({
                                                                        ...itemForm,
                                                                        asicDurationUnit: e.target
                                                                            .value as AsicDurationUnit
                                                                    })
                                                                }
                                                                className="w-full bg-slate-900 border border-cyan-600/40 rounded p-2 text-white text-sm"
                                                            >
                                                                {ASIC_DURATION_UNITS.map((u) => (
                                                                    <option key={u} value={u}>
                                                                        {ASIC_DURATION_UNIT_LABELS[u]}
                                                                    </option>
                                                                ))}
                                                            </select>
                                                        </div>
                                                    </div>
                                                )}
                                                {Number(itemForm.asicDurationAmount) > 0 &&
                                                    itemForm.asicDurationUnit && (
                                                        <p className="text-xs text-cyan-300/90 font-medium">
                                                            Cada unidade expira em:{' '}
                                                            {formatAsicDurationPreview(
                                                                Number(itemForm.asicDurationAmount),
                                                                itemForm.asicDurationUnit as AsicDurationUnit
                                                            )}
                                                        </p>
                                                    )}
                                                <p className="text-[10px] text-slate-500">
                                                    Após expirar, a unidade some do estoque e da rig — o jogador precisa
                                                    comprar de novo.
                                                </p>
                                            </div>
                                        )}
                                    </>
                                )}

                                {itemForm.type === 'battery' && (
                                    <div className="mt-2">
                                        <div><label className="text-xs font-bold text-slate-500 block mb-1">Capacidade (Wh)</label><input type="number" value={itemForm.powerCapacity} onChange={e => setItemForm({ ...itemForm, powerCapacity: parseFloat(e.target.value) })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" /></div>
                                    </div>
                                )}

                                {itemForm.type === 'infrastructure' && (
                                    <div className="mt-2 space-y-3">
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="text-xs font-bold text-slate-500 block mb-1">Slots GPUs</label>
                                                <input
                                                    type="number"
                                                    disabled={isInfrastructureMerge}
                                                    value={itemForm.slotsCapacity}
                                                    onChange={e => setItemForm({ ...itemForm, slotsCapacity: parseFloat(e.target.value) })}
                                                    className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm disabled:opacity-60"
                                                />
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-slate-500 block mb-1">Slots IA</label>
                                                <input
                                                    type="number"
                                                    disabled={isInfrastructureMerge}
                                                    value={itemForm.aiSlotsCapacity}
                                                    onChange={e => setItemForm({ ...itemForm, aiSlotsCapacity: parseFloat(e.target.value) })}
                                                    className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm disabled:opacity-60"
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold text-slate-500 block mb-1">Salas</label>
                                            <div className="flex flex-wrap items-center gap-4 mt-1">
                                                {RACK_ROOM_AFFINITY_CHECKBOXES.map(({ kind, label }) => (
                                                    <label key={kind} className="flex items-center gap-2 text-sm text-slate-300">
                                                        <input
                                                            type="checkbox"
                                                            disabled={isInfrastructureMerge}
                                                            checked={rackRoomAffinityKinds(infrastructureAffinity).includes(kind)}
                                                            onChange={(e) => toggleInfrastructureRoomKind(kind, e.target.checked)}
                                                        />
                                                        {label}
                                                    </label>
                                                ))}
                                            </div>
                                        </div>
                                        {isInfrastructureMerge ? (
                                            <p className="text-[10px] text-slate-500">{RACK_FAMILY_INHERITED_HINT}</p>
                                        ) : null}
                                    </div>
                                )}

                                {itemForm.type === 'multiplier' && (
                                    <div className="grid grid-cols-2 gap-4 mt-2">
                                        <div><label className="text-xs font-bold text-slate-500 block mb-1">Multiplicador (0.1 = 10%)</label><input type="number" value={itemForm.multiplier} onChange={e => setItemForm({ ...itemForm, multiplier: parseFloat(e.target.value) })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" /></div>
                                        <div><label className="text-xs font-bold text-slate-500 block mb-1">Consumo Extra (W)</label><input type="number" value={itemForm.powerConsumption} onChange={e => setItemForm({ ...itemForm, powerConsumption: parseFloat(e.target.value) })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" /></div>
                                    </div>
                                )}

                            </div>

                            {itemForm.type === 'wiring' && (
                                <div className="grid grid-cols-2 gap-4 mt-2">
                                    <div><label className="text-xs font-bold text-slate-500 block mb-1">Redução de Consumo (0.1 = 10%)</label><input type="number" value={itemForm.energyConsumptionReduction || 0} onChange={e => setItemForm({ ...itemForm, energyConsumptionReduction: parseFloat(e.target.value) })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" /></div>
                                </div>
                            )}

                            {/* COMPATIBILITY SELECTION */}
                            {(itemForm.type === 'battery' || itemForm.type === 'wiring' || itemForm.type === 'multiplier' || itemForm.type === 'machine') && (
                                <div className="border-t border-slate-700 pt-4 mt-2">
                                    <h4 className="font-bold text-slate-400 text-sm mb-2">Compatibilidade de Rigs (Vazio = Todos)</h4>
                                    <div className="grid grid-cols-2 gap-2">
                                        {infrastructureItems.map(rack => (
                                            <label key={rack.id} className="flex items-center gap-2 cursor-pointer bg-slate-900 p-2 rounded border border-slate-700">
                                                <input
                                                    type="checkbox"
                                                    checked={itemForm.compatibleRacks?.includes(rack.id)}
                                                    onChange={() => toggleCompatibleRack(rack.id)}
                                                />
                                                <span className="text-sm text-slate-300">{rack.name}</span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="flex flex-wrap gap-3 pt-4 border-t border-slate-700 mt-4">
                                <button
                                    type="button"
                                    onClick={() => { setEditItemMode(false); setEditingSourceId(null); }}
                                    className="bg-slate-700 text-white px-4 py-2 rounded font-bold"
                                >
                                    CANCELAR
                                </button>
                                {isPersistedIdEdit && !formIsRetired ? (
                                    <button
                                        type="button"
                                        disabled={isSaving || isLifecycleBusy}
                                        onClick={() => void handleLifecycleAction('retire')}
                                        className="bg-rose-900/80 hover:bg-rose-800 text-white px-4 py-2 rounded font-bold disabled:opacity-50"
                                    >
                                        Retirar
                                    </button>
                                ) : null}
                                {isPersistedIdEdit && formIsRetired ? (
                                    <button
                                        type="button"
                                        disabled={isSaving || isLifecycleBusy}
                                        onClick={() => void handleLifecycleAction('reactivate')}
                                        className="bg-emerald-700 hover:bg-emerald-600 text-white px-4 py-2 rounded font-bold disabled:opacity-50"
                                    >
                                        Reativar
                                    </button>
                                ) : null}
                                <button
                                    type="button"
                                    disabled={isSaving || isLifecycleBusy}
                                    onClick={handleSaveItem}
                                    className="bg-amber-600 text-white px-4 py-2 rounded font-bold flex-1 disabled:opacity-50"
                                >
                                    SALVAR ITEM
                                </button>
                            </div>                        </div>
                    ) : (
                        <div className="h-full flex items-center justify-center text-slate-500">Selecione um item para editar.</div>
                    )}
                </div>
            </div>
        </div>
    );
};
