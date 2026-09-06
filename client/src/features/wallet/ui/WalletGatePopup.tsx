import React from 'react';

type Props = {
  open: boolean;
  onDismiss: () => void;
  onConnect: () => void;
};

export const WalletGatePopup: React.FC<Props> = ({ open, onDismiss, onConnect }) => {
  if (!open) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 max-w-xs rounded-xl border border-amber-400 bg-slate-900 p-3 text-white shadow-lg">
      <p className="text-sm font-semibold">Liga a carteira para jogar.</p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={onConnect} className="rounded bg-amber-500 px-2 py-1 text-xs font-bold text-slate-900">
          Ligar
        </button>
        <button type="button" onClick={onDismiss} className="rounded px-2 py-1 text-xs text-slate-300">
          Depois
        </button>
      </div>
    </div>
  );
};
