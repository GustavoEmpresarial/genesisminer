// @ts-nocheck — markup legado; o client usa strict+noUnusedLocals.
import React, { useEffect, useState } from 'react';
import { getAdminRanking, getPublicRanking } from '../../../shared/api/admin-users';
import { isNftRoomExclusiveMiningCoin } from '../lib/adminTypes';

interface Coin {
    id: string;
    name: string;
    symbol: string;
}

interface RankingUser {
    user_id: number;
    username: string;
    coins: Record<string, number>;
    generalCoins?: Record<string, number>;
    generalPower?: number;
    balances: Record<string, number>;
}

interface RankingData {
    timestamp: number;
    ranking: RankingUser[];
    coins: Coin[];
}

interface AdminRankingProps {
    isPublic?: boolean;
}

export const AdminRanking: React.FC<AdminRankingProps> = ({ isPublic }) => {
    const [data, setData] = useState<RankingData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [selectedCoin, setSelectedCoin] = useState<string>('ALL');

    useEffect(() => {
        const fetchRanking = async () => {
            try {
                const json = isPublic ? await getPublicRanking() : await getAdminRanking();
                setData(json);
            } catch (err: unknown) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        };
        fetchRanking();
    }, [isPublic]);

    const [rankingMode, setRankingMode] = useState<'POWER' | 'BALANCE'>('POWER');

    const getSortedRanking = () => {
        if (!data) return { list: [], activeCoin: '' };

        const activeCoin = selectedCoin;

        const sumGeneralPower = (u: RankingUser): number => {
            // generalCoins presente (mesmo {}) = fonte de verdade — não fallback para coins (ASIC).
            if (u.generalCoins != null && typeof u.generalCoins === 'object') {
                return Object.values(u.generalCoins).reduce((acc, curr) => acc + (Number(curr) || 0), 0);
            }
            if (typeof u.generalPower === 'number' && Number.isFinite(u.generalPower)) {
                return u.generalPower;
            }
            // Fallback legado: excluir moedas exclusivas da Sala NFT
            return Object.entries(u.coins).reduce((acc, [coinId, curr]) => {
                const meta = data.coins.find((c) => c.id === coinId);
                if (meta && isNftRoomExclusiveMiningCoin(meta)) return acc;
                if (isNftRoomExclusiveMiningCoin(coinId)) return acc;
                return acc + curr;
            }, 0);
        };

        if (activeCoin === 'ALL') {
            const filtered = data.ranking
                .map(u => ({ ...u, power: sumGeneralPower(u) }))
                .filter(u => u.power > 0)
                .sort((a, b) => b.power - a.power);

            return { list: filtered, activeCoin: 'ALL' };
        } else {
            // Moeda Específica — POWER usa generalCoins (exclui ASIC/NFT); BALANCE mantém coins p/ filtro.
            let result = data.ranking.map(u => ({
                ...u,
                power: rankingMode === 'POWER'
                    ? (u.generalCoins?.[activeCoin] ?? 0)
                    : (u.coins[activeCoin] || 0),
                balance: u.balances?.[activeCoin] || 0
            }));

            if (rankingMode === 'POWER') {
                // Ordenar por poder e filtrar apenas quem tem poder > 0 (opcional, mas comum para ranking de mineração)
                result = result.filter(u => u.power > 0).sort((a, b) => b.power - a.power);
            } else {
                // Modo Saldo: Mostrar todos que tem saldo OU poder, ordenar por saldo
                result = result
                    .filter(u => u.balance > 0 || u.power > 0) // Inclui mineradores mesmo com saldo 0 para facilitar edição
                    .sort((a, b) => b.balance - a.balance);
            }

            return { list: result, activeCoin };
        }
    };

    const [editingBalances, setEditingBalances] = useState<Record<string, number>>({});
    const [savingBalance, setSavingBalance] = useState<string | null>(null);

    const handleSaveBalance = async (userId: number, coinId: string) => {
        const key = `${userId}_${coinId}`;
        const amount = editingBalances[key];
        if (amount === undefined) return;

        setSavingBalance(key);
        try {
            const res = await (await import('../../../shared/api/admin-users')).updateCoinBalance(userId, coinId, amount);
            if (res.ok) {
                // Atualizar dados locais para refletir a mudança
                if (data) {
                    const nextRanking = data.ranking.map(u => {
                        if (u.user_id === userId) {
                            return { ...u, balances: { ...u.balances, [coinId]: amount } };
                        }
                        return u;
                    });
                    setData({ ...data, ranking: nextRanking });
                }
                const nextEditing = { ...editingBalances };
                delete nextEditing[key];
                setEditingBalances(nextEditing);
            } else {
                alert('Erro ao salvar saldo: ' + res.error);
            }
        } catch (err: unknown) {
            alert('Erro de rede: ' + err.message);
        } finally {
            setSavingBalance(null);
        }
    };

    const [bulkAmount, setBulkAmount] = useState<number>(0);
    const [isBulkUpdating, setIsBulkUpdating] = useState(false);

    const handleBulkUpdate = async () => {
        if (bulkAmount === 0) return;
        const activeCoin = selectedCoin;
        if (activeCoin === 'ALL') return;

        const info = data?.coins.find(c => c.id === activeCoin);
        const confirmMsg = bulkAmount > 0
            ? `Adicionar ${bulkAmount} ${info?.symbol} ao saldo de TODOS os mineradores ativos desta moeda?`
            : `Remover ${Math.abs(bulkAmount)} ${info?.symbol} do saldo de TODOS os mineradores ativos desta moeda?`;

        if (!window.confirm(confirmMsg)) return;

        setIsBulkUpdating(true);
        try {
            const res = await (await import('../../../shared/api/admin-users')).bulkUpdateCoinBalance(activeCoin, bulkAmount);
            if (res.ok) {
                alert(`Sucesso! ${res.count} jogadores tiveram seu saldo atualizado.`);
                // Recarregar ranking para mostrar novos saldos
                const json = isPublic ? await (await import('../../../shared/api/admin-users')).getPublicRanking() : await (await import('../../../shared/api/admin-users')).getAdminRanking();
                setData(json);
                setBulkAmount(0);
            } else {
                alert('Erro na atualização em massa: ' + res.error);
            }
        } catch (err: unknown) {
            alert('Erro de rede: ' + err.message);
        } finally {
            setIsBulkUpdating(false);
        }
    };

    if (loading) return <div className="p-8 text-white">Carregando ranking...</div>;
    if (error) return <div className="p-8 text-red-500">Erro: {error}</div>;
    if (!data) return null;

    const { list, activeCoin } = getSortedRanking();
    const totalPower = list.reduce((acc, curr) => acc + curr.power, 0);
    const activeCoinInfo = data.coins.find(c => c.id === activeCoin);
    const isGlobal = activeCoin === 'ALL';
    const showBalanceCol = !isPublic && !isGlobal;

    return (
        <div className="min-h-screen bg-[#1a1b26] text-white p-6 font-sans">
            <div className="max-w-6xl mx-auto">
                <div className="flex justify-between items-center mb-8">
                    <div className="flex flex-col gap-1">
                        <h1 className="text-3xl font-bold bg-gradient-to-r from-amber-400 to-orange-700 bg-clip-text text-transparent">
                            {isGlobal ? 'Ranking Global de Mineradores' : `Ranking ${activeCoinInfo?.name} (${activeCoinInfo?.symbol})`}
                        </h1>
                        <p className="text-gray-400 text-sm">
                            Organizado por {rankingMode === 'POWER' ? 'Poder de Mineração' : 'Saldo Acumulado'}
                            {rankingMode === 'POWER' &&
                              ' — global e POWER por moeda usam generalCoins (exclui Sala ASICs/NFT); moedas exclusivas NFT não têm poder geral.'}
                        </p>
                    </div>

                    {!isPublic && !isGlobal && (
                        <div className="flex bg-[#16161e] p-1 rounded-xl border border-gray-800">
                            <button
                                onClick={() => {
                                    setRankingMode('POWER');
                                    const meta = data?.coins.find((c) => c.id === selectedCoin);
                                    if (meta && isNftRoomExclusiveMiningCoin(meta)) {
                                        setSelectedCoin('ALL');
                                    }
                                }}
                                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${rankingMode === 'POWER' ? 'bg-orange-600 text-white shadow-lg shadow-orange-500/20' : 'text-gray-400 hover:text-white'}`}
                            >
                                RANK PODER
                            </button>
                            <button
                                onClick={() => setRankingMode('BALANCE')}
                                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${rankingMode === 'BALANCE' ? 'bg-orange-600 text-white shadow-lg shadow-orange-500/20' : 'text-gray-400 hover:text-white'}`}
                            >
                                RANK SALDO
                            </button>
                        </div>
                    )}

                    <div className="text-right">
                        <div className="text-sm text-gray-400">Total Listados</div>
                        <div className="text-xl font-bold text-white">{list.length}</div>
                    </div>
                </div>

                {/* Coin Selector */}
                <div className="flex flex-wrap gap-2 mb-8 bg-[#16161e] p-2 rounded-xl border border-gray-800">
                    <button
                        onClick={() => setSelectedCoin('ALL')}
                        className={`px-4 py-2 rounded-lg transition font-medium ${selectedCoin === 'ALL'
                            ? 'bg-orange-600 text-white shadow-lg shadow-orange-500/20'
                            : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                            }`}
                    >
                        Global (Geral)
                    </button>
                    {data.coins
                        .slice()
                        .filter((c) => rankingMode !== 'POWER' || !isNftRoomExclusiveMiningCoin(c))
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map(coin => (
                            <button
                                key={coin.id}
                                onClick={() => setSelectedCoin(coin.id)}
                                className={`px-4 py-2 rounded-lg transition font-medium ${selectedCoin === coin.id
                                    ? 'bg-orange-600 text-white shadow-lg shadow-orange-500/20'
                                    : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                                    }`}
                            >
                                {coin.name} ({coin.symbol})
                            </button>
                        ))}
                </div>

                {/* Stats Card */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                    <div className="bg-[#16161e] p-6 rounded-2xl border border-gray-800 flex items-center gap-4 relative overflow-hidden group">
                        <div className="absolute right-0 top-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                            <span className="text-6xl">⚡</span>
                        </div>
                        <div className="p-3 bg-orange-500/10 rounded-full text-orange-400 text-2xl">⚡</div>
                        <div>
                            <div className="text-gray-400 text-sm">{isGlobal ? 'Poder Global Acumulado' : `Poder Total (${activeCoinInfo?.symbol})`}</div>
                            <div className="text-2xl font-bold text-white">
                                {totalPower.toLocaleString(undefined, { maximumFractionDigits: 0 })} <span className="text-xs font-normal text-gray-500">{isGlobal ? 'Pts' : 'Hash/s'}</span>
                            </div>
                        </div>
                    </div>

                    <div className="bg-[#16161e] p-6 rounded-2xl border border-gray-800 flex items-center gap-4 relative overflow-hidden group">
                        <div className="absolute right-0 top-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                            <span className="text-6xl">📊</span>
                        </div>
                        <div className="p-3 bg-amber-500/10 rounded-full text-amber-400 text-2xl">📊</div>
                        <div>
                            <div className="text-gray-400 text-sm">Média por Jogador</div>
                            <div className="text-2xl font-bold text-white">
                                {(list.length > 0 ? totalPower / list.length : 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} <span className="text-xs font-normal text-gray-500">{isGlobal ? 'Pts' : 'Hash/s'}</span>
                            </div>
                        </div>
                    </div>

                    <div className="bg-[#16161e] p-6 rounded-2xl border border-gray-800 flex items-center gap-4 relative overflow-hidden group">
                        <div className="absolute right-0 top-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                            <span className="text-6xl">🌍</span>
                        </div>
                        <div className="p-3 bg-green-500/10 rounded-full text-green-400 text-2xl">🌍</div>
                        <div>
                            <div className="text-gray-400 text-sm">Mineração Ativa</div>
                            <div className="text-2xl font-bold text-white">
                                {list.length} <span className="text-xs font-normal text-gray-500">Jogadores</span>
                            </div>
                            <div className="text-xs text-green-500 mt-1">{isGlobal ? 'Em qualquer moeda' : `Em ${activeCoinInfo?.name}`}</div>
                        </div>
                    </div>

                    <div className="bg-[#16161e] p-6 rounded-2xl border border-gray-800 flex flex-col justify-center relative overflow-hidden">
                        <div className="text-gray-400 text-xs mb-2 font-bold uppercase tracking-wider">Médias por Moeda</div>
                        <div className="space-y-1 overflow-y-auto max-h-24 pr-1 scrollbar-thin scrollbar-thumb-gray-700">
                            {data.coins
                                .map(c => {
                                    const cUsers = data.ranking
                                        .map(u => u.generalCoins?.[c.id] ?? 0)
                                        .filter(p => p > 0);
                                    const cTotal = cUsers.reduce((a, b) => a + b, 0);
                                    const cAvg = cUsers.length > 0 ? cTotal / cUsers.length : 0;
                                    return { ...c, avg: cAvg };
                                })
                                .filter(c => !isGlobal || !isNftRoomExclusiveMiningCoin(c))
                                .sort((a, b) => b.avg - a.avg)
                                .map(c => (
                                    <div key={c.id} className="flex justify-between text-xs">
                                        <span className="text-gray-300">{c.symbol}:</span>
                                        <span className="text-white font-mono">{c.avg.toLocaleString(undefined, { notation: 'compact' })}</span>
                                    </div>
                                ))}
                        </div>
                    </div>
                </div>

                {/* Bulk Actions (Admin only) */}
                {showBalanceCol && list.length > 0 && (
                    <div className="mb-6 bg-gradient-to-r from-amber-900/20 to-orange-900/20 p-6 rounded-2xl border border-amber-500/30 shadow-lg shadow-amber-500/5">
                        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                            <div>
                                <h3 className="text-lg font-bold text-amber-400">Ações em Massa: {activeCoinInfo?.name}</h3>
                                <p className="text-sm text-gray-400">Adicione ou remova saldo de todos os {list.length} mineradores ativos desta moeda.</p>
                            </div>
                            <div className="flex items-center gap-3">
                                <div className="relative">
                                    <input
                                        type="number"
                                        value={bulkAmount}
                                        onChange={(e) => setBulkAmount(parseFloat(e.target.value) || 0)}
                                        placeholder="Valor..."
                                        className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-right text-white font-mono focus:border-amber-500 outline-none w-40"
                                    />
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs font-bold font-mono">
                                        {bulkAmount > 0 ? '+' : ''}
                                    </span>
                                    <p className="absolute -bottom-5 right-0 text-[10px] text-gray-400 font-medium">
                                        Dica: use valores negativos para remover
                                    </p>
                                </div>
                                <button
                                    onClick={handleBulkUpdate}
                                    disabled={bulkAmount === 0 || isBulkUpdating}
                                    className="bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-bold px-6 py-3 rounded-xl transition shadow-lg shadow-amber-500/20 flex items-center gap-2 whitespace-nowrap"
                                >
                                    {isBulkUpdating ? (
                                        <>
                                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                            APLICANDO...
                                        </>
                                    ) : (
                                        <>APLICAR A TODOS</>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Table */}
                <div className="bg-[#16161e] rounded-2xl border border-gray-800 overflow-hidden shadow-xl">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-[#1f2937] text-gray-400 text-sm uppercase tracking-wider">
                                <th className="p-4 w-24 text-center">#</th>
                                <th className="p-4">Usuário</th>
                                <th className="p-4 text-right">{isGlobal ? 'Poder Total (Soma)' : 'Poder de Mineração'}</th>
                                {showBalanceCol && <th className="p-4 text-right">Saldo</th>}
                                <th className="p-4 text-right w-48">% do Total</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800">
                            {list.length === 0 ? (
                                <tr>
                                    <td colSpan={showBalanceCol ? 5 : 4} className="p-8 text-center text-gray-500">
                                        Nenhum minerador ativo encontrado.
                                    </td>
                                </tr>
                            ) : (
                                list.map((user, index) => {
                                    const share = totalPower > 0 ? (user.power / totalPower) * 100 : 0;
                                    const balanceKey = `${user.user_id}_${activeCoin}`;
                                    const currentBalance = user.balances?.[activeCoin] || 0;
                                    const isEditing = editingBalances[balanceKey] !== undefined;
                                    const displayBalance = isEditing ? editingBalances[balanceKey] : currentBalance;

                                    return (
                                        <tr key={user.user_id} className="hover:bg-gray-800/50 transition duration-150">
                                            <td className="p-4 text-center font-mono text-gray-500">
                                                {index + 1}
                                            </td>
                                            <td className="p-4 font-medium text-white">
                                                {user.username}
                                                {index === 0 && <span className="ml-2 text-yellow-500">👑</span>}
                                                {index === 1 && <span className="ml-2 text-gray-400">🥈</span>}
                                                {index === 2 && <span className="ml-2 text-orange-700">🥉</span>}
                                            </td>
                                            <td className="p-4 text-right font-mono text-orange-300">
                                                {user.power.toLocaleString()} <span className="text-xs text-gray-600">{isGlobal ? 'Pts' : ''}</span>
                                            </td>
                                            {showBalanceCol && (
                                                <td className="p-4 text-right">
                                                    <div className="flex items-center justify-end gap-2">
                                                        <input
                                                            type="number"
                                                            value={displayBalance}
                                                            onChange={(e) => setEditingBalances({ ...editingBalances, [balanceKey]: parseFloat(e.target.value) || 0 })}
                                                            className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-right text-sm text-green-400 w-32 font-mono focus:border-green-500 outline-none"
                                                        />
                                                        {isEditing && (
                                                            <button
                                                                onClick={() => handleSaveBalance(user.user_id, activeCoin)}
                                                                disabled={savingBalance === balanceKey}
                                                                className="bg-green-600 hover:bg-green-500 text-white text-[10px] font-bold px-2 py-1 rounded transition disabled:opacity-50"
                                                            >
                                                                {savingBalance === balanceKey ? '...' : 'SALVAR'}
                                                            </button>
                                                        )}
                                                    </div>
                                                </td>
                                            )}
                                            <td className="p-4 text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    <span className="text-sm text-gray-400 w-12">{share.toFixed(2)}%</span>
                                                    <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                                        <div
                                                            className="h-full bg-orange-500"
                                                            style={{ width: `${share}%` }}
                                                        />
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};
