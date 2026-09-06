// @ts-nocheck — template legado 1:1.
import React, { useState, useEffect, useCallback } from 'react';
import { AdminMarketListing, EconomySettings, Upgrade } from '../lib/adminTypes';
import { getAdminMarketListings, getEconomySettings, setEconomySettings as saveEconomySettings } from '../../../shared/api/admin-legacy';
import { subscribeMarketLive } from '../../black-market/lib/marketLiveSocket';
import { Search, Save, AlertCircle, RefreshCw } from 'lucide-react';

interface AdminBlackMarketProps {
    gameUpgrades?: Upgrade[];
}

export const AdminBlackMarket: React.FC<AdminBlackMarketProps> = ({ gameUpgrades = [] }) => {
    const [listings, setListings] = useState<AdminMarketListing[]>([]);
    const [settings, setSettings] = useState<EconomySettings | null>(null);
    const [loading, setLoading] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [newTax, setNewTax] = useState<string>('');

    const loadData = useCallback(async () => {
        setLoading(true);
        const [l, s] = await Promise.all([
            getAdminMarketListings(),
            getEconomySettings()
        ]);
        setListings(l);
        setSettings(s);
        setNewTax((s?.marketTaxPercent || 0).toString());
        setLoading(false);
    }, []);

    useEffect(() => {
        void loadData();
    }, [loadData]);

    useEffect(() => {
        let reloadTimer: number | null = null;
        const scheduleReload = () => {
            if (reloadTimer !== null) window.clearTimeout(reloadTimer);
            reloadTimer = window.setTimeout(() => {
                reloadTimer = null;
                void loadData();
            }, 500);
        };
        const unsub = subscribeMarketLive({
            onEvent: () => { scheduleReload(); },
            onConnected: () => { void loadData(); }
        });
        return () => {
            if (reloadTimer !== null) window.clearTimeout(reloadTimer);
            unsub();
        };
    }, [loadData]);

    const handleSaveTax = async () => {
        if (!settings) return;
        const tax = parseFloat(newTax);
        if (isNaN(tax) || tax < 0 || tax > 100) {
            alert("A taxa deve ser entre 0 e 100%");
            return;
        }
        await saveEconomySettings({ ...settings, marketTaxPercent: tax });
        alert("Taxa atualizada com sucesso!");
        loadData();
    };

    const getItemName = (id: string) => {
        const u = gameUpgrades.find(x => x.id === id);
        return u ? u.name : id;
    };

    const formatMoney = (val: number) => val.toLocaleString('pt-BR', { style: 'currency', currency: 'USD' });
    /** Coluna expires_at: anúncios novos usam sentinel; awaiting_pickup não “expira” por este campo. */
    const formatExpiresCell = (l: AdminMarketListing) => {
        if (l.status === 'awaiting_pickup') return '— (cofre)';
        const n = typeof l.expiresAt === 'string' ? Number(l.expiresAt) : Number(l.expiresAt);
        if (!Number.isFinite(n) || n <= 0) return '—';
        if (n >= Number.MAX_SAFE_INTEGER) return 'Sem expiração';
        const d = new Date(n);
        return Number.isFinite(d.getTime()) ? d.toLocaleString('pt-BR') : '—';
    };

    const filtered = listings.filter(l =>
        l.sellerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        getItemName(l.itemId).toLowerCase().includes(searchTerm.toLowerCase())
    );

    // Calculate Totals
    const activeListings = listings.filter(l => l.status === 'active');
    const totalVolume = activeListings.reduce((acc, curr) => acc + (curr.price * curr.qty), 0);
    const taxPercent = settings?.marketTaxPercent || 0;
    const projectedTax = totalVolume * (taxPercent / 100);

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* Header / Configurações */}
            <div className="bg-slate-800 rounded-lg p-6 border border-slate-700 shadow-xl flex flex-col md:flex-row gap-6 items-start md:items-center justify-between">
                <div>
                    <h2 className="text-2xl font-bold text-white mb-2">Gestão P2P (Mercado Negro)</h2>
                    <p className="text-slate-400 text-sm mb-4">Monitore todas as listagens e defina a taxa global de vendas.</p>

                    <div className="flex items-center gap-6">
                        <div className="bg-slate-900/50 px-4 py-2 rounded border border-slate-700">
                            <div className="text-[10px] uppercase text-slate-500 font-bold">Vendas Ativas (Volume)</div>
                            <div className="text-xl font-mono text-amber-400">{formatMoney(totalVolume)}</div>
                        </div>
                        <div className="bg-slate-900/50 px-4 py-2 rounded border border-slate-700">
                            <div className="text-[10px] uppercase text-slate-500 font-bold">Arrecadação Estimada</div>
                            <div className="text-xl font-mono text-green-400">{formatMoney(projectedTax)}</div>
                        </div>
                    </div>
                </div>

                <div className="bg-slate-900 p-4 rounded-lg border border-slate-700 flex items-center gap-4">
                    <div className="flex flex-col">
                        <label className="text-xs text-slate-500 font-bold uppercase mb-1">Taxa de Mercado (%)</label>
                        <div className="flex items-center gap-2">
                            <input
                                type="number"
                                value={newTax}
                                onChange={e => setNewTax(e.target.value)}
                                className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white font-mono w-24 focus:border-red-500 outline-none"
                            />
                            <span className="text-slate-400">%</span>
                        </div>
                    </div>
                    <button
                        onClick={handleSaveTax}
                        className="bg-red-600 hover:bg-red-500 text-white p-2 rounded transition-colors"
                        title="Salvar Taxa"
                    >
                        <Save size={20} />
                    </button>
                </div>
            </div>

            {/* Filtros e Busca */}
            <div className="flex items-center gap-4 mb-4">
                <div className="relative flex-1 max-w-md">
                    <Search className="absolute left-3 top-2.5 text-slate-500" size={18} />
                    <input
                        type="text"
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        placeholder="Buscar por vendedor ou item..."
                        className="w-full bg-slate-800 border border-slate-700 text-white pl-10 pr-4 py-2 rounded focus:border-red-500 outline-none"
                    />
                </div>
                <button onClick={loadData} className="bg-slate-800 hover:bg-slate-700 text-white p-2 rounded border border-slate-700">
                    <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                </button>
            </div>

            {/* Tabela de Listagens */}
            <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-slate-900/50 text-slate-400 text-xs font-bold uppercase">
                            <th className="p-4 border-b border-slate-700">Item</th>
                            <th className="p-4 border-b border-slate-700">Vendedor</th>
                            <th className="p-4 border-b border-slate-700 text-right">Qtd</th>
                            <th className="p-4 border-b border-slate-700 text-right">Total</th>
                            <th className="p-4 border-b border-slate-700 text-center">Status</th>
                            <th className="p-4 border-b border-slate-700">Expira em</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                        {filtered.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="p-8 text-center text-slate-500">
                                    <AlertCircle className="mx-auto mb-2 opacity-50" size={32} />
                                    Nenhuma oferta encontrada.
                                </td>
                            </tr>
                        ) : (
                            filtered.map(l => (
                                <tr key={l.id} className="hover:bg-slate-700/30 transition-colors">
                                    <td className="p-4">
                                        <div className="font-bold text-white">{getItemName(l.itemId)}</div>
                                        <div className="text-xs text-slate-500 font-mono">{l.itemId}</div>
                                    </td>
                                    <td className="p-4">
                                        <div className="text-amber-400">{l.sellerName}</div>
                                        <div className="text-xs text-slate-600 font-mono">ID: {l.sellerId}</div>
                                    </td>
                                    <td className="p-4 text-right font-mono text-slate-300">
                                        {l.qty}
                                    </td>
                                    <td className="p-4 text-right font-mono font-bold text-green-400">
                                        {formatMoney((l.lineTotal != null ? l.lineTotal : l.price * l.qty) as number)}
                                        {l.qty > 1 && (
                                            <div className="text-[10px] font-normal text-slate-500">{formatMoney(l.price)}/un.</div>
                                        )}
                                    </td>
                                    <td className="p-4 text-center">
                                        <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${l.status === 'active' ? 'bg-green-900/30 text-green-400 border border-green-900' :
                                            l.status === 'awaiting_pickup' ? 'bg-blue-900/30 text-blue-300 border border-blue-900' :
                                            l.status === 'sold' ? 'bg-amber-900/30 text-amber-400 border border-amber-900' :
                                                'bg-slate-900 text-slate-500 border border-slate-700'
                                            }`}>
                                            {l.status === 'active' ? 'Ativo' : l.status === 'awaiting_pickup' ? 'Aguarda retirada' : l.status === 'sold' ? 'Vendido' : l.status}
                                        </span>
                                    </td>
                                    <td className="p-4 text-xs text-slate-500">
                                        {formatExpiresCell(l)}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            <div className="text-right text-xs text-slate-600 mt-2">
                Mostrando {filtered.length} de {listings.length} ofertas
            </div>
        </div>
    );
};
