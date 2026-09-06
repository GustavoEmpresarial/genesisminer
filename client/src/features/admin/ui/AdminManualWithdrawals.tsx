// @ts-nocheck — template legado 1:1.
import React, { useState, useEffect } from 'react';
import { getWithdrawalRequests, updateWithdrawalStatus } from '../../../shared/api/admin-legacy';
import { getWeb3Settings } from '../../../shared/api/wallet';
import { Web3Settings } from '../lib/adminTypes';
import { findWithdrawTokenCfg } from '../../../shared/utils/withdrawTokenMatch';

import { Search, Filter, CheckCircle, XCircle, Clock, Wallet, DollarSign, Coins, ExternalLink, RefreshCw } from 'lucide-react';

export const AdminManualWithdrawals: React.FC = () => {
    const [requests, setRequests] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'completed' | 'rejected'>('all');
    const [processingId, setProcessingId] = useState<string | null>(null);
    const [web3Settings, setWeb3Settings] = useState<Web3Settings | null>(null);


    const loadRequests = async () => {
        setLoading(true);
        try {
            const data = await getWithdrawalRequests();
            setRequests(data);
        } catch (err) {
            console.error('Failed to load withdrawals:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadRequests();
        (async () => {
            const settings = await getWeb3Settings();
            setWeb3Settings(settings);
        })();
    }, []);


    const handleStatusUpdate = async (requestId: string, status: 'completed' | 'rejected') => {
        if (!confirm(`Tem certeza que deseja marcar esta solicitação como ${status === 'completed' ? 'CONCLUÍDA' : 'REJEITADA'}?`)) {
            return;
        }

        setProcessingId(requestId);
        try {
            const res = await updateWithdrawalStatus(requestId, status);
            if (res.ok) {
                alert(res.message);
                loadRequests();
            } else {
                alert(res.error || 'Erro ao atualizar status');
            }
        } catch (err) {
            alert('Erro de conexão');
        } finally {
            setProcessingId(null);
        }
    };

    const filteredRequests = requests.filter(req => {
        const matchesSearch =
            req.username?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            req.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            req.walletAddress?.toLowerCase().includes(searchTerm.toLowerCase());

        const matchesStatus = statusFilter === 'all' || req.status === statusFilter;

        return matchesSearch && matchesStatus;
    });

    const getNetworkInfo = (network?: string, symbol?: string) => {
        const net = String(network || '').trim().toLowerCase();
        const s = symbol?.toUpperCase() || '';
        if (net === 'bnb' || ['BNB', 'DOGE', 'TRX'].includes(s)) {
            return {
                name: 'BNB Smart Chain',
                id: 56,
                hex: '0x38',
                explorer: 'https://bscscan.com',
                rpc: 'https://bsc-dataseed.binance.org/'
            };
        }
        if (net === 'base' || ['SOL', 'ETH', 'WETH'].includes(s)) {
            return {
                name: 'Base',
                id: 8453,
                hex: '0x2105',
                explorer: 'https://basescan.org',
                rpc: 'https://mainnet.base.org'
            };
        }
        return {
            name: 'Polygon',
            id: 137,
            hex: '0x89',
            explorer: 'https://polygonscan.com',
            rpc: 'https://polygon-rpc.com'
        };
    };

    const switchNetwork = async (eth: any, network: any) => {
        try {
            await eth.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: network.hex }],
            });
        } catch (switchError: any) {
            // This error code indicates that the chain has not been added to MetaMask.
            if (switchError.code === 4902) {
                try {
                    await eth.request({
                        method: 'wallet_addEthereumChain',
                        params: [{
                            chainId: network.hex,
                            chainName: network.name,
                            nativeCurrency: {
                                name: network.name.split(' ')[0],
                                symbol: network.name.split(' ')[0],
                                decimals: 18
                            },
                            rpcUrls: [network.rpc],
                            blockExplorerUrls: [network.explorer]
                        }],
                    });
                } catch (addError) {
                    throw new Error("Falha ao adicionar rede na MetaMask");
                }
            } else {
                throw switchError;
            }
        }
    };

    const handleWeb3Payout = async (req: any) => {
        const eth = (window as any).ethereum;
        if (!eth) {
            alert("MetaMask não encontrada!");
            return;
        }

        const tokenConfig = findWithdrawTokenCfg(web3Settings?.withdrawTokens, {
            id: req.coinId,
            symbol: req.coinSymbol
        });
        if (tokenConfig?.disabled) {
            alert(`Configuração de saque desativada para ${req.coinSymbol}`);
            return;
        }
        if (!tokenConfig) {
            alert(`Configuração de saque não encontrada ou desativada para ${req.coinSymbol}`);
            return;
        }

        const network = getNetworkInfo(tokenConfig.network, req.coinSymbol);
        const isNative = ['POL', 'BNB', 'ETH'].includes(req.coinSymbol?.toUpperCase());
        const contract = tokenConfig.contract;

        if (!isNative && !/^0x[a-fA-F0-9]{40}$/.test(contract)) {
            alert("Contrato do token inválido!");
            return;
        }

        const amountToPay = typeof req.netAmount === 'number' && req.netAmount > 0 ? req.netAmount : req.amountCrypto;
        if (!confirm(`Deseja iniciar o pagamento de ${amountToPay.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${req.coinSymbol} para ${req.walletAddress}?\n\n(Valor Líquido deduzido de taxas)`)) {
            return;
        }

        setProcessingId(req.id);
        try {
            // Switch network if needed
            await switchNetwork(eth, network);

            const accounts = await eth.request({ method: 'eth_requestAccounts' });
            const from = accounts[0];

            let txParams: any = {
                from,
                to: isNative ? req.walletAddress : contract,
                value: '0x0',
                data: '0x'
            };

            if (isNative) {
                // Native transfer (POL or BNB)
                const amountWei = BigInt(Math.floor(amountToPay * 1e18));
                txParams.value = '0x' + amountWei.toString(16);
            } else {
                // ERC20 transfer
                // 1. Get Decimals
                let decimals = 18;
                try {
                    const decRes = await eth.request({ method: 'eth_call', params: [{ to: contract, data: '0x313ce567' }, 'latest'] });
                    if (typeof decRes === 'string' && decRes.startsWith('0x')) {
                        const d = parseInt(decRes, 16);
                        if (!isNaN(d) && d > 0 && d < 36) decimals = d;
                    }
                } catch (e) { console.error("Error fetching decimals", e); }

                // 2. Prepare Transaction Data
                const amountBigInt = BigInt(Math.floor(amountToPay * Math.pow(10, decimals)));
                const toPadded = req.walletAddress.replace(/^0x/, '').toLowerCase().padStart(64, '0');
                const amountPadded = amountBigInt.toString(16).padStart(64, '0');
                txParams.data = '0xa9059cbb' + toPadded + amountPadded; // ERC20 transfer(address,uint256)
            }

            // 3. Send Transaction
            const txHash = await eth.request({
                method: 'eth_sendTransaction',
                params: [txParams]
            });

            if (txHash) {
                alert(`Transação enviada! Hash: ${txHash}\nO status será atualizado automaticamente após a confirmação.`);

                // Polling for receipt
                let success = false;
                for (let i = 0; i < 20; i++) {
                    await new Promise(r => setTimeout(r, 3000));
                    const receipt = await eth.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
                    if (receipt && (receipt.status === '0x1' || receipt.status === 1)) {
                        success = true;
                        break;
                    }
                }

                if (success) {
                    const res = await updateWithdrawalStatus(req.id, 'completed', txHash);
                    if (res.ok) {
                        alert("Saque concluído e status atualizado com sucesso!");
                        loadRequests();
                    } else {
                        alert("Pagamento enviado, mas falha ao atualizar status no banco: " + (res.error || 'Erro desconhecido'));
                    }
                } else {
                    alert("A transação parece ter falhado ou demorado muito. Por favor, verifique no explorador.");
                }
            }

        } catch (err: any) {
            console.error("Payout error:", err);
            alert("Erro no pagamento: " + (err.message || 'Erro de conexão'));
        } finally {
            setProcessingId(null);
        }
    };

    const formatDate = (ts: number) => {
        return new Date(ts).toLocaleString('pt-BR');
    };


    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'pending':
                return <span className="px-2 py-1 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 flex items-center gap-1"><Clock size={10} /> PENDENTE</span>;
            case 'completed':
                return <span className="px-2 py-1 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 flex items-center gap-1"><CheckCircle size={10} /> CONCLUÍDO</span>;
            case 'rejected':
                return <span className="px-2 py-1 rounded-full text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 flex items-center gap-1"><XCircle size={10} /> REJEITADO</span>;
            default:
                return <span className="px-2 py-1 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700">{status}</span>;
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm transition-colors">
                <div className="flex items-center gap-4 flex-1">
                    <div className="relative flex-1 max-w-md">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                        <input
                            type="text"
                            placeholder="Buscar por usuário, email ou carteira..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full pl-10 pr-4 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 transition-all"
                        />
                    </div>

                    <div className="flex items-center gap-2">
                        <Filter size={18} className="text-slate-400" />
                        <select
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value as any)}
                            className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-sm p-2 focus:outline-none focus:ring-2 focus:ring-amber-500 transition-all text-slate-700 dark:text-slate-300"
                        >
                            <option value="all">Todos os Status</option>
                            <option value="pending">Pendentes</option>
                            <option value="completed">Concluídos</option>
                            <option value="rejected">Rejeitados</option>
                        </select>
                    </div>
                </div>

                <button
                    onClick={loadRequests}
                    disabled={loading}
                    className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg text-sm font-bold transition-all shadow-lg shadow-amber-900/20 active:scale-95"
                >
                    <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                    {loading ? 'Atualizando...' : 'Atualizar'}
                </button>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm transition-colors">
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 text-[10px] uppercase tracking-wider font-bold">
                                <th className="px-6 py-4">Data</th>
                                <th className="px-6 py-4">Usuário</th>
                                <th className="px-6 py-4">Moeda / Valor</th>
                                <th className="px-6 py-4">Equiv. USDC</th>
                                <th className="px-6 py-4">Recebimento Líquido</th>
                                <th className="px-6 py-4">Carteira Destino</th>
                                <th className="px-6 py-4 text-center">Hash</th>
                                <th className="px-6 py-4">Status</th>
                                <th className="px-6 py-4 text-center">Ações</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {filteredRequests.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="px-6 py-12 text-center text-slate-500 dark:text-slate-400 text-sm italic">
                                        {loading ? 'Carregando solicitações...' : 'Nenhuma solicitação de saque encontrada.'}
                                    </td>
                                </tr>
                            ) : (
                                filteredRequests.map((req) => (
                                    <tr key={req.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
                                        <td className="px-6 py-4">
                                            <div className="text-xs font-mono text-slate-600 dark:text-slate-400">
                                                {formatDate(req.createdAt)}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex flex-col">
                                                <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{req.username}</span>
                                                <span className="text-[10px] text-slate-500">{req.email}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-2">
                                                <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-amber-600 dark:text-amber-400">
                                                    <Coins size={16} />
                                                </div>
                                                <div className="flex flex-col">
                                                    <span className="text-sm font-bold font-mono text-slate-700 dark:text-slate-200">
                                                        {req.amountCrypto.toLocaleString('en-US', { maximumFractionDigits: 8 })} {req.coinSymbol}
                                                    </span>
                                                    {req.feeAmount > 0 && (
                                                        <span className="text-[10px] font-bold text-red-500 flex items-center gap-0.5">
                                                            Taxa: -{req.feeAmount.toLocaleString('en-US', { maximumFractionDigits: 8 })}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-1 text-green-600 dark:text-green-400 font-mono font-bold text-sm">
                                                <DollarSign size={14} />
                                                {req.amountUsdc.toFixed(2)}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="text-sm font-black font-mono text-amber-600 dark:text-amber-400">
                                                {req.netAmount?.toLocaleString('en-US', { maximumFractionDigits: 8 })} {req.coinSymbol}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-2">
                                                <div className="text-[10px] font-mono text-slate-500 max-w-[120px] truncate bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded">
                                                    {req.walletAddress}
                                                </div>
                                                <a
                                                    href={`${getNetworkInfo(findWithdrawTokenCfg(web3Settings?.withdrawTokens, { id: req.coinId, symbol: req.coinSymbol })?.network, req.coinSymbol).explorer}/address/${req.walletAddress}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-slate-400 hover:text-amber-500 transition-colors"
                                                    title="Ver no explorador"
                                                >
                                                    <ExternalLink size={14} />
                                                </a>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-center">
                                            {req.txHash ? (
                                                <a
                                                    href={`${getNetworkInfo(findWithdrawTokenCfg(web3Settings?.withdrawTokens, { id: req.coinId, symbol: req.coinSymbol })?.network, req.coinSymbol).explorer}/tx/${req.txHash}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="flex items-center justify-center gap-1 text-[10px] font-mono text-amber-600 dark:text-amber-400 hover:underline"
                                                    title={req.txHash}
                                                >
                                                    {req.txHash.substring(0, 6)}...{req.txHash.substring(req.txHash.length - 4)}
                                                    <ExternalLink size={10} />
                                                </a>
                                            ) : (
                                                <span className="text-[10px] text-slate-400 italic">manual / pendente</span>
                                            )}
                                        </td>
                                        <td className="px-6 py-4">
                                            {getStatusBadge(req.status)}
                                        </td>
                                        <td className="px-6 py-4 text-center">
                                            {req.status === 'pending' ? (
                                                <div className="flex items-center justify-center gap-2">
                                                    <button
                                                        onClick={() => handleWeb3Payout(req)}
                                                        disabled={processingId === req.id}
                                                        className="p-2 rounded-lg bg-amber-100 text-amber-600 hover:bg-amber-600 hover:text-white dark:bg-amber-900/20 dark:text-amber-400 dark:hover:bg-amber-600 dark:hover:text-white transition-all active:scale-95 disabled:opacity-50"
                                                        title="Pagar via Web3"
                                                    >
                                                        <Wallet size={18} />
                                                    </button>
                                                    <button
                                                        onClick={() => handleStatusUpdate(req.id, 'completed')}
                                                        disabled={processingId === req.id}
                                                        className="p-2 rounded-lg bg-green-100 text-green-600 hover:bg-green-600 hover:text-white dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-600 dark:hover:text-white transition-all active:scale-95 disabled:opacity-50"
                                                        title="Marcar como Concluído (Manual)"
                                                    >
                                                        <CheckCircle size={18} />
                                                    </button>

                                                    <button
                                                        onClick={() => handleStatusUpdate(req.id, 'rejected')}
                                                        disabled={processingId === req.id}
                                                        className="p-2 rounded-lg bg-red-100 text-red-600 hover:bg-red-600 hover:text-white dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-600 dark:hover:text-white transition-all active:scale-95 disabled:opacity-50"
                                                        title="Rejeitar e Estornar"
                                                    >
                                                        <XCircle size={18} />
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="text-[10px] text-slate-400 italic">
                                                    Processado em {formatDate(req.processedAt)}
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};
