// @ts-nocheck — template legado 1:1.

import React, { useState } from 'react';
import { Banknote, PlayCircle, Monitor, Save, Info, ShoppingCart, Ticket, RefreshCw, Trash2, Plus, Users, Gift, CalendarCheck, ListChecks } from 'lucide-react';
import { AdminQuests } from './AdminQuests';
import {
    getAdminMonetizationSettings,
    setMonetizationSettings,
    getEconomySettings,
    setEconomySettings as apiSetEconomySettings,
    getLootBoxes,
    getUpgrades,
    getAdminUpgrades,
    syncMiningCoinLivePricesNow,
    getAdminCheckinPremiumPolicy,
    setAdminCheckinPremiumPolicy,
    getAdminCheckinRewardPolicy,
    setAdminCheckinRewardPolicy,
    type CheckinPremiumPolicyPayload,
    type CheckinRewardPolicyPayload
} from '../../../shared/api/admin-legacy';
import { MonetizationSettings, EconomySettings, PromoCode, LootBox, Upgrade, AdminUpgrade } from '../lib/adminTypes';
import { ApplixirConfig } from './monetization/ApplixirConfig';
import { EzoicConfig } from './monetization/EzoicConfig';
import { apiFetch } from '../../../shared/api/http';

export const AdminMonetization: React.FC = () => {
    const [subTab, setSubTab] = useState<'rewarded' | 'ads' | 'economy' | 'promo' | 'quests'>('rewarded');
    const [rewardProvider, setRewardProvider] = useState<'applixir' | 'ezoic'>('applixir');
    const [economy, setEconomy] = useState<EconomySettings>({
        hardwareMarketEnabled: true,
        blackMarketEnabled: true,
        marketTaxPercent: 0,
        blackMarketPriceBandPercent: 20
    });
    const [settings, setSettings] = useState<MonetizationSettings>({
        applixirEnabled: true,
        applixirSiteId: '',
        applixirZoneId: '',
        applixirAccountId: '',
        applixirRewardMessage: 'Parabéns! Você ganhou {reward} W/h',
        applixirCallbackSecret: '',
        ezoicEnabled: false,
        ezoicPublisherId: '',
        ezoicAppId: '',
        ezoicPlaceholderId: ''
    });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [syncingLivePrices, setSyncingLivePrices] = useState(false);
    const [promoCodes, setPromoCodes] = useState<PromoCode[]>([]);
    const [lootBoxes, setLootBoxes] = useState<LootBox[]>([]);
    const [upgrades, setUpgrades] = useState<Upgrade[]>([]);
    const [bundles, setBundles] = useState<AdminUpgrade[]>([]);
    const [rewardType, setRewardType] = useState<'box' | 'upgrade' | 'bundle'>('box');
    const [newCodeForm, setNewCodeForm] = useState({ lootBoxId: '', upgradeId: '', adminUpgradeId: '', type: 'per_player' as 'per_player' | 'global_once', code: '' });
    const [checkinPremium, setCheckinPremium] = useState<CheckinPremiumPolicyPayload>({
        enabled: true,
        minUsdc: 195,
        intervalDays: 7
    });
    const [checkinReward, setCheckinReward] = useState<CheckinRewardPolicyPayload>({
        rewardType: 'hashrate',
        dailyRewardAmount: 1,
        weeklyRewardAmount: 7,
        rewardItemId: 'battery_estelar',
        streakRewardEnabled: false,
        streakRewardItemId: '',
        streakRewardDurationAmount: 7,
        streakRewardDurationUnit: 'day'
    });

    const loadPromoCodes = async () => {
        try {
            const res = await apiFetch('/api/admin/promo-codes');
            const data = await res.json();
            setPromoCodes(data || []);
        } catch (e) { }
    };

    React.useEffect(() => {
        const load = async () => {
            try {
                const [monet, econ, boxes, upgs, bndls, checkinPol, checkinRewardPol] = await Promise.all([
                    getAdminMonetizationSettings(),
                    getEconomySettings(),
                    getLootBoxes(),
                    getUpgrades(),
                    getAdminUpgrades(),
                    getAdminCheckinPremiumPolicy(),
                    getAdminCheckinRewardPolicy()
                ]);
                if (monet) setSettings(monet);
                if (econ) setEconomy(econ);
                if (checkinPol) setCheckinPremium(checkinPol);
                if (checkinRewardPol) setCheckinReward(checkinRewardPol);
                if (boxes) setLootBoxes(boxes);
                if (upgs) setUpgrades(upgs);
                if (bndls) setBundles(bndls);
                await loadPromoCodes();
            } finally {
                setLoading(false);
            }
        };
        load();
    }, []);


    const handleDeleteCode = async (code: string) => {
        if (!window.confirm('Excluir este código e todo o histórico de resgate?')) return;
        try {
            const res = await apiFetch(`/api/admin/promo-codes/${code}`, { method: 'DELETE' });
            if (res.ok) await loadPromoCodes();
        } catch (e) { }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            if (subTab === 'economy') {
                await apiSetEconomySettings(economy);
                await setAdminCheckinPremiumPolicy(checkinPremium);
                await setAdminCheckinRewardPolicy(checkinReward);
            } else if (subTab !== 'promo') {
                await setMonetizationSettings(settings);
            }
            alert('Configurações salvas!');
        } catch (e) {
            alert(e instanceof Error ? e.message : 'Erro ao salvar.');
        } finally {
            setSaving(false);
        }
    };

    const handleSyncLivePrices = async () => {
        setSyncingLivePrices(true);
        try {
            const res = await syncMiningCoinLivePricesNow();
            if (res.ok) {
                alert(`Preços sincronizados com sucesso. Moedas atualizadas: ${res.updated || 0}`);
            } else {
                alert(res.error || 'Erro ao sincronizar preços ao vivo.');
            }
        } catch (e) {
            alert('Erro de rede ao sincronizar preços.');
        } finally {
            setSyncingLivePrices(false);
        }
    };

    if (loading) return <div className="p-8 text-slate-500 animate-pulse uppercase tracking-widest text-xs">Carregando parâmetros...</div>;

    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
            {/* HEADER */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div className="flex items-center gap-3">
                    <div className="bg-green-600 text-white p-2 rounded-lg shadow-lg shadow-green-600/20">
                        <Banknote size={24} />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-white tracking-widest">MONETIZAÇÃO</h2>
                        <p className="text-[10px] text-green-500 uppercase tracking-tighter">Gestão de Receita • Publicidade & Recompensas</p>
                    </div>
                </div>

                <div className="flex items-center gap-2 p-1 bg-slate-950 rounded-lg border border-slate-800">
                    <button
                        onClick={() => setSubTab('rewarded')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-md transition-all text-xs font-bold ${subTab === 'rewarded' ? 'bg-green-600 text-white shadow-lg shadow-green-600/20' : 'text-slate-500 hover:bg-slate-900 hover:text-slate-300'}`}
                    >
                        <PlayCircle size={14} /> REWARDED
                    </button>
                    <button
                        onClick={() => setSubTab('ads')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-md transition-all text-xs font-bold ${subTab === 'ads' ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/20' : 'text-slate-500 hover:bg-slate-900 hover:text-slate-300'}`}
                    >
                        <Monitor size={14} /> ADS
                    </button>
                    <button
                        onClick={() => setSubTab('economy')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-md transition-all text-xs font-bold ${subTab === 'economy' ? 'bg-amber-600 text-white shadow-lg shadow-amber-600/20' : 'text-slate-500 hover:bg-slate-900 hover:text-slate-300'}`}
                    >
                        <ShoppingCart size={14} /> ECONOMIA
                    </button>
                    <button
                        type="button"
                        onClick={() => setSubTab('promo')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-md transition-all text-xs font-bold ${subTab === 'promo' ? 'bg-orange-600 text-white shadow-lg shadow-orange-600/20' : 'text-slate-500 hover:bg-slate-900 hover:text-slate-300'}`}
                    >
                        <Ticket size={14} /> CÓDIGOS
                    </button>
                    <button
                        type="button"
                        onClick={() => setSubTab('quests')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-md transition-all text-xs font-bold ${subTab === 'quests' ? 'bg-sky-600 text-white shadow-lg shadow-sky-600/20' : 'text-slate-500 hover:bg-slate-900 hover:text-slate-300'}`}
                    >
                        <ListChecks size={14} /> TAREFAS
                    </button>
                </div>
            </div>

            {/* CONTENT */}
            <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-8 backdrop-blur-sm min-h-[500px]">
                {subTab === 'rewarded' && (
                    <div className="space-y-8 animate-in fade-in zoom-in-95 duration-300">
                        <div className="flex items-start justify-between gap-4 p-4 bg-green-900/10 border border-green-900/30 rounded-xl">
                            <div className="flex gap-4">
                                <Info className="text-green-500 mt-1" size={20} />
                                <div>
                                    <h3 className="text-green-500 font-bold uppercase tracking-widest text-sm">Vídeos Recompensados</h3>
                                    <p className="text-slate-400 text-xs mt-1">Selecione o provedor para configurar os parâmetros específicos.</p>
                                </div>
                            </div>

                            <div className="flex gap-2">
                                <button
                                    onClick={() => setRewardProvider('applixir')}
                                    className={`px-3 py-1 rounded text-[10px] font-bold transition-all ${rewardProvider === 'applixir' ? 'bg-green-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                                >
                                    APPLIXIR
                                </button>
                                <button
                                    onClick={() => setRewardProvider('ezoic')}
                                    className={`px-3 py-1 rounded text-[10px] font-bold transition-all ${rewardProvider === 'ezoic' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                                >
                                    EZOIC
                                </button>
                            </div>
                        </div>

                        <div className="bg-slate-900/50 border border-slate-700 p-6 rounded-xl space-y-8">
                            {rewardProvider === 'applixir' ? (
                                <ApplixirConfig settings={settings} setSettings={setSettings} />
                            ) : (
                                <EzoicConfig settings={settings} setSettings={setSettings} />
                            )}

                            <div className="pt-4 border-t border-slate-800">
                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className={`w-full py-3 rounded-xl font-bold text-xs uppercase tracking-widest flex items-center justify-center gap-2 transition-all ${saving ? 'bg-slate-800 text-slate-500' : 'bg-green-600 hover:bg-green-500 text-white shadow-lg shadow-green-600/20'}`}
                                >
                                    <Save size={16} /> {saving ? 'Salvando...' : 'Salvar Todas as Configurações'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {subTab === 'ads' && (
                    <div className="space-y-8 animate-in fade-in zoom-in-95 duration-300">
                        <div className="flex items-start gap-4 p-4 bg-amber-900/10 border border-amber-900/30 rounded-xl">
                            <Info className="text-amber-500 mt-1" size={20} />
                            <div>
                                <h3 className="text-amber-500 font-bold uppercase tracking-widest text-sm">Configuração de ADS Estáticos</h3>
                                <p className="text-slate-400 text-xs mt-1">Gerencie banners e pop-ups publicitários do sistema.</p>
                            </div>
                        </div>

                        <div className="flex flex-col items-center justify-center py-20 text-slate-500 gap-4">
                            <Monitor size={64} className="opacity-10 animate-pulse" />
                            <div className="text-center">
                                <p className="text-sm font-bold text-slate-400 uppercase tracking-widest">Painel de Publicidade Offline</p>
                                <p className="text-xs italic mt-2">Nenhum provedor de ADS configurado para esta instância.</p>
                            </div>
                            <button className="mt-4 px-6 py-2 bg-amber-800/20 border border-amber-700/50 text-amber-400 rounded-lg font-bold text-[10px] uppercase tracking-widest hover:bg-amber-800/40 transition-all cursor-wait">
                                Configurar SDK +
                            </button>
                        </div>
                    </div>
                )}

                {subTab === 'economy' && (
                    <div className="space-y-8 animate-in fade-in zoom-in-95 duration-300">
                        <div className="flex items-start gap-4 p-4 bg-amber-900/10 border border-amber-900/30 rounded-xl">
                            <Info className="text-amber-500 mt-1" size={20} />
                            <div>
                                <h3 className="text-amber-500 font-bold uppercase tracking-widest text-sm">Configuração de Economia</h3>
                                <p className="text-slate-400 text-xs mt-1">Controle os mercados internos e a taxa global aplicada nas transações.</p>
                            </div>
                        </div>

                        <div className="bg-slate-900/50 border border-slate-700 p-6 rounded-xl space-y-6">
                            <div className="flex justify-end">
                                <button
                                    type="button"
                                    onClick={handleSyncLivePrices}
                                    disabled={syncingLivePrices}
                                    className={`rounded-lg px-4 py-2 text-xs font-bold uppercase tracking-widest transition-all ${
                                        syncingLivePrices
                                            ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                                            : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20'
                                    }`}
                                >
                                    {syncingLivePrices ? 'Sincronizando preços...' : 'Atualizar preços agora'}
                                </button>
                            </div>

                            <div className="p-5 rounded-xl border border-sky-900/40 bg-sky-950/20 space-y-4">
                                <div className="flex items-center gap-2">
                                    <CalendarCheck className="text-sky-400" size={20} />
                                    <div>
                                        <h4 className="text-xs font-bold uppercase tracking-widest text-sky-300">
                                            Check-in premium (passes ≥ USDC)
                                        </h4>
                                        <p className="text-[11px] text-slate-400 mt-0.5">
                                            Retroativo: quem já comprou pacote na loja Upgrades com preço ≥ limite entra no check-in
                                            a cada N dias (vitalício).
                                        </p>
                                    </div>
                                </div>
                                <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={checkinPremium.enabled}
                                        onChange={(e) => setCheckinPremium((p) => ({ ...p, enabled: e.target.checked }))}
                                    />
                                    Regra activa
                                </label>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg">
                                    <div>
                                        <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">
                                            Preço mínimo (USDC)
                                        </label>
                                        <input
                                            type="number"
                                            min={0}
                                            step={1}
                                            className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                            value={checkinPremium.minUsdc}
                                            onChange={(e) =>
                                                setCheckinPremium((p) => ({
                                                    ...p,
                                                    minUsdc: Math.max(0, Number(e.target.value) || 0)
                                                }))
                                            }
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">
                                            Dias entre check-ins
                                        </label>
                                        <input
                                            type="number"
                                            min={1}
                                            step={1}
                                            className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                            value={checkinPremium.intervalDays}
                                            onChange={(e) =>
                                                setCheckinPremium((p) => ({
                                                    ...p,
                                                    intervalDays: Math.max(1, Math.floor(Number(e.target.value) || 7))
                                                }))
                                            }
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="p-5 rounded-xl border border-emerald-900/40 bg-emerald-950/20 space-y-4">
                                <div className="flex items-center gap-2">
                                    <Gift className="text-emerald-400" size={20} />
                                    <div>
                                        <h4 className="text-xs font-bold uppercase tracking-widest text-emerald-300">
                                            Recompensa do check-in
                                        </h4>
                                        <p className="text-[11px] text-slate-400 mt-0.5">
                                            Diário: quantidade por ciclo. Premium semanal: quantidade por check-in do intervalo.
                                            Pode mudar o tipo (H/s, bateria ou item) quando quiser. H/s de check-in não entra
                                            nas moedas ASIC da SALA DAS ASICS — só rigs fora dessa sala.
                                        </p>
                                    </div>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-4xl">
                                    <div>
                                        <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">
                                            Tipo de recompensa
                                        </label>
                                        <select
                                            className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                            value={checkinReward.rewardType}
                                            onChange={(e) =>
                                                setCheckinReward((p) => ({
                                                    ...p,
                                                    rewardType: e.target.value as CheckinRewardPolicyPayload['rewardType']
                                                }))
                                            }
                                        >
                                            <option value="hashrate">Hashrate (H/s)</option>
                                            <option value="battery">Bateria (inventário)</option>
                                            <option value="item">Item (inventário)</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">
                                            Diário (por check-in)
                                        </label>
                                        <input
                                            type="number"
                                            min={0}
                                            step={checkinReward.rewardType === 'hashrate' ? 0.1 : 1}
                                            className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                            value={checkinReward.dailyRewardAmount}
                                            onChange={(e) =>
                                                setCheckinReward((p) => ({
                                                    ...p,
                                                    dailyRewardAmount: Math.max(0, Number(e.target.value) || 0)
                                                }))
                                            }
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">
                                            Premium semanal (por check-in)
                                        </label>
                                        <input
                                            type="number"
                                            min={0}
                                            step={checkinReward.rewardType === 'hashrate' ? 0.1 : 1}
                                            className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                            value={checkinReward.weeklyRewardAmount}
                                            onChange={(e) =>
                                                setCheckinReward((p) => ({
                                                    ...p,
                                                    weeklyRewardAmount: Math.max(0, Number(e.target.value) || 0)
                                                }))
                                            }
                                        />
                                    </div>
                                    {checkinReward.rewardType !== 'hashrate' ? (
                                        <div>
                                            <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">
                                                ID do item (`upgrades`)
                                            </label>
                                            <input
                                                type="text"
                                                className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white font-mono"
                                                value={checkinReward.rewardItemId}
                                                onChange={(e) =>
                                                    setCheckinReward((p) => ({
                                                        ...p,
                                                        rewardItemId: e.target.value.trim() || 'battery_estelar'
                                                    }))
                                                }
                                            />
                                        </div>
                                    ) : (
                                        <div className="flex items-end">
                                            <p className="text-[11px] text-slate-500 pb-2">
                                                Unidade: <span className="text-emerald-300 font-mono">H/s</span> acumulados permanentemente.
                                            </p>
                                        </div>
                                    )}
                                </div>

                                <div className="pt-3 border-t border-emerald-900/40 space-y-3">
                                    <div className="flex items-start gap-3">
                                        <input
                                            type="checkbox"
                                            className="mt-1"
                                            checked={!!checkinReward.streakRewardEnabled}
                                            onChange={(e) =>
                                                setCheckinReward((p) => ({
                                                    ...p,
                                                    streakRewardEnabled: e.target.checked
                                                }))
                                            }
                                        />
                                        <div>
                                            <div className="text-[11px] font-bold uppercase tracking-widest text-emerald-200">
                                                Prémio aos 7 dias seguidos
                                            </div>
                                            <p className="text-[11px] text-slate-400 mt-0.5">
                                                No 7º, 14º, 21º… check-in diário consecutivo, entrega 1 máquina temporária no stock
                                                (com validade). Só aplica ao check-in diário, não ao premium por intervalo.
                                            </p>
                                        </div>
                                    </div>
                                    {checkinReward.streakRewardEnabled ? (
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-4xl">
                                            <div>
                                                <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">
                                                    ID da máquina (`upgrades`)
                                                </label>
                                                <input
                                                    type="text"
                                                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white font-mono"
                                                    placeholder="ex.: asic_promo_xyz"
                                                    value={checkinReward.streakRewardItemId}
                                                    onChange={(e) =>
                                                        setCheckinReward((p) => ({
                                                            ...p,
                                                            streakRewardItemId: e.target.value.trim()
                                                        }))
                                                    }
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">
                                                    Validade (quantidade)
                                                </label>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    step={1}
                                                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                                    value={checkinReward.streakRewardDurationAmount}
                                                    onChange={(e) =>
                                                        setCheckinReward((p) => ({
                                                            ...p,
                                                            streakRewardDurationAmount: Math.max(
                                                                1,
                                                                Math.floor(Number(e.target.value) || 1)
                                                            )
                                                        }))
                                                    }
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">
                                                    Unidade de validade
                                                </label>
                                                <select
                                                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                                    value={checkinReward.streakRewardDurationUnit}
                                                    onChange={(e) =>
                                                        setCheckinReward((p) => ({
                                                            ...p,
                                                            streakRewardDurationUnit: e.target
                                                                .value as CheckinRewardPolicyPayload['streakRewardDurationUnit']
                                                        }))
                                                    }
                                                >
                                                    <option value="day">Dias</option>
                                                    <option value="week">Semanas</option>
                                                    <option value="month">Meses</option>
                                                    <option value="year">Anos</option>
                                                </select>
                                            </div>
                                        </div>
                                    ) : null}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <label className="flex items-start gap-3 p-4 rounded-xl border border-slate-800 bg-slate-950/60 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="mt-1"
                                        checked={!!economy.hardwareMarketEnabled}
                                        onChange={(e) => setEconomy({ ...economy, hardwareMarketEnabled: e.target.checked })}
                                    />
                                    <div>
                                        <div className="text-xs font-bold uppercase tracking-widest text-white">Loja de Hardware</div>
                                        <div className="text-xs text-slate-400 mt-1">Permite compra e venda de hardware no mercado interno.</div>
                                    </div>
                                </label>

                                <label className="flex items-start gap-3 p-4 rounded-xl border border-slate-800 bg-slate-950/60 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="mt-1"
                                        checked={!!economy.blackMarketEnabled}
                                        onChange={(e) => setEconomy({ ...economy, blackMarketEnabled: e.target.checked })}
                                    />
                                    <div>
                                        <div className="text-xs font-bold uppercase tracking-widest text-white">Black Market</div>
                                        <div className="text-xs text-slate-400 mt-1">Ativa o mercado paralelo para os itens compatíveis.</div>
                                    </div>
                                </label>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="max-w-xs">
                                    <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">Taxa de Mercado (%)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                        value={economy.marketTaxPercent ?? 0}
                                        onChange={(e) => setEconomy({ ...economy, marketTaxPercent: Number(e.target.value) || 0 })}
                                    />
                                </div>

                                <div className="max-w-xs">
                                    <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">Banda de Preço P2P (%)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        max="200"
                                        step="1"
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                        value={economy.blackMarketPriceBandPercent ?? 20}
                                        onChange={(e) =>
                                            setEconomy({
                                                ...economy,
                                                blackMarketPriceBandPercent: Math.min(200, Math.max(0, Number(e.target.value) || 0))
                                            })
                                        }
                                    />
                                    <p className="mt-1 text-[10px] text-slate-500">
                                        Ex.: `20` permite anunciar entre `80%` e `120%` do preço de referência da Lojinha Miner.
                                    </p>
                                </div>
                            </div>

                            <div className="pt-4 border-t border-slate-800">
                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className={`w-full py-3 rounded-xl font-bold text-xs uppercase tracking-widest flex items-center justify-center gap-2 transition-all ${saving ? 'bg-slate-800 text-slate-500' : 'bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-600/20'}`}
                                >
                                    <Save size={16} /> {saving ? 'Salvando...' : 'Salvar Configurações de Economia'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {subTab === 'promo' && (
                    <div className="space-y-8 animate-in fade-in zoom-in-95 duration-300">
                        <div className="flex items-start gap-4 p-4 bg-orange-900/10 border border-orange-900/30 rounded-xl">
                            <Info className="text-orange-500 mt-1" size={20} />
                            <div>
                                <h3 className="text-orange-500 font-bold uppercase tracking-widest text-sm">Resgate por Código</h3>
                                <p className="text-slate-400 text-xs mt-1">Gere códigos promocionais vinculados a Caixas da Sorte.</p>
                            </div>
                        </div>


                        {/* CREATE FORM */}
                        <div className="bg-slate-900/50 border border-slate-700 p-6 rounded-xl mb-6">
                            <h4 className="text-white font-bold text-xs uppercase tracking-widest mb-4 flex items-center gap-2">
                                <Plus size={14} className="text-orange-500" /> Novo Código Promocional
                            </h4>
                            <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
                                <div>
                                    <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">Código</label>
                                    <input
                                        type="text"
                                        placeholder="EX: NATAL2024"
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white uppercase"
                                        value={newCodeForm.code}
                                        onChange={(e) => setNewCodeForm({ ...newCodeForm, code: e.target.value.toUpperCase() })}
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">Recompensa</label>
                                    <select
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                        value={rewardType}
                                        onChange={(e) => setRewardType(e.target.value as any)}
                                    >
                                        <option value="box">📦 Caixa</option>
                                        <option value="upgrade">🎁 Item (Upgrade)</option>
                                        <option value="bundle">💎 Pacote (Bundle)</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">
                                        {rewardType === 'box' ? 'Caixa de Destino' : rewardType === 'upgrade' ? 'Item de Destino' : 'Pacote de Destino'}
                                    </label>
                                    {rewardType === 'box' && (
                                        <select
                                            className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                            value={newCodeForm.lootBoxId}
                                            onChange={(e) => setNewCodeForm({ ...newCodeForm, lootBoxId: e.target.value, upgradeId: '', adminUpgradeId: '' })}
                                        >
                                            <option value="">Selecione...</option>
                                            {lootBoxes.map(b => (
                                                <option key={b.id} value={b.id}>{b.icon} {b.name}</option>
                                            ))}
                                        </select>
                                    )}
                                    {rewardType === 'upgrade' && (
                                        <select
                                            className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                            value={newCodeForm.upgradeId}
                                            onChange={(e) => setNewCodeForm({ ...newCodeForm, upgradeId: e.target.value, lootBoxId: '', adminUpgradeId: '' })}
                                        >
                                            <option value="">Selecione...</option>
                                            {upgrades.sort((a, b) => a.name.localeCompare(b.name)).map(u => (
                                                <option key={u.id} value={u.id}>{u.name}</option>
                                            ))}
                                        </select>
                                    )}
                                    {rewardType === 'bundle' && (
                                        <select
                                            className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                            value={newCodeForm.adminUpgradeId}
                                            onChange={(e) => setNewCodeForm({ ...newCodeForm, adminUpgradeId: e.target.value, lootBoxId: '', upgradeId: '' })}
                                        >
                                            <option value="">Selecione...</option>
                                            {bundles.map(b => (
                                                <option key={b.id} value={b.id}>{b.name}</option>
                                            ))}
                                        </select>
                                    )}
                                </div>
                                <div>
                                    <label className="block text-[10px] text-slate-500 uppercase font-bold mb-1">Tipo de Resgate</label>
                                    <select
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-xs text-white"
                                        value={newCodeForm.type}
                                        onChange={(e) => setNewCodeForm({ ...newCodeForm, type: e.target.value as any })}
                                    >
                                        <option value="per_player">Cada Player 1x</option>
                                        <option value="global_once">Global 1x Total</option>
                                        <option value="roleta_player_1x">Roleta: Jogador 1x</option>
                                        <option value="roleta_global_1x">Roleta: Global 1x</option>
                                    </select>
                                </div>
                                <button
                                    onClick={async () => {
                                        const f = newCodeForm;
                                        if (!f.code || (!f.lootBoxId && !f.upgradeId && !f.adminUpgradeId)) return alert('Preencha os campos!');

                                        setSaving(true);
                                        try {
                                            const res = await apiFetch('/api/admin/promo-codes', {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify(f)
                                            });
                                            if (res.ok) {
                                                setNewCodeForm({ lootBoxId: '', upgradeId: '', adminUpgradeId: '', type: 'per_player', code: '' });
                                                await loadPromoCodes();
                                                alert('Código gerado com sucesso!');
                                            } else {
                                                const err = await res.json();
                                                alert(err.error || 'Erro ao gerar código');
                                            }
                                        } catch (e) {
                                            alert('Erro de conexão ao gerar código');
                                        } finally {
                                            setSaving(false);
                                        }
                                    }}
                                    disabled={saving}
                                    className={`bg-orange-600 hover:bg-orange-500 text-white rounded font-bold text-[10px] uppercase py-2.5 px-4 shadow-lg shadow-orange-600/20 transition-all ${saving ? 'opacity-50 cursor-wait' : ''}`}
                                >
                                    {saving ? 'Gerando...' : 'Gerar Código'}
                                </button>
                            </div>
                        </div>

                        {/* LIST */}
                        <div className="bg-slate-900/50 border border-slate-700 rounded-xl overflow-hidden">
                            <div className="p-4 border-b border-slate-700 flex justify-between items-center bg-slate-900/80">
                                <h4 className="text-white font-bold text-xs uppercase tracking-widest">Códigos Ativos</h4>
                                <button onClick={loadPromoCodes} className="text-slate-500 hover:text-white transition-colors">
                                    <RefreshCw size={14} />
                                </button>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-left border-collapse">
                                    <thead>
                                        <tr className="bg-slate-950/50 text-[10px] text-slate-500 uppercase font-bold">
                                            <th className="p-4 border-b border-slate-800">Código</th>
                                            <th className="p-4 border-b border-slate-800">Caixa Vinculada</th>
                                            <th className="p-4 border-b border-slate-800">Tipo</th>
                                            <th className="p-4 border-b border-slate-800 text-center">Resgates</th>
                                            <th className="p-4 border-b border-slate-800">Criado em</th>
                                            <th className="p-4 border-b border-slate-800 text-right">Ação</th>
                                        </tr>
                                    </thead>
                                    <tbody className="text-xs">
                                        {promoCodes.map(c => {
                                            const box = lootBoxes.find(b => b.id === c.lootBoxId);
                                            return (
                                                <tr key={c.code} className="hover:bg-slate-800/30 border-b border-slate-800/50 transition-colors">
                                                    <td className="p-4 font-mono font-bold text-orange-400">{c.code}</td>
                                                    <td className="p-4 text-slate-300">
                                                        {c.lootBoxId ? (
                                                            box ? `${box.icon} ${box.name}` : <span className="text-red-500 italic">Caixa Desconhecida ({c.lootBoxId})</span>
                                                        ) : c.upgradeId ? (
                                                            <span>🎁 {upgrades.find(u => u.id === c.upgradeId)?.name || c.upgradeId}</span>
                                                        ) : c.adminUpgradeId ? (
                                                            <span>💎 {bundles.find(b => b.id === c.adminUpgradeId)?.name || c.adminUpgradeId}</span>
                                                        ) : (
                                                            <span className="text-slate-500 text-[10px] uppercase italic">Sem Recompensa</span>
                                                        )}
                                                    </td>
                                                    <td className="p-4">
                                                        <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase ${c.type === 'per_player' ? 'bg-amber-900/30 text-amber-400' :
                                                                c.type === 'global_once' ? 'bg-amber-900/30 text-amber-400' :
                                                                    'bg-green-900/30 text-green-400'
                                                            }`}>
                                                            {c.type === 'per_player' ? 'Múltiplo (Player 1x)' :
                                                                c.type === 'global_once' ? 'Único (Global 1x)' :
                                                                    c.type.startsWith('roleta') ? `ROLETA (${c.type.includes('global') ? 'GLOBAL' : 'PLAYER'})` :
                                                                        c.type}
                                                        </span>
                                                    </td>
                                                    <td className="p-4 text-center">
                                                        <div className="flex flex-col items-center group relative">
                                                            <span className="font-bold text-white flex items-center gap-1">
                                                                <Users size={12} className="text-slate-500" /> {(c as any).redemptionsCount || 0}
                                                            </span>
                                                            {/* Tooltip simple with last redemptions */}
                                                            {(c as any).lastRedemptions?.length > 0 && (
                                                                <div className="hidden group-hover:block absolute bottom-full mb-2 w-48 bg-slate-950 border border-slate-700 p-2 rounded shadow-2xl z-20 text-[9px] text-slate-400">
                                                                    <p className="font-bold mb-1 text-white uppercase border-b border-slate-800 pb-1">Últimos resgates:</p>
                                                                    {(c as any).lastRedemptions.slice(0, 5).map((r: any, idx: number) => (
                                                                        <div key={idx} className="flex justify-between mt-1">
                                                                            <span className="truncate max-w-[100px]">{r.userName}</span>
                                                                            <span>{new Date(r.redeemedAt).toLocaleDateString()}</span>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className="p-4 text-slate-500">{new Date(c.createdAt).toLocaleDateString()}</td>
                                                    <td className="p-4 text-right">
                                                        <button
                                                            onClick={() => handleDeleteCode(c.code)}
                                                            className="p-1.5 text-slate-500 hover:text-red-500 transition-colors"
                                                            title="Excluir Código"
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                        {promoCodes.length === 0 && (
                                            <tr>
                                                <td colSpan={6} className="p-12 text-center text-slate-600 italic">Nenhum código promocional ativo.</td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                )}
                {subTab === 'quests' && (
                    <div className="animate-in fade-in zoom-in-95 duration-300">
                        <AdminQuests />
                    </div>
                )}
            </div>
        </div>
    );
};
