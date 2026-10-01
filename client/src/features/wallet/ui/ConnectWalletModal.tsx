import React from 'react';
import type { User } from '../../../shared/types/auth';

type Props = {
  open: boolean;
  onClose: () => void;
  onGoToProfile?: () => void;
  onUserUpdate?: (user: User) => void;
};

export const ConnectWalletModal: React.FC<Props> = ({ open, onClose, onGoToProfile }) => {
  if (!open) return null;
  const goProfile = () => {
    onGoToProfile?.();
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-4 dark:bg-slate-900">
        <p className="text-sm font-semibold">Ligar carteira</p>
        <p className="mt-2 text-xs text-slate-500">Abre a página Perfil para concluir a ligação SIWE.</p>
        <div className="mt-4 flex gap-2">
          {onGoToProfile ? (
            <button
              type="button"
              onClick={goProfile}
              className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-bold"
            >
              Ir ao Perfil
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-bold dark:border-slate-600"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};
