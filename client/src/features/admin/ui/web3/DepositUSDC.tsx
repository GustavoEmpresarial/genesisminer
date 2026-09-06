// @ts-nocheck — template legado 1:1.
import React, { useEffect, useState } from 'react';
import { Wallet, Hexagon } from 'lucide-react';
import { getWeb3Settings, setWeb3Settings } from '../../../../shared/api/wallet';

type Web3DepositProps = { readOnly?: boolean };

export const Web3Deposit: React.FC<Web3DepositProps> = ({ readOnly = false }) => {
  const [depositWallet, setDepositWallet] = useState('');
  const [depositTokenContract, setDepositTokenContract] = useState('');
  const [depositTokenContractBnb, setDepositTokenContractBnb] = useState('');
  const [depositTokenContractBase, setDepositTokenContractBase] = useState('');
  const [depositPolygonDisabled, setDepositPolygonDisabled] = useState(false);
  const [depositBnbDisabled, setDepositBnbDisabled] = useState(false);
  const [depositBaseDisabled, setDepositBaseDisabled] = useState(false);
  const [minDepositUsdc, setMinDepositUsdc] = useState<number | ''>('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const s = await getWeb3Settings();
      if (s) {
        setDepositWallet(s.depositWallet || '');
        setDepositTokenContract(s.depositTokenContract || '');
        setDepositTokenContractBnb(s.depositTokenContractBnb || '');
        setDepositTokenContractBase(s.depositTokenContractBase || '');
        setDepositPolygonDisabled(!!s.depositPolygonDisabled);
        setDepositBnbDisabled(!!s.depositBnbDisabled);
        setDepositBaseDisabled(!!s.depositBaseDisabled);
        if (typeof s.minDepositUsdc === 'number') setMinDepositUsdc(s.minDepositUsdc);
      }
    })();
  }, []);

  const connectWallet = async (): Promise<string | null> => {
    try {
      const eth = (window as any).ethereum;
      if (!eth) return null;
      const accounts = await eth.request({ method: 'eth_requestAccounts' });
      const addr = accounts && accounts[0];
      if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return null;
      try {
        const chainId = await eth.request({ method: 'eth_chainId' });
        if (chainId !== '0x89') {
          try {
            await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] });
          } catch {
            try {
              await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x89', chainName: 'Polygon Mainnet', nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 }, rpcUrls: ['https://polygon-rpc.com'], blockExplorerUrls: ['https://polygonscan.com'] }] });
            } catch { }
          }
        }
      } catch { }
      return addr;
    } catch {
      return null;
    }
  };

  const handleConnectDepositWallet = async () => {
    const addr = await connectWallet();
    if (addr) setDepositWallet(addr);
  };

  const handleSave = async () => {
    if (readOnly) return;
    setSaving(true);
    const s = await getWeb3Settings();
    await setWeb3Settings({
      ...s!,
      depositWallet,
      depositTokenContract,
      depositTokenContractBnb,
      depositTokenContractBase,
      depositPolygonDisabled,
      depositBnbDisabled,
      depositBaseDisabled,
      minDepositUsdc: typeof minDepositUsdc === 'number' ? minDepositUsdc : undefined,
    });
    setSaving(false);
    setSavedAt(Date.now());
  };

  return (
    <div className="space-y-6">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <Wallet size={18} className="text-amber-400" />
          <h3 className="font-bold text-white">Depósito (USDC)</h3>
        </div>
        <p className="text-xs text-slate-400 mb-3">Endereço para onde USDC será enviado quando jogadores depositarem.</p>
        <div className="flex items-center gap-2 mb-2">
          {!readOnly && (
            <button onClick={handleConnectDepositWallet} className="bg-amber-900/30 hover:bg-amber-900/50 border border-amber-700 text-amber-300 text-xs font-bold px-3 py-2 rounded transition-colors">Conectar carteira</button>
          )}
          {depositWallet && <span className="text-[10px] font-mono text-slate-400 truncate">{depositWallet}</span>}
        </div>
        <input
          type="text"
          readOnly={readOnly}
          value={depositWallet}
          onChange={(e) => setDepositWallet(e.target.value)}
          placeholder="0x..."
          className={`w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
        />
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-2">
            <Hexagon size={16} className="text-amber-400" />
            <span className="text-xs text-slate-300 font-bold">Contrato do USDC</span>
          </div>
          <input
            type="text"
            readOnly={readOnly}
            value={depositTokenContract}
            onChange={(e) => setDepositTokenContract(e.target.value)}
            placeholder="0x... (Polygon)"
            className={`w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
          />
          <div className="flex items-center gap-2 mt-1">
            <input
              type="checkbox"
              id="poly_disable"
              disabled={readOnly}
              checked={depositPolygonDisabled}
              onChange={(e) => setDepositPolygonDisabled(e.target.checked)}
              className="rounded border-slate-600 bg-slate-900 text-amber-500 focus:ring-amber-500"
            />
            <label htmlFor="poly_disable" className="text-[10px] text-slate-400 font-bold uppercase cursor-pointer">Desativar Depósitos na Polygon</label>
          </div>

          <div className="flex items-center gap-2 mt-4 mb-2">
            <Hexagon size={16} className="text-yellow-500" />
            <span className="text-xs text-slate-300 font-bold">Contrato USDC (BNB Chain)</span>
          </div>
          <input
            type="text"
            readOnly={readOnly}
            value={depositTokenContractBnb}
            onChange={(e) => setDepositTokenContractBnb(e.target.value)}
            placeholder="0x... (BNB Chain)"
            className={`w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
          />
          <div className="flex items-center gap-2 mt-1">
            <input
              type="checkbox"
              id="bnb_disable"
              disabled={readOnly}
              checked={depositBnbDisabled}
              onChange={(e) => setDepositBnbDisabled(e.target.checked)}
              className="rounded border-slate-600 bg-slate-900 text-yellow-500 focus:ring-yellow-500"
            />
            <label htmlFor="bnb_disable" className="text-[10px] text-slate-400 font-bold uppercase cursor-pointer">Desativar Depósitos na BNB Chain</label>
          </div>

          <div className="flex items-center gap-2 mt-4 mb-2">
            <Hexagon size={16} className="text-amber-500" />
            <span className="text-xs text-slate-300 font-bold">Contrato USDC (BASE Chain)</span>
          </div>
          <input
            type="text"
            readOnly={readOnly}
            value={depositTokenContractBase}
            onChange={(e) => setDepositTokenContractBase(e.target.value)}
            placeholder="0x... (BASE)"
            className={`w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
          />
          <div className="flex items-center gap-2 mt-1">
            <input
              type="checkbox"
              id="base_disable"
              disabled={readOnly}
              checked={depositBaseDisabled}
              onChange={(e) => setDepositBaseDisabled(e.target.checked)}
              className="rounded border-slate-600 bg-slate-900 text-amber-500 focus:ring-amber-500"
            />
            <label htmlFor="base_disable" className="text-[10px] text-slate-400 font-bold uppercase cursor-pointer">Desativar Depósitos na BASE</label>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <div>
              <span className="text-xs text-slate-300 font-bold">Depósito mínimo (USDC)</span>
              <input
                type="number"
                min={0}
                step={0.001}
                readOnly={readOnly}
                value={typeof minDepositUsdc === 'number' ? String(minDepositUsdc) : ''}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setMinDepositUsdc(isNaN(v) ? '' : Math.max(0, v));
                }}
                placeholder="0.001"
                className={`w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm ${readOnly ? 'opacity-70 cursor-not-allowed' : ''}`}
              />
            </div>
          </div>
        </div>
      </div>

      {!readOnly && (
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className={`px-4 py-2 rounded text-sm font-bold border transition-colors ${saving ? 'bg-slate-700 text-slate-400 border-slate-700' : 'bg-amber-900/30 text-amber-300 border-amber-700 hover:bg-amber-900/50'}`}
          >
            {saving ? 'Salvando...' : 'Salvar Configurações'}
          </button>
          {savedAt && <span className="text-[10px] text-slate-500 ml-3 self-center">Salvo</span>}
        </div>
      )}
    </div>
  );
};
