// @ts-nocheck — template legado 1:1.
import React, { useState, useEffect } from 'react';
import { SeasonPass, SeasonPassReward, Upgrade, MiningCoin } from '../lib/adminTypes';
import { PlusCircle, X, Trash2, Save, Gift, Coins, AlertCircle, Users } from 'lucide-react';
import { getAdminUpgrades, getUpgrades } from '../../../shared/api/admin-legacy';
import { getMiningCoins } from '../../../shared/api/admin-economy';
import { saveSeasonPassPreservingCatalog } from '../lib/seasonPassCatalog';
import { apiFetch } from '../../../shared/api/http';

interface AdminSeasonPassesProps {
    seasonPasses: SeasonPass[];
    onUpdatePasses: () => void;
}

export const AdminSeasonPasses: React.FC<AdminSeasonPassesProps> = ({ seasonPasses, onUpdatePasses }) => {
    const [editMode, setEditMode] = useState<boolean>(false);
    const [passForm, setPassForm] = useState<Partial<SeasonPass>>({
        id: '', seasonId: '', name: '', description: '', priceUsdc: 0, emblemUrl: '', rewards: []
    });

    const handleRevoke = async (passId: string, userId: string) => {
        if (!confirm('Deseja realmente remover o passe deste jogador? Ele poderá comprar novamente.')) return;

        try {
            const res = await apiFetch(`/api/season-passes/${passId}/purchases/${userId}`, { method: 'DELETE' });
            if (res.ok) {
                setBuyers(buyers.filter(b => b.userId !== userId));
            } else {
                alert('Erro ao remover passe.');
            }
        } catch (e) {
            console.error(e);
            alert('Erro de conexão.');
        }
    };

    // Buyers View
    const [viewBuyers, setViewBuyers] = useState<string | null>(null);
    const [buyers, setBuyers] = useState<Array<{ username: string, email: string, purchasedAt: number, userId: string }>>([]);
    const [loadingBuyers, setLoadingBuyers] = useState(false);

    // Data constraints
    const [gameItems, setGameItems] = useState<Upgrade[]>([]);
    const [miningCoins, setMiningCoins] = useState<MiningCoin[]>([]);

    // New Reward Form
    const [newReward, setNewReward] = useState<{ type: 'item' | 'currency', itemId: string, coinId: string, qty: number }>({
        type: 'item', itemId: '', coinId: 'usdc', qty: 1
    });

    useEffect(() => {
        const loadData = async () => {
            const items = await getUpgrades();
            setGameItems(items || []);
            const coins = await getMiningCoins();
            setMiningCoins(coins || []);
        };
        loadData();
    }, []);

    const handleNewPass = () => {
        setPassForm({
            id: crypto.randomUUID(),
            seasonId: '',
            name: 'Novo Passe',
            description: '',
            priceUsdc: 10,
            emblemUrl: '',
            isActive: true,
            rewards: []
        });
        setEditMode(true);
    };

    const handleEditPass = (pass: SeasonPass) => {
        setPassForm(JSON.parse(JSON.stringify(pass))); // Deep copy
        setEditMode(true);
    };

    const handleSavePass = async () => {
        if (!passForm.seasonId || !passForm.name) {
            alert('Preencha ID da Temporada e Nome.');
            return;
        }
        if (!passForm.id) {
            alert('Passe sem id — recarregue e tente de novo.');
            return;
        }

        const toSave: SeasonPass = {
            id: String(passForm.id),
            seasonId: String(passForm.seasonId),
            name: String(passForm.name),
            description: String(passForm.description || ''),
            priceUsdc: Number(passForm.priceUsdc) || 0,
            emblemUrl: String(passForm.emblemUrl || ''),
            isActive: passForm.isActive !== false,
            rewards: passForm.rewards || []
        };

        try {
            const res = await saveSeasonPassPreservingCatalog(toSave);
            if (res.ok) {
                onUpdatePasses();
                setEditMode(false);
            } else {
                alert(res.error || 'Erro ao salvar passe.');
            }
        } catch (e) {
            console.error(e);
            alert('Erro de conexão.');
        }
    };

    const handleDeletePass = async () => {
        if (!confirm('Tem certeza? Isso pode afetar compras existentes se não forem tratadas corretamente pelo backend.')) return;
        setPassForm(p => ({ ...p, isActive: false }));
        alert('Para "excluir", definiremos como inativo ao salvar.');
    };

    const handleAddReward = () => {
        if (newReward.type === 'item' && !newReward.itemId) return alert('Selecione um item');
        if (newReward.type === 'currency' && !newReward.coinId) return alert('Selecione uma moeda');
        if (newReward.qty <= 0) return alert('Quantidade inválida');

        const currentRewards = [...(passForm.rewards || [])];
        currentRewards.push({
            id: Date.now(),
            type: newReward.type,
            itemId: newReward.type === 'item' ? newReward.itemId : undefined,
            coinId: newReward.type === 'currency' ? newReward.coinId : undefined,
            qty: newReward.qty
        });
        setPassForm({ ...passForm, rewards: currentRewards });
        setNewReward({ type: 'item', itemId: '', coinId: 'usdc', qty: 1 });
    };

    const removeReward = (index: number) => {
        const currentRewards = [...(passForm.rewards || [])];
        currentRewards.splice(index, 1);
        setPassForm({ ...passForm, rewards: currentRewards });
    };

    const handleViewBuyers = async (passId: string) => {
        setViewBuyers(passId);
        setLoadingBuyers(true);
        setBuyers([]);
        try {
            const res = await apiFetch(`/api/season-passes/${passId}/purchases`);
            if (res.ok) {
                const data = await res.json();
                setBuyers(data);
            } else {
                alert('Erro ao carregar compradores');
            }
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingBuyers(false);
        }
    };

    return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in slide-in-from-right-4 relative">
            {/* BUYERS MODAL OVERLAY */}
            {viewBuyers && (
                <div className="absolute inset-0 z-50 bg-slate-900/90 backdrop-blur flex items-center justify-center p-4 rounded-xl">
                    <div className="bg-slate-800 border border-slate-600 rounded-xl w-full max-w-lg h-[80vh] flex flex-col shadow-2xl">
                        <div className="flex justify-between items-center p-4 border-b border-slate-700">
                            <h3 className="font-bold text-white flex items-center gap-2">
                                <Users size={18} className="text-amber-400" />
                                Compradores do Passe
                            </h3>
                            <button onClick={() => setViewBuyers(null)} className="text-slate-400 hover:text-white bg-slate-700/50 p-1 rounded-full"><X size={20} /></button>
                        </div>
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
                            {loadingBuyers ? (
                                <div className="text-center py-10 text-slate-500 animate-pulse">Carregando lista...</div>
                            ) : (
                                <div className="space-y-1">
                                    {buyers.map((b, i) => (
                                        <div key={i} className="flex justify-between items-center bg-slate-900/50 p-3 rounded border border-slate-700/50 hover:border-slate-600">
                                            <div>
                                                <div className="font-bold text-white text-sm">{b.username}</div>
                                                <div className="text-[10px] text-slate-500">{b.email}</div>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <div className="text-[10px] text-slate-400 font-mono text-right">
                                                    {new Date(b.purchasedAt).toLocaleDateString()}<br />
                                                    {new Date(b.purchasedAt).toLocaleTimeString()}
                                                </div>
                                                <button
                                                    onClick={() => handleRevoke(viewBuyers, b.userId)}
                                                    className="text-red-500 hover:text-red-400 p-2 rounded hover:bg-red-900/20"
                                                    title="Remover Passe (Revogar)"
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                    {buyers.length === 0 && (
                                        <div className="text-center py-10 text-slate-500 text-sm">
                                            Nenhum comprador encontrado para este passe.
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="p-3 border-t border-slate-700 bg-slate-800/50 rounded-b-xl text-xs text-center text-slate-500">
                            Total: {buyers.length} vendas
                        </div>
                    </div>
                </div>
            )}

            {/* LIST */}
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 h-[70vh] flex flex-col">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-white">Passes de Temporada</h3>
                    <button onClick={handleNewPass} className="bg-green-600 hover:bg-green-500 text-white text-xs px-2 py-1 rounded flex items-center gap-1">
                        <PlusCircle size={12} /> NOVO
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2">
                    {seasonPasses.map(pass => (
                        <div key={pass.id}
                            className={`p-3 rounded border flex flex-col gap-2 transition-all ${editMode && passForm.id === pass.id ? 'bg-slate-700 border-yellow-500 ring-1 ring-yellow-500' : 'bg-slate-900 border-slate-700 hover:border-slate-500'}`}>

                            <div className="flex justify-between items-start cursor-pointer" onClick={() => handleEditPass(pass)}>
                                <div>
                                    <div className="font-bold text-white flex items-center gap-2">
                                        {pass.name}
                                        {!pass.isActive && <span className="text-[9px] bg-red-900/50 text-red-400 px-1 rounded border border-red-800">INATIVO</span>}
                                    </div>
                                    <div className="text-[10px] text-slate-500 mt-1 font-mono">
                                        ID: {pass.seasonId}
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="text-xs text-green-400 font-bold">${pass.priceUsdc}</div>
                                    <div className="text-[9px] text-slate-400">{(pass.rewards || []).length} Recompensas</div>
                                </div>
                            </div>

                            <button
                                onClick={(e) => { e.stopPropagation(); handleViewBuyers(pass.id); }}
                                className="w-full bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-300 text-[10px] py-1 rounded flex items-center justify-center gap-1 transition-colors"
                            >
                                <Users size={12} /> Ver Compradores
                            </button>
                        </div>
                    ))}
                    {seasonPasses.length === 0 && <div className="text-slate-500 text-center text-xs py-10">Nenhum passe encontrado.</div>}
                </div>
            </div>

            {/* EDITOR */}
            <div className="lg:col-span-2 bg-slate-800 border border-slate-700 rounded-xl p-6 h-[70vh] overflow-y-auto custom-scrollbar">
                {editMode ? (
                    <div className="space-y-6">
                        <div className="flex justify-between items-center border-b border-slate-700 pb-2 mb-4">
                            <h3 className="text-xl font-bold text-white">
                                {passForm.id ? `Editando: ${passForm.name}` : 'Novo Passe'}
                            </h3>
                            <button onClick={() => setEditMode(false)} className="text-slate-500 hover:text-white"><X size={20} /></button>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-xs font-bold text-slate-500 block mb-1">Nome do Passe</label>
                                <input type="text" value={passForm.name} onChange={e => setPassForm({ ...passForm, name: e.target.value })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-slate-500 block mb-1">ID da Temporada (ex: genesis_dao)</label>
                                <input type="text" value={passForm.seasonId} onChange={e => setPassForm({ ...passForm, seasonId: e.target.value })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm font-mono" />
                            </div>
                            <div className="col-span-2">
                                <label className="text-xs font-bold text-slate-500 block mb-1">Descrição</label>
                                <input type="text" value={passForm.description} onChange={e => setPassForm({ ...passForm, description: e.target.value })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-slate-500 block mb-1">Preço (USDC)</label>
                                <input type="number" value={passForm.priceUsdc} onChange={e => setPassForm({ ...passForm, priceUsdc: parseFloat(e.target.value) })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-slate-500 block mb-1">URL Emblema (Opcional)</label>
                                <input type="text" value={passForm.emblemUrl} onChange={e => setPassForm({ ...passForm, emblemUrl: e.target.value })} className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm" />
                            </div>
                            <div className="flex items-end pb-2">
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="checkbox" checked={passForm.isActive} onChange={e => setPassForm({ ...passForm, isActive: e.target.checked })} className="scale-125 accent-green-600" />
                                    <span className="text-sm font-bold text-white">Ativo (Visível na loja)</span>
                                </label>
                            </div>
                        </div>

                        {/* REWARDS SECTION */}
                        <div className="border-t border-slate-700 pt-4 mt-4">
                            <h4 className="font-bold text-yellow-500 flex items-center gap-2 mb-3">
                                <Gift size={16} /> Recompensas Diretas (Itens/Moedas)
                            </h4>

                            <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-600 mb-4">
                                <div className="grid grid-cols-12 gap-2 items-end">
                                    <div className="col-span-3">
                                        <label className="text-[10px] uppercase font-bold text-slate-500 block mb-1">Tipo</label>
                                        <select
                                            value={newReward.type}
                                            onChange={e => setNewReward({ ...newReward, type: e.target.value as any })}
                                            className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                                        >
                                            <option value="item">Item (Inventário)</option>
                                            <option value="currency">Moeda (Saldo)</option>
                                        </select>
                                    </div>
                                    <div className="col-span-5">
                                        <label className="text-[10px] uppercase font-bold text-slate-500 block mb-1">Objeto</label>
                                        {newReward.type === 'item' ? (
                                            <select
                                                value={newReward.itemId}
                                                onChange={e => setNewReward({ ...newReward, itemId: e.target.value })}
                                                className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                                            >
                                                <option value="">Selecione um Item...</option>
                                                {gameItems.sort((a, b) => a.name.localeCompare(b.name)).map(i => (
                                                    <option key={i.id} value={i.id}>{i.name} ({i.category})</option>
                                                ))}
                                            </select>
                                        ) : (
                                            <select
                                                value={newReward.coinId}
                                                onChange={e => setNewReward({ ...newReward, coinId: e.target.value })}
                                                className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                                            >
                                                <option value="usdc">USDC (Dólar)</option>
                                                {miningCoins.map(c => (
                                                    <option key={c.id} value={c.id}>{c.name} ({c.symbol})</option>
                                                ))}
                                            </select>
                                        )}
                                    </div>
                                    <div className="col-span-2">
                                        <label className="text-[10px] uppercase font-bold text-slate-500 block mb-1">Quantidade</label>
                                        <input
                                            type="number"
                                            value={newReward.qty}
                                            onChange={e => setNewReward({ ...newReward, qty: parseFloat(e.target.value) })}
                                            className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs"
                                        />
                                    </div>
                                    <div className="col-span-2">
                                        <button onClick={handleAddReward} className="w-full bg-amber-600 hover:bg-amber-500 text-white font-bold py-2 rounded text-xs">ADD</button>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-2">
                                {passForm.rewards?.map((r, i) => (
                                    <div key={i} className="flex justify-between items-center bg-slate-900 border border-slate-700 p-3 rounded">
                                        <div className="flex items-center gap-3">
                                            <div className="bg-slate-800 p-2 rounded text-slate-300">
                                                {r.type === 'item' ? <Gift size={16} /> : <Coins size={16} />}
                                            </div>
                                            <div>
                                                <div className="font-bold text-white text-sm">
                                                    {r.type === 'item'
                                                        ? (gameItems.find(it => it.id === r.itemId)?.name || r.itemId)
                                                        : (r.coinId === 'usdc' ? 'USDC' : miningCoins.find(c => c.id === r.coinId)?.name || r.coinId)
                                                    }
                                                </div>
                                                <div className="text-[10px] text-slate-500 uppercase font-bold">{r.type === 'item' ? 'Item' : 'Moeda'} • Qtd: {r.qty}</div>
                                            </div>
                                        </div>
                                        <button onClick={() => removeReward(i)} className="text-red-500 hover:text-red-400 p-2"><Trash2 size={16} /></button>
                                    </div>
                                ))}
                                {(passForm.rewards?.length || 0) === 0 && (
                                    <div className="text-center py-6 border border-dashed border-slate-700 rounded text-slate-500 text-xs">
                                        Nenhuma recompensa configurada. O jogador receberá apenas acesso à temporada.
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="flex gap-4 pt-6 border-t border-slate-700">
                            <button onClick={() => setEditMode(false)} className="bg-slate-700 hover:bg-slate-600 text-white px-6 py-2 rounded font-bold">VOLTAR</button>
                            <button onClick={handleSavePass} className="bg-green-600 hover:bg-green-500 text-white px-6 py-2 rounded font-bold flex-1 flex items-center justify-center gap-2">
                                <Save size={18} /> SALVAR ALTERAÇÕES
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-4">
                        <Gift size={64} className="opacity-20" />
                        <p>Selecione um passe para editar ou crie um novo para definir recompensas.</p>
                    </div>
                )}
            </div>
        </div>
    );
};
