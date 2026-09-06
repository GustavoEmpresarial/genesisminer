import React from 'react';
import type { User } from '../../../shared/types/auth';

type Props = {
  open: boolean;
  onClose: () => void;
  onUserUpdate?: (user: User) => void;
};

export const ConnectWalletModal: React.FC<Props> = ({ open, onClose }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-4 dark:bg-slate-900">
        <p className="text-sm font-semibold">Ligar carteira</p>
        <p className="mt-2 text-xs text-slate-500">Abre a página Carteira para concluir a ligação.</p>
        <button type="button" onClick={onClose} className="mt-4 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-bold">
          Fechar
        </button>
      </div>
    </div>
  );
};
