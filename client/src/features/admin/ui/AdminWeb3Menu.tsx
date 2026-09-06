// @ts-nocheck — template legado 1:1.
import React, { useMemo, useState } from 'react';
import { Web3Deposit } from './web3/DepositUSDC';
import { Web3Withdraw } from './web3/WithdrawCrypto';
import { AdminExchange } from './AdminExchange';
import { RefreshCcw } from 'lucide-react';
import type { User } from '../lib/adminTypes';

type AdminWeb3MenuProps = {
  currentUser?: User | null;
};

export const AdminWeb3Menu: React.FC<AdminWeb3MenuProps> = ({ currentUser = null }) => {
  const [subtab, setSubtab] = useState<'deposit' | 'withdraw' | 'exchange'>('deposit');

  const web3ReadOnly = useMemo(
    () => !!(currentUser?.isAdmin && !currentUser?.isSuperAdmin),
    [currentUser?.isAdmin, currentUser?.isSuperAdmin]
  );

  return (
    <div className="space-y-6">
      {web3ReadOnly && (
        <div className="text-xs text-amber-200/90 bg-amber-950/50 border border-amber-800/60 rounded-lg px-4 py-3">
          <strong>Modo leitura</strong> — como operador admin podes consultar as configurações Web3; apenas{' '}
          <strong>super administradores</strong> podem guardar alterações.
        </div>
      )}
      <div className="flex items-center gap-2 border-b border-slate-700 pb-3 overflow-x-auto">
        <button
          onClick={() => setSubtab('deposit')}
          className={`px-3 py-2 text-xs font-bold rounded border whitespace-nowrap ${subtab === 'deposit' ? 'bg-slate-800 text-white border-slate-700' : 'text-slate-400 hover:text-white border-transparent hover:border-slate-700'}`}
        >
          Depósito (USDC)
        </button>
        <button
          onClick={() => setSubtab('withdraw')}
          className={`px-3 py-2 text-xs font-bold rounded border whitespace-nowrap ${subtab === 'withdraw' ? 'bg-slate-800 text-white border-slate-700' : 'text-slate-400 hover:text-white border-transparent hover:border-slate-700'}`}
        >
          Saque (Crypto)
        </button>
        <button
          onClick={() => setSubtab('exchange')}
          className={`px-3 py-2 text-xs font-bold rounded border whitespace-nowrap flex items-center gap-2 ${subtab === 'exchange' ? 'bg-slate-800 text-yellow-500 border-slate-700' : 'text-slate-400 hover:text-white border-transparent hover:border-slate-700'}`}
        >
          <RefreshCcw size={14} /> Exchange
        </button>
      </div>

      {subtab === 'deposit' && <Web3Deposit readOnly={web3ReadOnly} />}
      {subtab === 'withdraw' && <Web3Withdraw readOnly={web3ReadOnly} />}
      {subtab === 'exchange' && <AdminExchange readOnly={web3ReadOnly} />}
    </div>
  );
};
