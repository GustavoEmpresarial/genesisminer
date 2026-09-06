// @ts-nocheck — template legado 1:1.

import React, { useEffect, useState } from 'react';
import {
  getEconomyStats,
  getMiningRuntimeSummary,
  syncMiningCoinLivePricesNow,
  type MiningRuntimeSummary,
  updateEconomySettings
} from '../../../shared/api/admin-economy';
import { RefreshCw, Save, DollarSign, Activity, Cpu } from 'lucide-react';

/** Alinhado ao backend / simulador (tempo de bloco fixo). */
const MINING_BLOCK_TIME_SEC = 600;
const BLOCKS_PER_DAY = 86400 / MINING_BLOCK_TIME_SEC;
/** Mês de referência 31 dias (144 × 31). */
const BLOCKS_PER_MONTH_31 = Math.round(BLOCKS_PER_DAY * 31);

interface EconomyCoin {
    id: string;
    name: string;
    symbol: string;
    price_usd: number;
    network_hashrate: number;
    block_reward: number;
    block_time: number;
    realActiveMiners: number;
    realTotalHashrate: number;
}

export const AdminEconomy: React.FC = () => {
    const [coins, setCoins] = useState<EconomyCoin[]>([]);
    const [runtime, setRuntime] = useState<MiningRuntimeSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [syncingPrices, setSyncingPrices] = useState(false);
    const [targets, setTargets] = useState<Record<string, number>>({});
    const [simulated, setSimulated] = useState<Record<string, { reward: number, hashrate: number }>>({});

    const loadData = async () => {
        setLoading(true);
        try {
            const [data, rt] = await Promise.all([getEconomyStats(), getMiningRuntimeSummary()]);
            setRuntime(rt);
            setCoins(data);
            // Initialize targets with current daily emission USD
            const initTargets: Record<string, number> = {};
            data.forEach((c: EconomyCoin) => {
                const bt = c.block_time > 0 ? c.block_time : MINING_BLOCK_TIME_SEC;
                const dailyBlocks = 86400 / bt;
                const dailyEmission = dailyBlocks * c.block_reward * c.price_usd;
                initTargets[c.id] = parseFloat(dailyEmission.toFixed(2));
            });
            setTargets(initTargets);
        } catch (e) {
            console.error(e);
            alert('Falha ao carregar dados da economia.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { loadData(); }, []);

    const handleSimulate = (coin: EconomyCoin) => {
        const targetUsd = targets[coin.id] || 0;
        const price = coin.price_usd || 0.1; // fallback
        if (price <= 0) return;

        // Formula: Reward = (TargetUSD / Price) / (86400 / BlockTime)
        const bt = coin.block_time > 0 ? coin.block_time : MINING_BLOCK_TIME_SEC;
        const dailyBlocks = 86400 / bt;
        const dailyTokens = targetUsd / price;
        const newReward = dailyTokens / dailyBlocks;

        // For Network Hashrate, we suggest setting it to Real Total Hashrate for fairness
        const newHashrate = coin.realTotalHashrate > 0 ? coin.realTotalHashrate : coin.network_hashrate;

        setSimulated(prev => ({
            ...prev,
            [coin.id]: { reward: newReward, hashrate: newHashrate }
        }));
    };

    const handleApply = async (coinId: string) => {
        const sim = simulated[coinId];
        if (!sim) return;

        if (!window.confirm(`Aplicar ajustes para esta moeda?\n\nNovo Hashrate: ${sim.hashrate}\nNova Reward: ${sim.reward.toFixed(8)}`)) return;

        try {
            const res = await updateEconomySettings(coinId, sim.hashrate, sim.reward);
            if (res.ok) {
                alert('Ajuste aplicado com sucesso!');
                loadData();
                setSimulated(prev => {
                    const next = { ...prev };
                    delete next[coinId];
                    return next;
                });
            } else {
                alert('Erro ao aplicar: ' + res.error);
            }
        } catch (e) {
            alert('Erro de rede.');
        }
    };

    const handleSyncLivePrices = async () => {
        setSyncingPrices(true);
        try {
            const res = await syncMiningCoinLivePricesNow();
            if (res.ok) {
                await loadData();
                alert(`Preços sincronizados com sucesso. Moedas atualizadas: ${res.updated || 0}`);
            } else {
                alert(res.error || 'Falha ao sincronizar preços ao vivo.');
            }
        } catch (e) {
            alert('Erro de rede ao sincronizar preços.');
        } finally {
            setSyncingPrices(false);
        }
    };

    if (loading) return <div className="p-8 text-white">Carregando economia...</div>;

    return (
        <div className="space-y-6 animate-fade-in">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                        <DollarSign className="text-green-400" /> Gestor Econômico
                    </h2>
                    <p className="text-slate-400 text-sm">Controle a emissão de tokens baseado em metas de Dólar (USD).</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleSyncLivePrices}
                        disabled={syncingPrices}
                        className="flex items-center gap-2 rounded bg-emerald-700 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        <RefreshCw size={16} className={syncingPrices ? 'animate-spin' : ''} />
                        {syncingPrices ? 'Sincronizando...' : 'Atualizar preços agora'}
                    </button>
                    <button onClick={loadData} className="p-2 bg-slate-800 text-slate-300 rounded hover:bg-slate-700">
                        <RefreshCw size={18} />
                    </button>
                </div>
            </div>

            <div className="rounded-lg border border-slate-700 bg-slate-900/80 px-4 py-3 text-sm text-slate-300">
                <p className="font-semibold text-slate-200 mb-1">Distribuição de blocos (tempo de bloco fixo: 10 min / 600 s)</p>
                <p>
                    São distribuídos <span className="text-amber-400 font-mono">{BLOCKS_PER_DAY}</span> blocos por dia e{' '}
                    <span className="text-amber-400 font-mono">{BLOCKS_PER_MONTH_31}</span> blocos num mês de 31 dias (144 × 31).
                    O simulador e o crédito de mineração usam a taxa <span className="text-slate-400">yield por hash</span>; alterar só o preço em USD da moeda não deve criar novo ponto no histórico de yield.
                </p>
            </div>

            <div
                className={`rounded-lg border px-4 py-3 text-sm ${
                    runtime
                        ? 'border-cyan-900/60 bg-cyan-950/30 text-slate-200'
                        : 'border-slate-700/80 bg-slate-900/50 text-slate-500'
                }`}
            >
                <p className="font-semibold text-slate-200 mb-1 flex items-center gap-2">
                    <Activity size={14} className="text-cyan-400" />
                    Runtime ao vivo (workers / API admin)
                </p>
                {runtime ? (
                    <p>
                        Total de mineradores activos na sessão:{' '}
                        <span className="font-mono text-cyan-300">{runtime.realActiveMiners}</span>. Por moeda, vê abaixo{' '}
                        <span className="text-slate-400">hashrate runtime</span> e{' '}
                        <span className="text-slate-400">miners runtime</span> (paralelo aos números calculados a partir dos racks na BD).
                    </p>
                ) : (
                    <p>Indisponível (rede, permissões ou endpoint). Os cartões mostram só a rede real calculada a partir dos racks.</p>
                )}
            </div>

            <div className="grid gap-6">
                {coins.map(coin => {
                    const bt = coin.block_time > 0 ? coin.block_time : MINING_BLOCK_TIME_SEC;
                    const dailyBlocks = 86400 / bt;
                    const currentDailyEmission = dailyBlocks * coin.block_reward * coin.price_usd;
                    const sim = simulated[coin.id];
                    const rtHash = runtime?.realNetworkHashrates[coin.id];
                    const rtMiners = runtime?.activeMinersByCoin[coin.id];

                    return (
                        <div key={coin.id} className="bg-slate-900 border border-slate-800 rounded-xl p-6 relative overflow-hidden">
                            <div className="flex justify-between items-start mb-4 relative z-10">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-lg font-bold">
                                        {coin.symbol?.[0] ?? '?'}
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-white">{coin.name} <span className="text-slate-500 text-sm">({coin.symbol})</span></h3>
                                        <div className="text-xs text-green-400 font-mono">Price: ${coin.price_usd}</div>
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="text-xs text-slate-500 uppercase font-bold">Emissão Atual (Dia)</div>
                                    <div className="text-xl font-mono text-white">${currentDailyEmission.toFixed(2)}</div>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6 relative z-10">
                                {/* Stats Real */}
                                <div className="bg-slate-950/50 p-3 rounded border border-slate-800/50">
                                    <div className="text-xs text-amber-400 font-bold mb-2 flex items-center gap-1"><Activity size={12} /> Rede real (racks / BD)</div>
                                    <div className="flex justify-between text-sm mb-1">
                                        <span className="text-slate-500">Mineradores:</span>
                                        <span className="text-white">{coin.realActiveMiners}</span>
                                    </div>
                                    <div className="flex justify-between text-sm mb-2">
                                        <span className="text-slate-500">Hashrate:</span>
                                        <span className="text-white">{coin.realTotalHashrate.toLocaleString()} H/s</span>
                                    </div>
                                    <div className="text-[10px] uppercase font-bold text-cyan-500/90 mb-1">Runtime (workers)</div>
                                    <div className="flex justify-between text-sm mb-1">
                                        <span className="text-slate-500">Miners runtime:</span>
                                        <span className="text-cyan-200 font-mono">
                                            {rtMiners !== undefined ? rtMiners : '—'}
                                        </span>
                                    </div>
                                    <div className="flex justify-between text-sm">
                                        <span className="text-slate-500">Hashrate runtime:</span>
                                        <span className="text-cyan-200 font-mono">
                                            {rtHash !== undefined ? `${rtHash.toLocaleString()} H/s` : '—'}
                                        </span>
                                    </div>
                                </div>

                                {/* Config Atual */}
                                <div className="bg-slate-950/50 p-3 rounded border border-slate-800/50">
                                    <div className="text-xs text-orange-400 font-bold mb-2 flex items-center gap-1"><Cpu size={12} /> Config Atual</div>
                                    <div className="flex justify-between text-sm mb-1">
                                        <span className="text-slate-500">Reward:</span>
                                        <span className="text-white font-mono">{coin.block_reward.toFixed(6)}</span>
                                    </div>
                                    <div className="flex justify-between text-sm">
                                        <span className="text-slate-500">Diff (Network):</span>
                                        <span className="text-white">{coin.network_hashrate.toLocaleString()}</span>
                                    </div>
                                </div>

                                {/* Calculadora */}
                                <div className="bg-green-900/10 p-3 rounded border border-green-900/30">
                                    <div className="text-xs text-green-400 font-bold mb-2 flex items-center gap-1"><DollarSign size={12} /> Meta Diária (USD)</div>
                                    <div className="flex gap-2">
                                        <input
                                            type="number"
                                            value={targets[coin.id] || ''}
                                            onChange={(e) => setTargets({ ...targets, [coin.id]: parseFloat(e.target.value) })}
                                            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white text-sm focus:border-green-500 outline-none"
                                            placeholder="0.00"
                                        />
                                        <button
                                            onClick={() => handleSimulate(coin)}
                                            className="bg-green-600 hover:bg-green-500 text-white px-3 py-1 rounded text-xs font-bold uppercase"
                                        >
                                            Calc
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Simulation Result */}
                            {sim && (
                                <div className="bg-slate-800 p-4 rounded-lg flex items-center justify-between border border-green-500/30 animate-in fade-in slide-in-from-top-2">
                                    <div className="text-sm">
                                        <div className="text-slate-400 text-xs uppercase mb-1">Sugestão de Ajuste</div>
                                        <div className="flex gap-4">
                                            <div>
                                                <span className="text-slate-500 mr-2">Reward:</span>
                                                <span className="text-green-400 font-mono font-bold">{sim.reward.toFixed(8)}</span>
                                            </div>
                                            <div>
                                                <span className="text-slate-500 mr-2">Network:</span>
                                                <span className="text-green-400 font-mono font-bold">{sim.hashrate.toLocaleString()}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleApply(coin.id)}
                                        className="bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded-lg flex items-center gap-2 font-bold shadow-lg shadow-amber-600/20"
                                    >
                                        <Save size={16} /> Aplicar
                                    </button>
                                </div>
                            )}

                        </div>
                    );
                })}
            </div>
        </div>
    );
};
