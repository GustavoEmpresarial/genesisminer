// @ts-nocheck — template legado 1:1.
import React, { useState, useEffect } from 'react';
import { WheelItem, Upgrade } from '../lib/adminTypes';
import ConfigView from './roleta/ConfigView';
import { Gamepad2 } from 'lucide-react';
import { PRESET_COLORS } from '../lib/constants';
import { apiFetch } from '../../../shared/api/http';

interface AdminGamesProps {
    gameUpgrades: Upgrade[];
}

export const AdminGames: React.FC<AdminGamesProps> = ({ gameUpgrades }) => {
    const [activeGame, setActiveGame] = useState<'roleta'>('roleta');
    const [loading, setLoading] = useState(false);

    // State for Roleta
    const [wheelItems, setWheelItems] = useState<WheelItem[]>([]);
    const [paidWheelEnabled, setPaidWheelEnabled] = useState(true);
    const [paidSpinPriceUsdc, setPaidSpinPriceUsdc] = useState(1);

    useEffect(() => {
        if (activeGame === 'roleta') {
            fetchRoletaConfig();
        }
    }, [activeGame]);

    const fetchRoletaConfig = async () => {
        setLoading(true);
        try {
            const [resItems, resRt] = await Promise.all([
                apiFetch('/api/admin/wheel/config'),
                apiFetch('/api/admin/wheel/runtime-config')
            ]);
            if (resItems.ok) {
                const data = await resItems.json();
                setWheelItems(data.map((d: Record<string, unknown>) => ({
                    id: String(d.id),
                    label: String(d.label),
                    weight: Number(d.weight),
                    color: String(d.color),
                    itemId: typeof d.itemId === 'string' ? d.itemId : typeof d.item_id === 'string' ? d.item_id : undefined,
                    isActive: d.isActive != null ? Number(d.isActive) : 1,
                    tier: typeof d.tier === 'string' ? d.tier : 'BASIC'
                })));
            }
            if (resRt.ok) {
                const rt = (await resRt.json()) as Record<string, unknown>;
                setPaidWheelEnabled(rt.isEnabled !== false && rt.isEnabled !== 0);
                const p = rt.spinPriceUsdc;
                const n = typeof p === 'number' ? p : Number(p);
                setPaidSpinPriceUsdc(Number.isFinite(n) && n >= 0.1 ? n : 1);
            }
        } catch (error) {
            console.error('Failed to fetch config:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSaveRoleta = async () => {
        setLoading(true);
        try {
            const payload = wheelItems.map(item => ({
                id: item.id,
                label: item.label,
                weight: item.weight,
                color: item.color,
                itemId: item.itemId,
                isActive: item.isActive ?? 1,
                tier: item.tier ?? 'BASIC'
            }));

            const res = await apiFetch('/api/admin/wheel/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                alert('Erro ao salvar configuração.');
                return;
            }

            const rtRes = await apiFetch('/api/admin/wheel/runtime-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    spinPriceUsdc: paidSpinPriceUsdc,
                    minSpinPriceUsdc: paidSpinPriceUsdc,
                    isEnabled: paidWheelEnabled
                })
            });
            if (!rtRes.ok) {
                alert('Prémios salvos, mas falhou ao guardar o preço ou o estado da roleta paga.');
                return;
            }
            alert('Configuração salva com sucesso!');
        } catch (error) {
            console.error('Error saving config:', error);
            alert('Erro de conexão.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-3">
                <div className="bg-amber-500/10 p-3 rounded-xl border border-amber-500/20">
                    <Gamepad2 size={32} className="text-amber-500" />
                </div>
                <div>
                    <h2 className="text-3xl font-black text-white">Central de Jogos</h2>
                    <p className="text-slate-400">Configure e gerencie os minigames do sistema</p>
                </div>
            </div>

            <div className="flex flex-col lg:flex-row gap-6">
                {/* Games Sidebar */}
                <div className="lg:w-64 flex flex-col gap-2">
                    <button
                        onClick={() => setActiveGame('roleta')}
                        className={`text-left px-4 py-3 rounded-xl font-bold transition-all border ${activeGame === 'roleta'
                                ? 'bg-amber-500 text-slate-900 border-amber-500 shadow-lg shadow-amber-500/20'
                                : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-750 hover:text-white'
                            }`}
                    >
                        Roleta da Sorte
                    </button>
                    {/* Add more games here in future */}
                </div>

                {/* Game Config Area */}
                <div className="flex-1">
                    {activeGame === 'roleta' && (
                        <ConfigView
                            items={wheelItems}
                            setItems={setWheelItems}
                            onSave={handleSaveRoleta}
                            gameUpgrades={gameUpgrades}
                            loading={loading}
                            paidWheelEnabled={paidWheelEnabled}
                            onPaidWheelEnabledChange={setPaidWheelEnabled}
                            paidSpinPriceUsdc={paidSpinPriceUsdc}
                            onPaidSpinPriceUsdcChange={setPaidSpinPriceUsdc}
                        />
                    )}
                </div>
            </div>
        </div>
    );
};
