import React from 'react';

type Props = {
  onConnect?: () => void;
  className?: string;
};

export const WalletRoomLockOverlay: React.FC<Props> = ({ onConnect, className }) => (
  <div className={`flex flex-col items-center justify-center bg-slate-950/70 px-4 text-center ${className || ''}`}>
    <p className="text-sm font-semibold text-white">Liga a carteira para montar nesta sala.</p>
    {onConnect ? (
      <button
        type="button"
        onClick={onConnect}
        className="mt-3 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-bold text-slate-900"
      >
        Ligar carteira
      </button>
    ) : null}
  </div>
);
