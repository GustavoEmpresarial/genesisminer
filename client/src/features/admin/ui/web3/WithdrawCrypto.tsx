// @ts-nocheck — template legado 1:1.
import React, { useEffect, useState, useCallback } from 'react';
import { Send, PlusCircle, RefreshCw, Wallet, ShieldCheck, Database } from 'lucide-react';
import { getWeb3Settings, setWeb3Settings } from '../../../../shared/api/wallet';
import { getMiningCoins } from '../../../../shared/api/admin-economy';
import { MiningCoin } from '../../lib/adminTypes';
import { findWithdrawTokenCfg } from '../../../../shared/utils/withdrawTokenMatch';

type TokenCfg = {
  name: string;
  symbol?: string;
  coinId?: string;
  network?: 'polygon' | 'bnb' | 'base';
  contract: string;
  payoutWallet: string;
  minAmount?: number;
  minWithdrawalUsdc?: number;
  feePercent?: number;
  disabled?: boolean;
};

type Web3WithdrawProps = { readOnly?: boolean };

export const Web3Withdraw: React.FC<Web3WithdrawProps> = ({ readOnly = false }) => {
  const [payoutWallet, setPayoutWallet] = useState('');
  const [withdrawTokens, setWithdrawTokens] = useState<TokenCfg[]>([]);
  const [miningCoins, setMiningCoins] = useState<MiningCoin[]>([]);
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [loadingCoins, setLoadingCoins] = useState(false);
  const [checkingBalance, setCheckingBalance] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** Rascunho de campos numéricos (evita apagar ao digitar, ex. taxa 0% → 1.5%). */
  const [numericDraft, setNumericDraft] = useState<Record<string, string>>({});

  const numericDraftKey = (coinId: string, field: string) => `${coinId}:${field}`;

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    setLoadingCoins(true);
    const [settings, coins] = await Promise.all([
      getWeb3Settings(),
      getMiningCoins()
    ]);

    if (settings) {
      setPayoutWallet(settings.payoutWallet || '');
      const wt = Array.isArray(settings.withdrawTokens) ? settings.withdrawTokens : [];
      setWithdrawTokens(wt);
    }

    if (coins) {
      setMiningCoins(coins);
    }
    setNumericDraft({});
    setLoadingCoins(false);
  };

  const getNetworkInfo = (network?: string, symbol?: string) => {
    const netName = String(network || '').trim().toLowerCase();
    const s = symbol?.toUpperCase();
    if (netName === 'base' || ['ETH', 'WETH', 'SOL'].includes(s || '')) {
      return {
        chainId: '0x2105',
        chainName: 'Base Mainnet',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: ['https://mainnet.base.org'],
        blockExplorerUrls: ['https://basescan.org']
      };
    }
    if (netName === 'bnb' || s === 'BNB') {
      return {
        chainId: '0x38',
        chainName: 'BNB Smart Chain',
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
        rpcUrls: ['https://bsc-dataseed.binance.org'],
        blockExplorerUrls: ['https://bscscan.com']
      };
    }
    // Default to Polygon for everything else (Pol, etc.)
    return {
      chainId: '0x89',
      chainName: 'Polygon Mainnet',
      nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
      rpcUrls: ['https://polygon-rpc.com'],
      blockExplorerUrls: ['https://polygonscan.com']
    };
  };

  const connectWallet = async (network?: string, symbol?: string): Promise<string | null> => {
    try {
      const eth = (window as any).ethereum;
      if (!eth) {
        alert("Carteira (MetaMask) não detectada!");
        return null;
      }
      const accounts = await eth.request({ method: 'eth_requestAccounts' });
      const addr = accounts && accounts[0];
      if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return null;

      if (network || symbol) {
        const net = getNetworkInfo(network, symbol);
        const chainId = await eth.request({ method: 'eth_chainId' });
        if (chainId !== net.chainId) {
          try {
            await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: net.chainId }] });
          } catch (switchError: any) {
            if (switchError.code === 4902) {
              try {
                await eth.request({
                  method: 'wallet_addEthereumChain', params: [net]
                });
              } catch { }
            }
          }
        }
      }
      return addr;
    } catch {
      return null;
    }
  };

  const handleConnectPayoutWallet = async () => {
    const addr = await connectWallet();
    if (addr) setPayoutWallet(addr);
  };

  const checkBalance = async (coinName: string, wallet: string, contract?: string, network?: string) => {
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) return;

    const eth = (window as any).ethereum;
    if (!eth) return;

    setCheckingBalance(coinName);
    try {
      const net = getNetworkInfo(network, coinName);
      const chainId = await eth.request({ method: 'eth_chainId' });
      if (chainId !== net.chainId) {
        try {
          await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: net.chainId }] });
        } catch (switchError: any) {
          if (switchError.code === 4902) {
            try {
              await eth.request({ method: 'wallet_addEthereumChain', params: [net] });
            } catch {
              setBalances(prev => ({ ...prev, [coinName]: 'Rede incorreta' }));
              return;
            }
          } else {
            setBalances(prev => ({ ...prev, [coinName]: 'Rede incorreta' }));
            return;
          }
        }
      }

      let balanceHex = '0x0';
      const isNative = !contract || contract.trim() === '';

      if (isNative) {
        // Native balance (ETH on Base, POL on Poly, BNB on BSC)
        balanceHex = await eth.request({
          method: 'eth_getBalance',
          params: [wallet, 'latest']
        });
      } else {
        // ERC20 balance
        const cleanWallet = wallet.toLowerCase().replace('0x', '');
        const data = '0x70a08231' + cleanWallet.padStart(64, '0');
        balanceHex = await eth.request({
          method: 'eth_call',
          params: [{ to: contract, data }, 'latest']
        });
      }

      const balInt = BigInt(balanceHex);
      const formatted = (Number(balInt) / 1e18).toFixed(6);
      setBalances(prev => ({ ...prev, [coinName]: formatted }));
    } catch (err) {
      console.error('Balance check failed', err);
      setBalances(prev => ({ ...prev, [coinName]: 'Erro' }));
    } finally {
      setCheckingBalance(null);
    }
  };

  const handleSave = async () => {
    if (readOnly) return;
    setSaving(true);
    const s = await getWeb3Settings();
    const mergedTokens = withdrawTokens.map((t) => {
      const c = miningCoins.find(
        (mc) =>
          mc.id === t.coinId ||
          mc.symbol === t.name ||
          (t.symbol && mc.symbol === t.symbol)
      );
      if (!c) return { ...t, symbol: t.symbol || t.name };
      return { ...t, coinId: c.id, symbol: c.symbol, name: t.name || c.symbol };
    });
    const deduped: TokenCfg[] = [];
    for (const t of mergedTokens) {
      const c = miningCoins.find((mc) => mc.id === t.coinId || mc.symbol === t.symbol || mc.symbol === t.name);
      const idx = c
        ? deduped.findIndex((d) => findWithdrawTokenCfg([d], c) != null)
        : deduped.findIndex((d) => d.name === t.name && d.symbol === t.symbol);
      if (idx >= 0) deduped[idx] = { ...deduped[idx], ...t };
      else deduped.push(t);
    }
    await setWeb3Settings({
      ...s!,
      payoutWallet,
      withdrawTokens: deduped,
    });
    setWithdrawTokens(deduped);
    setNumericDraft({});
    setSaving(false);
    setSavedAt(Date.now());
  };

  const updateTokenCfg = (
    coin: Pick<MiningCoin, 'id' | 'symbol' | 'name'>,
    field: keyof TokenCfg,
    value: unknown
  ) => {
    if (readOnly) return;
    setWithdrawTokens((prev) => {
      const idx = prev.findIndex((t) => findWithdrawTokenCfg([t], coin) != null);
      if (idx >= 0) {
        return prev.map((t, i) =>
          i === idx
            ? {
                ...t,
                [field]: value,
                coinId: coin.id,
                symbol: coin.symbol,
                name: t.name || coin.symbol
              }
            : t
        );
      }
      const newCfg: TokenCfg = {
        name: coin.symbol,
        symbol: coin.symbol,
        coinId: coin.id,
        contract: '',
        network: undefined,
        payoutWallet,
        minAmount: undefined,
        minWithdrawalUsdc: undefined,
        feePercent: undefined
      };
      return [...prev, { ...newCfg, [field]: value }];
    });
  };

  return (
    <div className="space-y-6">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Send size={18} className="text-green-400" />
            <h3 className="font-bold text-white">Configuração Global de Carteira</h3>
          </div>
          <button onClick={loadAll} className="text-slate-400 hover:text-white transition-colors">
            <RefreshCw size={16} className={loadingCoins ? 'animate-spin' : ''} />
          </button>
        </div>

        <p className="text-xs text-slate-400 mb-3">Defina a carteira padrão para pagamentos (pode ser alterada por moeda abaixo).</p>

        <div className="flex items-center gap-2 mb-2">
          {!readOnly && (
            <button onClick={handleConnectPayoutWallet} className="bg-green-900/30 hover:bg-green-900/50 border border-green-700 text-green-300 text-xs font-bold px-3 py-2 rounded transition-colors flex items-center gap-2">
              <Wallet size={14} /> Conectar carteira
            </button>
          )}
          {payoutWallet && <span className="text-[10px] font-mono text-slate-400 truncate bg-slate-900 px-2 py-1 rounded border border-slate-700">{payoutWallet}</span>}
        </div>

        <input
          type="text"
          readOnly={readOnly}
          value={payoutWallet}
          onChange={(e) => setPayoutWallet(e.target.value)}
          placeholder="0x..."
          className={`w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm focus:border-green-500 outline-none ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
        />
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <Database size={18} className="text-amber-400" />
          <h3 className="font-bold text-white">Carteiras por Moeda Minerada</h3>
        </div>
        <p className="text-xs text-slate-400 mb-4">Configure os endereços de saque e verifique o saldo disponível para cada moeda ativa.</p>

        <div className="space-y-4">
          {loadingCoins ? (
            <div className="py-10 text-center text-slate-500 text-sm italic">Carregando moedas...</div>
          ) : miningCoins.length === 0 ? (
            <div className="py-10 text-center text-slate-500 text-sm italic">Nenhuma moeda minerável ativa encontrada.</div>
          ) : (
            miningCoins.map((coin) => {
              const cfg =
                findWithdrawTokenCfg(withdrawTokens, coin) || {
                  name: coin.symbol,
                  symbol: coin.symbol,
                  coinId: coin.id,
                  contract: '',
                  payoutWallet,
                  minAmount: undefined
                };
              const balance = balances[coin.symbol];

              return (
                <div key={coin.id} className="bg-slate-900/50 border border-slate-700 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border" style={{ borderColor: coin.color, color: coin.color, backgroundColor: `${coin.color}15` }}>
                        {coin.symbol[0]}
                      </div>
                      <div>
                        <span className="text-white font-bold block">{coin.name}</span>
                        <span className="text-[10px] text-slate-500 uppercase">{coin.algorithm}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="flex flex-col items-end mr-2">
                        <span className="text-[10px] text-slate-500 font-bold mb-1">STATUS SAQUE</span>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            className="sr-only peer"
                            disabled={readOnly}
                            checked={!cfg.disabled}
                            onChange={(e) => updateTokenCfg(coin, 'disabled', !e.target.checked)}
                          />
                          <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-green-600"></div>
                          <span className="ms-2 text-[10px] font-bold text-slate-400 uppercase">{!cfg.disabled ? 'Ativado' : 'Desativado'}</span>
                        </label>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] text-slate-500 block">SALDO DISPONÍVEL</span>
                        <span className={`text-sm font-mono font-bold ${balance === 'Erro' ? 'text-red-400' : 'text-green-400'}`}>
                          {balance || '---'} {coin.symbol}
                        </span>
                      </div>
                      <button
                        onClick={() => checkBalance(coin.symbol, cfg.payoutWallet || payoutWallet, cfg.contract, cfg.network)}
                        disabled={checkingBalance === coin.symbol}
                        className="p-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-300 transition-colors"
                      >
                        <RefreshCw size={14} className={checkingBalance === coin.symbol ? 'animate-spin' : ''} />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-slate-800">
                    <div className="md:col-span-2">
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[10px] text-slate-500 font-bold block uppercase">Carteira de Pagamento ({coin.symbol})</label>
                        {!readOnly && (
                          <button
                            onClick={async () => {
                              const addr = await connectWallet(cfg.network, coin.symbol);
                              if (addr) updateTokenCfg(coin, 'payoutWallet', addr);
                            }}
                            className="text-[10px] text-green-400 hover:text-green-300 font-bold flex items-center gap-1 transition-colors"
                          >
                            <Wallet size={10} /> Conectar Individual
                          </button>
                        )}
                      </div>
                      <input
                        type="text"
                        readOnly={readOnly}
                        value={cfg.payoutWallet}
                        onChange={(e) => updateTokenCfg(coin, 'payoutWallet', e.target.value)}
                        placeholder={payoutWallet || "0x..."}
                        className={`w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs font-mono focus:border-green-500/50 outline-none ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 font-bold block mb-1 uppercase">Rede</label>
                      <select
                        disabled={readOnly}
                        value={cfg.network || ''}
                        onChange={(e) => updateTokenCfg(coin, 'network', e.target.value || undefined)}
                        className={`w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
                      >
                        <option value="">Auto</option>
                        <option value="polygon">Polygon</option>
                        <option value="bnb">BNB Chain</option>
                        <option value="base">Base</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 font-bold block mb-1 uppercase">Contrato (Opcional Token)</label>
                      <input
                        type="text"
                        readOnly={readOnly}
                        value={cfg.contract}
                        onChange={(e) => updateTokenCfg(coin, 'contract', e.target.value)}
                        placeholder="Vazio para moeda nativa"
                        className={`w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs font-mono ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 font-bold block mb-1">SAQUE MÍN. (USDC)</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        readOnly={readOnly}
                        value={
                          numericDraft[numericDraftKey(coin.id, 'minWithdrawalUsdc')] ??
                          (typeof cfg.minWithdrawalUsdc === 'number' ? String(cfg.minWithdrawalUsdc) : '')
                        }
                        onChange={(e) => {
                          setNumericDraft((prev) => ({
                            ...prev,
                            [numericDraftKey(coin.id, 'minWithdrawalUsdc')]: e.target.value
                          }));
                        }}
                        onBlur={(e) => {
                          const raw = e.target.value.trim().replace(',', '.');
                          const v = parseFloat(raw);
                          updateTokenCfg(
                            coin,
                            'minWithdrawalUsdc',
                            raw === '' || !Number.isFinite(v) ? undefined : Math.max(0, v)
                          );
                          setNumericDraft((prev) => {
                            const next = { ...prev };
                            delete next[numericDraftKey(coin.id, 'minWithdrawalUsdc')];
                            return next;
                          });
                        }}
                        placeholder="Ex: 5.00"
                        className={`w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
                      />
                      {cfg.minWithdrawalUsdc != null &&
                        cfg.minWithdrawalUsdc > 0 &&
                        (() => {
                          const rate =
                            typeof coin.usdcRate === 'number' && coin.usdcRate > 0
                              ? coin.usdcRate
                              : coin.priceUSD > 0
                                ? coin.priceUSD
                                : 0;
                          if (!(rate > 0)) return null;
                          return (
                            <span className="text-[9px] text-amber-500 mt-1 block">
                              ≈ {(cfg.minWithdrawalUsdc! / rate).toLocaleString('en-US', {
                                maximumFractionDigits: 6
                              })}{' '}
                              {coin.symbol} (bruto, alinhado ao servidor)
                            </span>
                          );
                        })()}
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 font-bold block mb-1">TAXA DE SAQUE (%)</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        readOnly={readOnly}
                        value={
                          numericDraft[numericDraftKey(coin.id, 'feePercent')] ??
                          (typeof cfg.feePercent === 'number' ? String(cfg.feePercent) : '')
                        }
                        onChange={(e) => {
                          setNumericDraft((prev) => ({
                            ...prev,
                            [numericDraftKey(coin.id, 'feePercent')]: e.target.value
                          }));
                        }}
                        onBlur={(e) => {
                          const raw = e.target.value.trim().replace(',', '.');
                          const v = parseFloat(raw);
                          updateTokenCfg(
                            coin,
                            'feePercent',
                            raw === '' || !Number.isFinite(v) ? undefined : Math.max(0, v)
                          );
                          setNumericDraft((prev) => {
                            const next = { ...prev };
                            delete next[numericDraftKey(coin.id, 'feePercent')];
                            return next;
                          });
                        }}
                        placeholder="Ex: 1.5 (0 = sem taxa)"
                        className={`w-full bg-slate-950 border border-slate-700 rounded p-2 text-white text-xs ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
                      />
                    </div>

                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {!readOnly && (
        <div className="flex justify-end gap-3 sticky bottom-4 z-10">
          <button
            onClick={handleSave}
            disabled={saving}
            className={`px-6 py-2 rounded-lg text-sm font-bold border shadow-lg transition-all flex items-center gap-2 ${saving ? 'bg-slate-700 text-slate-400 border-slate-700' : 'bg-green-600 text-white border-green-500 hover:bg-green-500 hover:scale-105 active:scale-95'}`}
          >
            {saving ? <RefreshCw size={16} className="animate-spin" /> : <ShieldCheck size={18} />}
            {saving ? 'SALVANDO...' : 'SALVAR TODAS AS CONFIGURAÇÕES'}
          </button>
          {savedAt && (
            <div className="bg-slate-900 border border-green-500/30 text-green-400 text-[10px] px-3 py-2 rounded-lg flex items-center shadow-md">
              CONFIGURAÇÕES ATUALIZADAS!
            </div>
          )}
        </div>
      )}
    </div>
  );
};
