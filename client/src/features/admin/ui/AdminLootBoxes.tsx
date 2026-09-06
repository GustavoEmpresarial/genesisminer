// @ts-nocheck — template legado 1:1.
import React, { useState, useEffect } from 'react';
import { LootBox, LootBoxItem, Upgrade, PromoCode, AdminUpgrade } from '../lib/adminTypes';

/** Gatilhos em que a caixa não usa a lista de itens da definição (fluxo próprio). */
const LOOT_TRIGGERS_WITHOUT_ITEM_LIST = new Set(['roleta_code']);

const STORE_LIKE_TRIGGERS = new Set(['shop', 'shop_once', 'special']);

function validateLootBoxForm(box: Partial<LootBox>): string | null {
    const id = String(box.id || '').trim();
    const name = typeof box.name === 'string' ? box.name.trim() : '';
    if (!id) return 'ID da caixa é obrigatório.';
    if (!name) return 'Nome é obrigatório.';
    const active = box.isActive !== false;
    const trig = String(box.trigger || 'shop');
    const raw = Array.isArray(box.items) ? box.items : [];
    const okItems = raw.filter(
        (it: LootBoxItem) => it && String((it as LootBoxItem).id || '').trim()
    );
    if (active && !LOOT_TRIGGERS_WITHOUT_ITEM_LIST.has(trig) && okItems.length === 0) {
        return 'Caixa ativa sem prémios: adicione pelo menos um item (tipo + ID) ou desmarque "Caixa ativa". Gatilho "Roleta (código)" é a única exceção sem lista aqui.';
    }
    if (active && STORE_LIKE_TRIGGERS.has(trig)) {
        const p = Number(box.price);
        if (!Number.isFinite(p) || p <= 0) {
            return 'Para gatilhos de loja (Loja / Loja 1x / Evento especial), defina preço USDC maior que zero.';
        }
    }
    return null;
}
import { PlusCircle, X, Trash2, Gift, Ticket, Plus, Users, RefreshCw, Package, ToggleLeft, ToggleRight } from 'lucide-react';
import { getSeasonPasses, getAdminUpgrades, getLootBoxes, deleteLootBox } from '../../../shared/api/admin-legacy';
import { apiFetch } from '../../../shared/api/http';

interface AdminLootBoxesProps {
    lootBoxes: LootBox[];
    onUpdateLootBoxes?: (boxes: LootBox[]) => void;
    gameUpgrades: Upgrade[];
}

export const AdminLootBoxes: React.FC<AdminLootBoxesProps> = ({ lootBoxes, onUpdateLootBoxes, gameUpgrades }) => {
    const [editBoxMode, setEditBoxMode] = useState<boolean>(false);
    const [boxForm, setBoxForm] = useState<Partial<LootBox>>({
        id: '', name: '', description: '', price: 1, trigger: 'shop', items: [], icon: '🎁'
    });
    const [newItemForm, setNewItemForm] = useState<Partial<LootBoxItem>>({
        type: 'item', id: '', minQty: 1, maxQty: 1, probability: 50
    });
    const [seasonIds, setSeasonIds] = useState<string[]>([]);
    const [boxCodes, setBoxCodes] = useState<PromoCode[]>([]);
    const [promoType, setPromoType] = useState<'per_player' | 'global_once' | 'roleta_player_1x' | 'roleta_global_1x'>('per_player');
    const [rewardType, setRewardType] = useState<'box' | 'upgrade' | 'bundle'>('box');
    const [selectedUpgradeId, setSelectedUpgradeId] = useState<string>('');
    const [adminBundles, setAdminBundles] = useState<AdminUpgrade[]>([]);
    const [selectedBundleId, setSelectedBundleId] = useState<string>('');
    const [redemptions, setRedemptions] = useState<{ code: string; type: string; username: string; redeemedAt: number }[]>([]);
    const [selectedBundle, setSelectedBundle] = useState<AdminUpgrade | null>(null);
    const [editBundleMode, setEditBundleMode] = useState<boolean>(false);
    const [generatingCode, setGeneratingCode] = useState<boolean>(false);
    /** Dias até expirar a partir da geração; vazio = sem limite */
    const [promoValidityDays, setPromoValidityDays] = useState<string>('');
    const [deletingAllCodes, setDeletingAllCodes] = useState(false);
    const [activeTab, setActiveTab] = useState<string>('all');

    const loadRedemptions = async (boxId: string) => {
        try {
            const res = await apiFetch(`/api/admin/loot-box-redemptions/${boxId}`);
            const data = await res.json();
            setRedemptions(Array.isArray(data) ? data : []);
        } catch (e) { }
    };

    const loadBoxCodes = async (boxId?: string, bundleId?: string) => {
        try {
            const res = await apiFetch('/api/admin/promo-codes');
            const data = await res.json();
            const list = Array.isArray(data) ? data : [];
            (window as any)._lastBoxCodesTotal = list.length;

            if (bundleId) {
                const targetBundleId = bundleId.toLowerCase().trim();
                const filtered = list.filter((c: any) => {
                    const cBundleId = (c.adminUpgradeId || c.admin_upgrade_id || '').toString().toLowerCase().trim();
                    return cBundleId === targetBundleId;
                });
                setBoxCodes(filtered);
            } else if (boxId) {
                const targetBoxId = boxId.toLowerCase().trim();
                const filtered = list.filter((c: any) => {
                    const cBoxId = (c.lootBoxId || c.loot_box_id || '').toString().toLowerCase().trim();
                    const cUpgradeId = (c.upgradeId || c.upgrade_id || '').toString().toLowerCase().trim();
                    const cAdminUpgradeId = (c.adminUpgradeId || c.admin_upgrade_id || '').toString().toLowerCase().trim();

                    return cBoxId === targetBoxId || (cUpgradeId !== '' && cUpgradeId !== 'null') || (cAdminUpgradeId !== '' && cAdminUpgradeId !== 'null');
                });
                setBoxCodes(filtered);
            } else {
                setBoxCodes(list);
            }
        } catch (e) {
            console.error('Erro ao carregar códigos:', e);
        }
    };

    const loadAdminBundles = async () => {
        try {
            const list = await getAdminUpgrades();
            setAdminBundles(list || []);
        } catch (e) { }
    };

    useEffect(() => {
        loadAdminBundles();
    }, []);

    // Helper to render icon (emoji or image)
    const renderIcon = (icon: string, sizeClass: string = "text-xl", imgClass: string = "") => {
        if (!icon) return <span className={sizeClass}>🎁</span>;

        const isImage = icon.includes('/') || icon.includes('http') ||
            icon.endsWith('.png') || icon.endsWith('.jpg') ||
            icon.endsWith('.gif') || icon.endsWith('.ico') || icon.endsWith('.webp');

        if (isImage) {
            return <img src={icon} alt="icon" className={`object-contain ${imgClass}`} style={{ width: '1em', height: '1em', fontSize: 'inherit' }} />;
        }
        return <span className={sizeClass}>{icon}</span>;
    };

    useEffect(() => {
        if (editBoxMode && boxForm.id && (boxForm.trigger === 'promo_code' || boxForm.trigger === 'roleta_code')) {
            loadBoxCodes(boxForm.id);
            loadRedemptions(boxForm.id);
        }
    }, [editBoxMode, boxForm.id, boxForm.trigger]);

    useEffect(() => {
        const loadSeasons = async () => {
            const passes = await getSeasonPasses();
            const ids = Array.from(new Set(passes.map(p => p.seasonId))).sort();
            setSeasonIds(ids);
        };
        loadSeasons();
    }, []);

    const handleNewBox = () => {
        setEditBoxMode(true);
        // Caixas novas nascem como rascunho (inactivas): caixa activa sem prémios
        // é rejeitada por validação (front e back). Admin guarda rascunho, adiciona
        // itens, e activa via checkbox "Caixa ativa".
        setBoxForm({
            id: crypto.randomUUID(), name: 'Nova Caixa', description: '', price: 1, trigger: 'shop', items: [], icon: '🎁', isActive: false
        });
    };

    const handleEditBox = (box: LootBox) => {
        setBoxForm({ ...box });
        setEditBoxMode(true);
    };

    const handleSaveBox = () => {
        if (!onUpdateLootBoxes || !boxForm.id || !boxForm.name) return;
        const err = validateLootBoxForm(boxForm);
        if (err) {
            alert(err);
            return;
        }
        const newBox = boxForm as LootBox;
        const existingIndex = lootBoxes.findIndex(b => b.id === newBox.id);
        const updated = [...lootBoxes];
        if (existingIndex >= 0) updated[existingIndex] = newBox;
        else updated.push(newBox);
        onUpdateLootBoxes(updated);
        setEditBoxMode(false);
    };

    const handleDeleteBox = async (id: string) => {
        if (!onUpdateLootBoxes) return;
        if (!window.confirm(
            'Apagar esta caixa na base de dados? Isto remove prémios, caixas não abertas nos inventários, registos shop_once, vínculos em pacotes admin, códigos promo (loot_box_id) e referências em modelos de indicação. Não dá para desfazer.'
        )) {
            return;
        }
        try {
            const { summary } = await deleteLootBox(id);
            onUpdateLootBoxes(lootBoxes.filter(b => b.id !== id));
            setEditBoxMode(false);
            alert(
                `Caixa removida.\n` +
                `Prémios (linhas): ${summary.lootBoxItemsRemoved}\n` +
                `Inventários (unopened_boxes): ${summary.unopenedBoxesRows}\n` +
                `Shop 1x (player_claimed): ${summary.playerClaimedRows}\n` +
                `Pacotes admin: ${summary.adminUpgradeBoxesRows}\n` +
                `Códigos promo atualizados: ${summary.promoCodesCleared}\n` +
                `Referral sender/receiver limpos: ${summary.referralModelsSenderCleared} / ${summary.referralModelsReceiverCleared}`
            );
        } catch (e) {
            alert(e instanceof Error ? e.message : 'Falha ao apagar caixa no servidor.');
        }
    };

    const handleDeleteBoxIfBroken = async (id: string) => {
        if (!onUpdateLootBoxes) return;
        if (!window.confirm(
            'Remover da base de dados só se a caixa estiver inválida (sem linhas em loot_box_items ou todas as probabilidades a zero)? Caixas com sorteio válido não serão apagadas.'
        )) {
            return;
        }
        try {
            const { summary } = await deleteLootBox(id, { brokenOnly: true });
            onUpdateLootBoxes(lootBoxes.filter(b => b.id !== id));
            setEditBoxMode(false);
            alert(`Caixa inválida removida.\nloot_boxes removidos: ${summary.lootBoxesRemoved}`);
        } catch (e) {
            alert(e instanceof Error ? e.message : 'Não foi possível apagar (caixa pode ter prémios válidos).');
        }
    };

    const handleAddBoxItem = () => {
        if (!newItemForm.id) return;
        const newItems = [...(boxForm.items || [])];
        newItems.push({ ...newItemForm } as LootBoxItem);
        setBoxForm({ ...boxForm, items: newItems });
        setNewItemForm({ type: 'item', id: '', minQty: 1, maxQty: 1, probability: 50 });
    }

    const removeBoxItem = (idx: number) => {
        const newItems = [...(boxForm.items || [])];
        newItems.splice(idx, 1);
        setBoxForm({ ...boxForm, items: newItems });
    }

    const handleGenerateCode = async () => {
        if (generatingCode) return;
        const isBundleMode = editBundleMode && selectedBundle;
        // Se estiver no modo pacote, forçamos o tipo pacote
        const effectiveRewardType = isBundleMode ? 'bundle' : rewardType;
        const effectiveRewardId = isBundleMode ? selectedBundle.id : (rewardType === 'upgrade' ? selectedUpgradeId : selectedBundleId);

        if (!boxForm.id && !isBundleMode && rewardType === 'box') {
            alert("ID da caixa não encontrado. Tente salvar a caixa primeiro.");
            return;
        }

        const randomCode = Math.random().toString(36).substring(2, 10).toUpperCase();

        const payload: any = {
            code: randomCode,
            type: promoType
        };

        const days = parseInt(String(promoValidityDays).trim(), 10);
        if (promoValidityDays.trim() !== '' && (!Number.isFinite(days) || days < 1 || days > 3650)) {
            alert('Validade inválida: use dias entre 1 e 3650 ou deixe em branco para sem expiração.');
            return;
        }
        if (promoValidityDays.trim() !== '' && Number.isFinite(days) && days >= 1) {
            payload.expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
        }

        if (effectiveRewardType === 'bundle') {
            if (!effectiveRewardId && !isBundleMode) {
                alert("Selecione um pacote primeiro!");
                return;
            }
            payload.adminUpgradeId = effectiveRewardId;
        } else if (effectiveRewardType === 'upgrade') {
            if (!selectedUpgradeId) {
                alert("Selecione um item primeiro!");
                return;
            }
            payload.upgradeId = selectedUpgradeId;
        } else {
            if (!boxForm.id) {
                alert("ID da caixa ausente!");
                return;
            }
            /** Sempre ligar o código à caixa (incl. roleta): o servidor usa `loot_box_id` + gatilho `roleta_code` para o fluxo certo. */
            payload.lootBoxId = boxForm.id;
        }

        setGeneratingCode(true);
        try {
            const res = await apiFetch('/api/admin/promo-codes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                if (isBundleMode) {
                    await loadBoxCodes(undefined, selectedBundle.id);
                } else {
                    await loadBoxCodes(boxForm.id || '');
                }
                alert(`Código gerado: ${randomCode}`);
            } else {
                const err = await res.json();
                alert(err.error || 'Erro ao gerar código');
            }
        } catch (e) {
            alert('Erro de conexão ao gerar código');
            console.error(e);
        } finally {
            setGeneratingCode(false);
        }
    };

    const handleDeleteAllVisibleCodes = async () => {
        if (boxCodes.length === 0) {
            alert('Não há códigos nesta lista.');
            return;
        }
        if (!window.confirm(`Apagar ${boxCodes.length} código(s) desta vista? Isto remove também o histórico de resgates associado a esses códigos.`)) {
            return;
        }
        setDeletingAllCodes(true);
        try {
            const res = await apiFetch('/api/admin/promo-codes/bulk-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ codes: boxCodes.map((c) => c.code) })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                if (editBundleMode && selectedBundle) {
                    await loadBoxCodes(undefined, selectedBundle.id);
                } else {
                    await loadBoxCodes(boxForm.id || '');
                }
                alert(`Removidos ${typeof data.deleted === 'number' ? data.deleted : boxCodes.length} código(s).`);
            } else {
                alert((data as { error?: string }).error || 'Erro ao apagar códigos.');
            }
        } catch (e) {
            alert('Erro de conexão ao apagar códigos.');
            console.error(e);
        } finally {
            setDeletingAllCodes(false);
        }
    };

    const handleDeleteCode = async (code: string) => {
        if (!window.confirm(`Excluir código ${code}?`)) return;
        try {
            const res = await apiFetch(`/api/admin/promo-codes/${code}`, { method: 'DELETE' });
            if (res.ok) {
                if (editBundleMode && selectedBundle) {
                    await loadBoxCodes(undefined, selectedBundle.id);
                } else {
                    await loadBoxCodes(boxForm.id || '');
                }
                alert('Código excluído com sucesso!');
            } else {
                alert('Erro ao excluir código');
            }
        } catch (e) {
            alert('Erro de conexão ao excluir código');
        }
    };

    const handleToggleCode = async (code: string, currentStatus: boolean) => {
        try {
            const res = await apiFetch(`/api/admin/promo-codes/${code}/toggle`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isActive: !currentStatus })
            });
            if (res.ok) {
                if (editBundleMode && selectedBundle) {
                    await loadBoxCodes(undefined, selectedBundle.id);
                } else {
                    await loadBoxCodes(boxForm.id || '');
                }
            } else {
                alert('Erro ao alterar status do código');
            }
        } catch (e) {
            alert('Erro de conexão ao alterar status do código');
        }
    };

    return (
        <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-right-4">
            {/* TABS PARA GATILHOS (ESTILO MENU SUPERIOR) */}
            <div className="flex gap-2 mb-4 border-b border-slate-700 pb-2 overflow-x-auto custom-scrollbar flex-shrink-0">
                <button
                    onClick={() => setActiveTab('all')}
                    className={`px-3 py-2 text-sm font-bold uppercase rounded flex-shrink-0 whitespace-nowrap ${activeTab === 'all' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'}`}
                >
                    Gestão Geral
                </button>
                {Array.from(new Set(lootBoxes.map(b => b.trigger))).sort().map(trigger => (
                    <button
                        key={trigger}
                        onClick={() => setActiveTab(trigger)}
                        className={`px-3 py-2 text-sm font-bold uppercase rounded flex-shrink-0 whitespace-nowrap ${activeTab === trigger ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'}`}
                    >
                        {trigger === 'shop' ? 'Loja' : trigger === 'registration' ? 'Cadastro' : trigger === 'upgrade' ? 'Upgrade' : trigger === 'promo_code' ? 'Promo Code' : trigger === 'roleta_code' ? 'Roleta' : trigger === 'shop_once' ? 'Loja 1x' : trigger === 'special' ? 'Especial' : trigger === 'referral_sender' ? 'Indicou' : trigger === 'referral_receiver' ? 'Indicado' : trigger.startsWith('season:') ? `Temp: ${trigger.split(':')[1]}` : trigger}
                    </button>
                ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* LIST */}
                <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 h-[70vh] flex flex-col">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="font-bold text-white">Caixas Configuradas</h3>
                        <button onClick={handleNewBox} className="bg-green-600 text-white text-xs px-2 py-1 rounded flex items-center gap-1"><PlusCircle size={12} /> NOVA</button>
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2">
                        {lootBoxes.filter(b => activeTab === 'all' || b.trigger === activeTab).map(box => (
                            <div key={box.id} onClick={() => { handleEditBox(box); setSelectedBundle(null); setEditBundleMode(false); }} className={`p-3 rounded border cursor-pointer flex justify-between items-center transition-all ${editBoxMode && boxForm.id === box.id ? 'bg-slate-700 border-orange-500 ring-1 ring-orange-500' : 'bg-slate-900 border-slate-700 hover:border-slate-500'} ${box.isActive === false ? 'opacity-50 grayscale' : ''}`}>
                                <div>
                                    <div className="font-bold text-white flex items-center gap-2">
                                        <span className="flex items-center justify-center w-5 h-5">{renderIcon(box.icon, "text-base", "w-4 h-4")}</span> {box.name}
                                        {box.isActive === false && <span className="text-[10px] bg-red-500/20 text-red-500 px-1.5 py-0.5 rounded uppercase font-bold ml-2">Inativa</span>}
                                    </div>
                                    <div className="text-[10px] text-slate-500 mt-1 uppercase font-bold">
                                        Gatilho: {box.trigger}
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="text-xs text-green-400 font-bold">${box.price}</div>
                                    <div className="text-[10px] text-slate-500">{box.items.length} Itens</div>
                                </div>
                            </div>
                        ))}

                        <h3 className="font-bold text-amber-500 mt-6 mb-3 flex items-center gap-2 text-xs uppercase tracking-widest border-t border-slate-700 pt-4">
                            <Package size={14} /> Pacotes de Upgrades
                        </h3>
                        <div className="space-y-2">
                            {adminBundles.map(bundle => (
                                <div key={bundle.id} onClick={() => { setSelectedBundle(bundle); setEditBoxMode(false); setEditBundleMode(true); }} className={`p-3 rounded border cursor-pointer flex justify-between items-center transition-all ${editBundleMode && selectedBundle?.id === bundle.id ? 'bg-slate-700 border-amber-500 ring-1 ring-amber-500' : 'bg-slate-900 border-slate-700 hover:border-slate-500'}`}>
                                    <div>
                                        <div className="font-bold text-white flex items-center gap-2">
                                            <Package size={14} className="text-amber-500" /> {bundle.name}
                                        </div>
                                        <div className="text-[10px] text-slate-500 mt-1 uppercase font-bold">
                                            ID: {bundle.id}
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-xs text-amber-400 font-bold">${bundle.priceUsdc}</div>
                                        <div className="text-[10px] text-slate-500 uppercase font-bold">Pacote</div>
                                    </div>
                                </div>
                            ))}
                            {adminBundles.length === 0 && <div className="text-center py-4 text-slate-600 text-[10px] uppercase font-bold border border-dashed border-slate-700 rounded-lg">Nenhum pacote disponível</div>}
                        </div>
                    </div>
                </div>

                {/* EDITOR */}
                <div className="lg:col-span-2 bg-slate-800 border border-slate-700 rounded-xl p-6 h-[70vh] overflow-y-auto custom-scrollbar">
                    {editBoxMode ? (
                        <div className="space-y-6">
                            <div className="flex justify-between items-center border-b border-slate-700 pb-2 mb-4">
                                <h3 className="text-xl font-bold text-white">
                                    {boxForm.id ? `Editando: ${boxForm.name}` : 'Nova Caixa Surpresa'}
                                </h3>
                                <button onClick={() => setEditBoxMode(false)} className="text-slate-500 hover:text-white"><X size={20} /></button>
                            </div>

                            {/* BASIC INFO */}
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="text-xs font-bold text-slate-500 block mb-1">Nome</label>
                                    <input type="text" value={boxForm.name} onChange={e => setBoxForm({ ...boxForm, name: e.target.value })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" />
                                </div>
                                <div>
                                    <label className="text-xs font-bold text-slate-500 block mb-1">Ícone (Emoji ou URL)</label>
                                    <div className="flex gap-2">
                                        <input type="text" value={boxForm.icon} onChange={e => setBoxForm({ ...boxForm, icon: e.target.value })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" placeholder="🎁 ou /img/..." />
                                        <div className="bg-slate-900 border border-slate-600 rounded p-1 w-10 flex items-center justify-center">
                                            {renderIcon(boxForm.icon || '🎁', "text-xl", "w-6 h-6")}
                                        </div>
                                    </div>
                                </div>
                                <div className="col-span-2">
                                    <label className="text-xs font-bold text-slate-500 block mb-1">Descrição</label>
                                    <input type="text" value={boxForm.description} onChange={e => setBoxForm({ ...boxForm, description: e.target.value })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" />
                                </div>
                                <div className="col-span-2 flex items-center gap-2 mt-1 mb-2">
                                    {(() => {
                                        const trig = String(boxForm.trigger || 'shop');
                                        const itemCount = Array.isArray(boxForm.items)
                                            ? boxForm.items.filter((it: LootBoxItem) => it && String(it.id || '').trim()).length
                                            : 0;
                                        const canActivate = LOOT_TRIGGERS_WITHOUT_ITEM_LIST.has(trig) || itemCount > 0;
                                        return (
                                            <>
                                                <input
                                                    type="checkbox"
                                                    id="isActiveBox"
                                                    checked={boxForm.isActive !== false}
                                                    disabled={!canActivate && boxForm.isActive === false}
                                                    onChange={e => setBoxForm({ ...boxForm, isActive: e.target.checked })}
                                                    className={`w-4 h-4 ${!canActivate && boxForm.isActive === false ? 'opacity-40 cursor-not-allowed' : ''}`}
                                                    title={!canActivate ? 'Adicione pelo menos um prémio antes de activar a caixa.' : 'Marque para disponibilizar a caixa no jogo.'}
                                                />
                                                <label htmlFor="isActiveBox" className="text-sm font-bold text-white cursor-pointer">
                                                    Caixa ativa (disponível no jogo)
                                                </label>
                                                {boxForm.isActive === false && (
                                                    <span className="text-[10px] bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded uppercase font-bold ml-1">
                                                        Rascunho
                                                    </span>
                                                )}
                                                {!canActivate && boxForm.isActive === false && (
                                                    <span className="text-[10px] text-amber-400 ml-1">
                                                        (adicione prémios para activar)
                                                    </span>
                                                )}
                                            </>
                                        );
                                    })()}
                                </div>
                                <div className="col-span-2 rounded-lg border border-slate-600 bg-slate-900/80 p-3 text-xs text-slate-300 leading-relaxed space-y-1">
                                    <div>
                                        {STORE_LIKE_TRIGGERS.has(String(boxForm.trigger || '')) ? (
                                            <span className="font-bold uppercase tracking-wide text-amber-400">Aparece na loja pública (Caixas da Sorte)</span>
                                        ) : (
                                            <span className="font-bold uppercase tracking-wide text-slate-500">Fora da vitrine da loja de caixas</span>
                                        )}
                                    </div>
                                    <p>
                                        Gatilhos <span className="font-mono text-slate-200">Loja</span>, <span className="font-mono text-slate-200">Loja 1x</span> e <span className="font-mono text-slate-200">Evento especial</span> mostram a caixa aos jogadores na aba Caixas da Sorte.
                                        Caixa <span className="text-white font-bold">ativa</span> exige pelo menos um prémio configurado (exceção: <span className="font-mono text-slate-200">Roleta (código)</span>).
                                    </p>
                                </div>
                                <div>
                                    <label className="text-xs font-bold text-slate-500 block mb-1">Gatilho (Onde aparece)</label>
                                    <select value={boxForm.trigger} onChange={e => setBoxForm({ ...boxForm, trigger: e.target.value as any })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm">
                                        <option value="shop">Loja (Comprar)</option>
                                        <option value="shop_once">Loja (Resgate Único)</option>
                                        <option value="registration">Cadastro (Grátis)</option>
                                        <option value="upgrade">Upgrade (Bônus)</option>
                                        <option value="special">Evento Especial (aparece na loja Caixas da Sorte)</option>
                                        <option value="referral_sender">Referência (Quem Indicou)</option>
                                        <option value="referral_receiver">Referência (Indicado)</option>
                                        <option value="promo_code">Código de Resgate</option>
                                        <option value="roleta_code">Código de Roleta</option>
                                        {seasonIds.map(id => (
                                            <option key={id} value={`season:${id}`}>Temporada: {id}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="text-xs font-bold text-slate-500 block mb-1">Preço (Se Loja - USDC)</label>
                                    <input type="number" min="0" step="any" value={Number.isFinite(boxForm.price as number) ? boxForm.price : 0} onChange={e => { const v = parseFloat(e.target.value); setBoxForm({ ...boxForm, price: Number.isFinite(v) ? v : 0 }); }} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" />
                                </div>
                            </div>

                            {/* CONTENTS - Hide for Roleta Code as prize comes from wheel */}
                            {boxForm.trigger !== 'roleta_code' && (
                                <div className="border-t border-slate-700 pt-4">
                                    <h4 className="font-bold text-orange-400 mb-2">Conteúdo da Caixa</h4>
                                    {boxForm.trigger === 'registration' ? (
                                        <p className="text-xs text-slate-400 mb-3 leading-relaxed border-l-2 border-emerald-600/80 pl-3">
                                            <strong className="text-slate-200">Cadastro:</strong> cada abertura entrega <strong className="text-slate-200">todas</strong> as linhas com valor &gt; 0 (quantidade aleatória entre min e max).
                                        </p>
                                    ) : (
                                        <p className="text-xs text-slate-400 mb-3 leading-relaxed border-l-2 border-amber-600/80 pl-3">
                                            <strong className="text-slate-200">% Chance independente:</strong> cada item tem a sua própria hipótese de sair. <strong className="text-emerald-400">100% = sempre entregue (garantido)</strong>. Podes ter vários itens a 100% e <strong className="text-slate-200">todos serão dados</strong>. Valores &lt; 100 têm essa % de hipótese individualmente.
                                        </p>
                                    )}
                                    <div className="bg-slate-900 rounded p-3 mb-4 space-y-2">
                                        {boxForm.items?.map((item, idx) => (
                                            <div key={idx} className="flex justify-between items-center text-sm bg-slate-800 p-2 rounded border border-slate-700">
                                                <div>
                                                    <span className="font-bold text-white">{item.type === 'item' ? gameUpgrades.find(u => u.id === item.id)?.name || item.id : item.id.toUpperCase()}</span>
                                                    <span className="text-slate-500 ml-2">x{item.minQty}-{item.maxQty}</span>
                                                </div>
                                                <div className="flex items-center gap-3">
                                                    <span className="text-yellow-500 font-mono">
                                                        {boxForm.trigger === 'registration'
                                                            ? (Number(item.probability) > 0 ? 'No pacote' : '—')
                                                            : (Number(item.probability) >= 100 ? '100% garantido' : `${item.probability}% chance`)}
                                                    </span>
                                                    <button onClick={() => removeBoxItem(idx)} className="text-red-500 hover:text-red-400"><Trash2 size={14} /></button>
                                                </div>
                                            </div>
                                        ))}
                                        {boxForm.items?.length === 0 && <div className="text-slate-500 text-xs italic text-center">Caixa vazia. Adicione itens abaixo.</div>}
                                    </div>

                                    <div className="bg-slate-900/50 p-3 rounded border border-dashed border-slate-600 grid grid-cols-12 gap-2 items-end">
                                        <div className="col-span-2">
                                            <label className="text-[10px] text-slate-500 font-bold block mb-1">Tipo</label>
                                            <select value={newItemForm.type} onChange={e => setNewItemForm({ ...newItemForm, type: e.target.value as any, id: '' })} className="w-full bg-slate-800 border border-slate-600 rounded p-1 text-white text-xs">
                                                <option value="item">Item</option>
                                                <option value="currency">Moeda</option>
                                                <option value="bundle">Pacote (Bundle)</option>
                                            </select>
                                        </div>
                                        <div className="col-span-4">
                                            <label className="text-[10px] text-slate-500 font-bold block mb-1">Item / Moeda</label>
                                            {newItemForm.type === 'item' ? (
                                                <select value={newItemForm.id} onChange={e => setNewItemForm({ ...newItemForm, id: e.target.value })} className="w-full bg-slate-800 border border-slate-600 rounded p-1 text-white text-xs">
                                                    <option value="">Selecione Item...</option>
                                                    {gameUpgrades.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                                                </select>
                                            ) : newItemForm.type === 'bundle' ? (
                                                <select value={newItemForm.id} onChange={e => setNewItemForm({ ...newItemForm, id: e.target.value })} className="w-full bg-slate-800 border border-slate-600 rounded p-1 text-white text-xs">
                                                    <option value="">Selecione Pacote...</option>
                                                    {adminBundles.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                                                </select>
                                            ) : (
                                                <select value={newItemForm.id} onChange={e => setNewItemForm({ ...newItemForm, id: e.target.value })} className="w-full bg-slate-800 border border-slate-600 rounded p-1 text-white text-xs">
                                                    <option value="">Selecione Moeda...</option>
                                                    <option value="usdc">USDC</option>
                                                </select>
                                            )}
                                        </div>
                                        <div className="col-span-2">
                                            <label className="text-[10px] text-slate-500 font-bold block mb-1">Qtd (Min/Max)</label>
                                            <div className="flex gap-1">
                                                <input type="number" min="1" step="1" value={Number.isFinite(newItemForm.minQty as number) ? newItemForm.minQty : 1} onChange={e => { const v = parseInt(e.target.value, 10); setNewItemForm({ ...newItemForm, minQty: Number.isFinite(v) ? v : 1 }); }} className="w-full bg-slate-800 border border-slate-600 rounded p-1 text-white text-xs" />
                                                <input type="number" min="1" step="1" value={Number.isFinite(newItemForm.maxQty as number) ? newItemForm.maxQty : 1} onChange={e => { const v = parseInt(e.target.value, 10); setNewItemForm({ ...newItemForm, maxQty: Number.isFinite(v) ? v : 1 }); }} className="w-full bg-slate-800 border border-slate-600 rounded p-1 text-white text-xs" />
                                            </div>
                                        </div>
                                        <div className="col-span-2">
                                            <label className="text-[10px] text-slate-500 font-bold block mb-1">
                                                {boxForm.trigger === 'registration' ? 'Ativo (> 0)' : '% Chance'}
                                            </label>
                                            <input type="number" min="1" max="100" step="any" value={Number.isFinite(newItemForm.probability as number) ? newItemForm.probability : 0} onChange={e => { const v = parseFloat(e.target.value); setNewItemForm({ ...newItemForm, probability: Number.isFinite(v) ? v : 0 }); }} className="w-full bg-slate-800 border border-slate-600 rounded p-1 text-white text-xs" />
                                        </div>
                                        <div className="col-span-2">
                                            <button onClick={handleAddBoxItem} className="w-full bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold py-1.5 rounded">ADD</button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* PROMO CODES */}
                            {(boxForm.trigger === 'promo_code' || boxForm.trigger === 'roleta_code') && (
                                <div className="border-t border-slate-700 pt-4 space-y-4">
                                    <h4 className="font-bold text-orange-400 flex items-center gap-2 uppercase text-xs tracking-widest">
                                        <Ticket size={16} /> Gerador de Códigos de Resgate
                                    </h4>
                                    <div className="bg-slate-900/50 p-4 rounded-xl border border-orange-500/20">
                                        <div className="flex flex-col md:flex-row gap-4 items-end mb-4">
                                            <div className="flex-1 w-full space-y-4">
                                                <div className="flex flex-wrap items-end gap-3">
                                                    <div className="min-w-[10rem]">
                                                        <label className="text-[10px] text-slate-500 font-bold block mb-1 uppercase">Válido após gerar</label>
                                                        <select
                                                            value={promoValidityDays}
                                                            onChange={(e) => setPromoValidityDays(e.target.value)}
                                                            className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                                                        >
                                                            <option value="">Sem expiração</option>
                                                            <option value="1">1 dia</option>
                                                            <option value="7">7 dias</option>
                                                            <option value="30">30 dias</option>
                                                            <option value="90">90 dias</option>
                                                            <option value="365">1 ano</option>
                                                        </select>
                                                    </div>
                                                </div>
                                                <div>
                                                    {/* Hidden complex state logic handled by the single dropdown below */}
                                                    <label className="text-[10px] text-slate-500 font-bold block mb-1 uppercase">Tipo de Código / Recompensa</label>
                                                    <select
                                                        value={
                                                            rewardType === 'bundle'
                                                                ? `bundle_${selectedBundleId}`
                                                                : rewardType === 'upgrade'
                                                                    ? 'item_select'
                                                                    : `box_${promoType}`
                                                        }
                                                        onChange={e => {
                                                            const val = e.target.value;
                                                            if (val === 'box_per_player') {
                                                                setRewardType('box');
                                                                setPromoType('per_player');
                                                                setSelectedBundleId('');
                                                            } else if (val === 'box_global_once') {
                                                                setRewardType('box');
                                                                setPromoType('global_once');
                                                                setSelectedBundleId('');
                                                            } else if (val === 'item_select') {
                                                                setRewardType('upgrade');
                                                                setPromoType('per_player');
                                                                setSelectedBundleId('');
                                                            } else if (val.startsWith('bundle_')) {
                                                                const bid = val.replace('bundle_', '');
                                                                setRewardType('bundle');
                                                                setPromoType('per_player');
                                                                setSelectedBundleId(bid);
                                                            } else if (val === 'roleta_player_1x') {
                                                                setRewardType('box');
                                                                setPromoType('roleta_player_1x');
                                                            } else if (val === 'roleta_global_1x') {
                                                                setRewardType('box');
                                                                setPromoType('roleta_global_1x');
                                                            }
                                                        }}
                                                        className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs focus:ring-1 focus:ring-orange-500 outline-none mb-2"
                                                    >
                                                        {boxForm.trigger === 'roleta_code' ? (
                                                            <>
                                                                <option value="roleta_player_1x">Roleta: Jogador pode usar 1x</option>
                                                                <option value="roleta_global_1x">Roleta: Primeiro que resgatar (Global 1x)</option>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <optgroup label="📦 Recompensa: Caixa">
                                                                    <option value="box_per_player">Caixa: {boxForm.name} (Multi-uso)</option>
                                                                    <option value="box_global_once">Caixa: {boxForm.name} (Global 1x)</option>
                                                                </optgroup>

                                                                <optgroup label="🎁 Recompensa: Item">
                                                                    <option value="item_select">Item Individual (Selecionar...)</option>
                                                                </optgroup>

                                                                {adminBundles.length > 0 && (
                                                                    <optgroup label="💎 Recompensa: Upgrades">
                                                                        {adminBundles.map(b => (
                                                                            <option key={b.id} value={`bundle_${b.id}`}>{b.name} (Multi-uso)</option>
                                                                        ))}
                                                                    </optgroup>
                                                                )}
                                                            </>
                                                        )}
                                                    </select>

                                                    {rewardType === 'upgrade' && (
                                                        <div className="mb-2 animate-in fade-in slide-in-from-top-1">
                                                            <label className="text-[10px] text-amber-400 font-bold block mb-1 uppercase">Selecione o Item Espcífico:</label>
                                                            <select
                                                                value={selectedUpgradeId}
                                                                onChange={e => setSelectedUpgradeId(e.target.value)}
                                                                className="w-full bg-slate-950 border border-amber-500/50 rounded p-2 text-white text-xs focus:ring-1 focus:ring-amber-500 outline-none"
                                                            >
                                                                <option value="">Selecione...</option>
                                                                {gameUpgrades.sort((a, b) => a.name.localeCompare(b.name)).map(u => (
                                                                    <option key={u.id} value={u.id}>{u.name} ({u.category})</option>
                                                                ))}
                                                            </select>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="flex flex-col gap-2 w-full md:w-auto shrink-0">
                                                <button
                                                    onClick={handleGenerateCode}
                                                    disabled={generatingCode || deletingAllCodes}
                                                    className={`w-full md:w-auto bg-orange-600 hover:bg-orange-500 text-white font-bold py-2 px-6 h-10 rounded text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 transition-all active:scale-95 shadow-lg shadow-orange-600/20 ${generatingCode || deletingAllCodes ? 'opacity-50 cursor-not-allowed' : ''}`}
                                                >
                                                    <Plus size={14} /> {generatingCode ? 'GERANDO...' : 'GERAR CÓDIGO'}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => void handleDeleteAllVisibleCodes()}
                                                    disabled={generatingCode || deletingAllCodes || boxCodes.length === 0}
                                                    className="w-full md:w-auto text-[10px] font-bold uppercase tracking-wide py-2 px-3 rounded border border-red-900/60 text-red-300 bg-red-950/30 hover:bg-red-900/40 disabled:opacity-40 disabled:cursor-not-allowed"
                                                >
                                                    {deletingAllCodes ? 'A apagar…' : `Apagar todos (${boxCodes.length})`}
                                                </button>
                                            </div>
                                        </div>

                                        <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar pr-2">
                                            {boxCodes.map(c => (
                                                <div key={c.code} className={`flex justify-between items-center bg-slate-950/50 p-3 rounded-lg border border-slate-800 hover:border-slate-700 transition-colors ${!c.isActive ? 'opacity-50 grayscale-[0.5]' : ''}`}>
                                                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                                                        <span className={`font-mono font-bold text-sm tracking-widest ${!c.isActive ? 'text-slate-500' : 'text-orange-400'}`}>{c.code}</span>
                                                        <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase ${c.type === 'per_player' ? 'bg-amber-900/40 text-amber-400 border border-amber-900/50' : 'bg-amber-900/40 text-amber-400 border border-amber-900/50'}`}>
                                                            {c.type === 'per_player'
                                                                ? 'Multi-uso'
                                                                : c.type === 'roleta_player_1x'
                                                                  ? 'Roleta 1x/jogador'
                                                                  : c.type === 'roleta_global_1x'
                                                                    ? 'Roleta global 1x'
                                                                    : c.type === 'global_once'
                                                                      ? 'Global 1x'
                                                                      : c.type || '—'}
                                                        </span>
                                                        <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase bg-slate-800 text-slate-300 border border-slate-700">
                                                            {c.adminUpgradeId ? (
                                                                <span className="text-amber-400">💎 Pacote: {adminBundles.find(b => b.id === c.adminUpgradeId)?.name || 'Pacote Desconhecido'}</span>
                                                            ) : c.upgradeId ? (
                                                                <span className="text-amber-400">🎁 Item: {gameUpgrades.find(u => u.id === c.upgradeId)?.name || 'Upgrade Desconhecido'}</span>
                                                            ) : (
                                                                <span>Box: {lootBoxes.find(b => b.id === c.lootBoxId)?.name || 'Caixa Desconhecida'}</span>
                                                            )}
                                                        </span>
                                                        <div className="flex items-center gap-1 text-[10px] text-slate-500 font-bold">
                                                            <Users size={12} className="text-slate-600" /> RESGATES: {(c as any).redemptionsCount || 0}
                                                        </div>
                                                        {c.expiresAt != null && c.expiresAt > 0 && (
                                                            <span className="text-[9px] font-bold text-rose-300/90 border border-rose-900/40 bg-rose-950/30 px-2 py-0.5 rounded">
                                                                Expira {new Date(c.expiresAt).toLocaleString('pt-BR')}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <button
                                                            onClick={() => handleToggleCode(c.code, !!c.isActive)}
                                                            className={`p-1.5 rounded transition-all ${c.isActive ? 'text-green-500 hover:bg-green-500/10' : 'text-slate-600 hover:bg-slate-500/10'}`}
                                                            title={c.isActive ? 'Desativar Código' : 'Ativar Código'}
                                                        >
                                                            {c.isActive ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                                                        </button>
                                                        <button
                                                            onClick={() => handleDeleteCode(c.code)}
                                                            className="p-1.5 text-slate-600 hover:text-red-500 hover:bg-red-500/10 rounded transition-all"
                                                            title="Excluir Código"
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                            {boxCodes.length === 0 && (
                                                <div className="text-center py-6 bg-slate-950/30 rounded-lg border border-dashed border-slate-800">
                                                    <p className="text-slate-600 italic text-xs">Nenhum código gerado para esta caixa.</p>
                                                    <p className="text-[9px] text-slate-800 font-mono mt-1 opacity-50">ID: {boxForm.id}</p>
                                                    <p className="text-[9px] text-orange-950 font-mono mt-0.5 opacity-30">Total: {(window as any)._lastBoxCodesTotal || 0} | Filtered: 0</p>
                                                </div>
                                            )}
                                        </div>
                                        <div className="mt-3 flex justify-end">
                                            <button onClick={() => loadBoxCodes(boxForm.id!)} className="text-[9px] text-slate-600 hover:text-slate-400 flex items-center gap-1 uppercase font-bold tracking-tighter transition-colors">
                                                <RefreshCw size={10} /> Atualizar Lista
                                            </button>
                                        </div>
                                    </div>
                                    <div className="bg-slate-900/50 p-4 rounded-xl border border-amber-500/20 mt-4">
                                        <h4 className="font-bold text-amber-400 flex items-center gap-2 uppercase text-xs tracking-widest mb-3">
                                            <Users size={16} /> Histórico de Resgates
                                        </h4>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div>
                                                <h5 className="text-[10px] uppercase font-bold text-slate-500 mb-2 border-b border-slate-700 pb-1">Códigos Multi-uso (Por Jogador)</h5>
                                                <div className="space-y-1 max-h-40 overflow-y-auto custom-scrollbar">
                                                    {redemptions.filter(r => r.type === 'per_player').map((r, i) => (
                                                        <div key={i} className="flex justify-between text-xs p-1.5 bg-slate-950/30 rounded border border-slate-800">
                                                            <div>
                                                                <div className="font-bold text-white">{r.username}</div>
                                                                <div className="text-[10px] text-slate-500 font-mono">{r.code}</div>
                                                            </div>
                                                            <div className="text-right text-[10px] text-slate-400">
                                                                {new Date(r.redeemedAt).toLocaleDateString()}
                                                                <div className="text-[9px]">{new Date(r.redeemedAt).toLocaleTimeString()}</div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                    {redemptions.filter(r => r.type === 'per_player').length === 0 && <div className="text-slate-600 italic text-[10px]">Nenhum resgate.</div>}
                                                </div>
                                            </div>
                                            <div>
                                                <h5 className="text-[10px] uppercase font-bold text-slate-500 mb-2 border-b border-slate-700 pb-1">Códigos Global 1x (Único)</h5>
                                                <div className="space-y-1 max-h-40 overflow-y-auto custom-scrollbar">
                                                    {redemptions.filter(r => r.type === 'global_once').map((r, i) => (
                                                        <div key={i} className="flex justify-between text-xs p-1.5 bg-slate-950/30 rounded border border-slate-800">
                                                            <div>
                                                                <div className="font-bold text-white">{r.username}</div>
                                                                <div className="text-[10px] text-slate-500 font-mono">{r.code}</div>
                                                            </div>
                                                            <div className="text-right text-[10px] text-slate-400">
                                                                {new Date(r.redeemedAt).toLocaleDateString()}
                                                                <div className="text-[9px]">{new Date(r.redeemedAt).toLocaleTimeString()}</div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                    {redemptions.filter(r => r.type === 'global_once').length === 0 && <div className="text-slate-600 italic text-[10px]">Nenhum resgate.</div>}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="mt-2 flex justify-end">
                                            <button onClick={() => boxForm.id && loadRedemptions(boxForm.id)} className="text-[9px] text-slate-600 hover:text-slate-400 flex items-center gap-1 uppercase font-bold tracking-tighter transition-colors">
                                                <RefreshCw size={10} /> Atualizar
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className="flex flex-col gap-2 pt-4">
                                <div className="flex gap-4">
                                    <button onClick={() => setEditBoxMode(false)} className="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded font-bold">CANCELAR</button>
                                    <button onClick={handleSaveBox} className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded font-bold flex-1">SALVAR CAIXA</button>
                                    {boxForm.id && (
                                        <button type="button" onClick={() => handleDeleteBox(boxForm.id!)} className="bg-red-900/50 hover:bg-red-800 text-red-400 border border-red-800 px-4 py-2 rounded shrink-0" title="Apagar na base de dados">
                                            <Trash2 size={16} />
                                        </button>
                                    )}
                                </div>
                                {boxForm.id && (
                                    <button
                                        type="button"
                                        onClick={() => handleDeleteBoxIfBroken(boxForm.id!)}
                                        className="self-end text-[10px] uppercase tracking-wide text-amber-600 hover:text-amber-400 border border-amber-900/40 rounded px-2 py-1"
                                    >
                                        Apagar só se inválida (sem itens / prob. 0)
                                    </button>
                                )}
                            </div>
                        </div>
                    ) : editBundleMode && selectedBundle ? (
                        <div className="space-y-6 animate-in fade-in slide-in-from-top-4">
                            <div className="flex justify-between items-center border-b border-slate-700 pb-2 mb-4">
                                <h3 className="text-xl font-bold text-amber-500 flex items-center gap-2">
                                    <Package size={24} /> {selectedBundle.name}
                                </h3>
                                <button onClick={() => { setEditBundleMode(false); setSelectedBundle(null); }} className="text-slate-500 hover:text-white transition-all hover:rotate-90"><X size={20} /></button>
                            </div>

                            <div className="bg-slate-900/50 p-4 rounded-xl border border-amber-500/20">
                                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">Conteúdo do Pacote</h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                                    <div className="space-y-1">
                                        <div className="text-slate-400 font-bold uppercase text-[10px]">Recompensas Diretas:</div>
                                        <div className="text-white">• {selectedBundle.grantUsdc || 0} USDC</div>
                                        {selectedBundle.grantAccessLevelId && <div className="text-amber-400">• Nível de Acesso: {selectedBundle.grantAccessLevelId}</div>}
                                    </div>
                                    <div className="space-y-1">
                                        <div className="text-slate-400 font-bold uppercase text-[10px]">Itens e Moedas:</div>
                                        {selectedBundle.items?.map(it => <div key={it.itemId} className="text-white">• {it.qty}x {it.itemId}</div>)}
                                        {selectedBundle.coins?.map(c => <div key={c.coinId} className="text-white">• {c.amount} {c.coinId}</div>)}
                                        {selectedBundle.boxes?.map(b => <div key={b.boxId} className="text-white">• {b.qty}x Caixa {b.boxId}</div>)}
                                    </div>
                                </div>
                            </div>

                            <div className="border-t border-slate-700 pt-4 space-y-4">
                                <h4 className="font-bold text-orange-400 flex items-center gap-2 uppercase text-xs tracking-widest">
                                    <Ticket size={16} /> Gerador de Códigos de Resgate
                                </h4>
                                <div className="bg-slate-900/50 p-4 rounded-xl border border-orange-500/20">
                                    <div className="flex flex-col md:flex-row gap-4 items-end mb-4">
                                        <div className="flex-1 w-full space-y-4">
                                            <div className="min-w-[10rem] max-w-xs">
                                                <label className="text-[10px] text-slate-500 font-bold block mb-1 uppercase">Válido após gerar</label>
                                                <select
                                                    value={promoValidityDays}
                                                    onChange={(e) => setPromoValidityDays(e.target.value)}
                                                    className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                                                >
                                                    <option value="">Sem expiração</option>
                                                    <option value="1">1 dia</option>
                                                    <option value="7">7 dias</option>
                                                    <option value="30">30 dias</option>
                                                    <option value="90">90 dias</option>
                                                    <option value="365">1 ano</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label className="text-[10px] text-slate-500 font-bold block mb-1 uppercase">Tipo de Código</label>
                                                <select
                                                    value={promoType}
                                                    onChange={e => setPromoType(e.target.value as any)}
                                                    className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs focus:ring-1 focus:ring-orange-500 outline-none"
                                                >
                                                    <option value="per_player">Cada Jogador pode usar 1x (Multi-uso)</option>
                                                    <option value="global_once">Apenas a Primeira Pessoa que resgatar (Global 1x)</option>
                                                </select>
                                            </div>
                                        </div>
                                        <div className="flex flex-col gap-2 w-full lg:w-auto shrink-0">
                                            <button
                                                onClick={handleGenerateCode}
                                                disabled={generatingCode || deletingAllCodes}
                                                className={`w-full lg:w-auto bg-orange-600 hover:bg-orange-500 text-white font-bold py-2 px-6 h-10 rounded text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 transition-all active:scale-95 shadow-lg shadow-orange-600/20 ${generatingCode || deletingAllCodes ? 'opacity-50 cursor-not-allowed' : ''}`}
                                            >
                                                <Plus size={14} /> GERAR CÓDIGO
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void handleDeleteAllVisibleCodes()}
                                                disabled={generatingCode || deletingAllCodes || boxCodes.length === 0}
                                                className="w-full lg:w-auto text-[10px] font-bold uppercase tracking-wide py-2 px-3 rounded border border-red-900/60 text-red-300 bg-red-950/30 hover:bg-red-900/40 disabled:opacity-40 disabled:cursor-not-allowed"
                                            >
                                                {deletingAllCodes ? 'A apagar…' : `Apagar todos (${boxCodes.length})`}
                                            </button>
                                        </div>
                                    </div>

                                    <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar pr-2">
                                        {boxCodes.map(c => (
                                            <div key={c.code} className={`flex justify-between items-center bg-slate-950/50 p-3 rounded-lg border border-slate-800 hover:border-slate-700 transition-colors ${!c.isActive ? 'opacity-50 grayscale-[0.5]' : ''}`}>
                                                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                                                    <span className={`font-mono font-bold text-sm tracking-widest ${!c.isActive ? 'text-slate-500' : 'text-orange-400'}`}>{c.code}</span>
                                                    <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase ${c.type === 'per_player' ? 'bg-amber-900/40 text-amber-400 border border-amber-900/50' : 'bg-amber-900/40 text-amber-400 border border-amber-900/50'}`}>
                                                        {c.type === 'per_player' ? 'Multi-uso' : 'Global 1x'}
                                                    </span>
                                                    <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase bg-slate-800 text-slate-300 border border-slate-700">
                                                        {(c.adminUpgradeId || (c as any).admin_upgrade_id) ? (
                                                            <span className="text-amber-400">💎 Pacote: {adminBundles.find(b => b.id === (c.adminUpgradeId || (c as any).admin_upgrade_id))?.name || 'Pacote Desconhecido'}</span>
                                                        ) : (c.upgradeId || (c as any).upgrade_id) ? (
                                                            <span className="text-amber-400">🎁 Item: {gameUpgrades.find(u => u.id === (c.upgradeId || (c as any).upgrade_id))?.name || 'Upgrade Desconhecido'}</span>
                                                        ) : (
                                                            <span>Box: {lootBoxes.find(b => b.id === (c.lootBoxId || (c as any).loot_box_id))?.name || 'Caixa Desconhecida'}</span>
                                                        )}
                                                    </span>
                                                    <div className="flex items-center gap-1 text-[10px] text-slate-500 font-bold">
                                                        <Users size={12} className="text-slate-600" /> RESGATES: {(c as any).redemptionsCount || 0}
                                                    </div>
                                                    {c.expiresAt != null && c.expiresAt > 0 && (
                                                        <span className="text-[9px] font-bold text-rose-300/90 border border-rose-900/40 bg-rose-950/30 px-2 py-0.5 rounded">
                                                            Expira {new Date(c.expiresAt).toLocaleString('pt-BR')}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => handleToggleCode(c.code, !!c.isActive)}
                                                        className={`p-1.5 rounded transition-all ${c.isActive ? 'text-green-500 hover:bg-green-500/10' : 'text-slate-600 hover:bg-slate-500/10'}`}
                                                        title={c.isActive ? 'Desativar Código' : 'Ativar Código'}
                                                    >
                                                        {c.isActive ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeleteCode(c.code)}
                                                        className="p-1.5 text-slate-600 hover:text-red-500 hover:bg-red-500/10 rounded transition-all"
                                                        title="Excluir Código"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                        {boxCodes.length === 0 && (
                                            <div className="text-center py-6 bg-slate-950/30 rounded-lg border border-dashed border-slate-800 text-[10px] text-slate-600 font-bold uppercase">Nenhum código gerado</div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-4">
                            <Gift size={64} className="opacity-20" />
                            <p>Selecione uma caixa para editar ou um pacote para gerar códigos.</p>
                        </div>
                    )}
                </div>
            </div>
        </div >
    );
};
