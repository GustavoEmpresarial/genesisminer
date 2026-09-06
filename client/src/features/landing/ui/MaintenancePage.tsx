import React from 'react';

type Props = {
  onAdminLogin?: () => void;
  showLogin?: boolean;
};

export const MaintenancePage: React.FC<Props> = ({ onAdminLogin, showLogin }) => {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-slate-50 px-6 text-center dark:bg-[#0f0c08]">
      <p className="font-mono text-xs uppercase tracking-[0.25em] text-amber-600 dark:text-amber-400">Genesis Miner</p>
      <h1 className="mt-4 text-2xl font-bold text-slate-900 dark:text-white">Site em manutenção</h1>
      <p className="mt-2 max-w-md text-sm text-slate-600 dark:text-slate-400">
        Estamos a actualizar o jogo. Volta daqui a pouco.
      </p>
      {showLogin && onAdminLogin ? (
        <button
          type="button"
          onClick={onAdminLogin}
          className="mt-8 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 dark:border-slate-600 dark:text-slate-200"
        >
          Admin login
        </button>
      ) : null}
    </div>
  );
};
