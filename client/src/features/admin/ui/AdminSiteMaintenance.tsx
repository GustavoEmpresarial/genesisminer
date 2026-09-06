import React, { useState } from 'react';
import { getSiteStatus, setSiteMaintenance } from '../../../shared/api/site-maintenance';

export const AdminSiteMaintenance: React.FC = () => {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  React.useEffect(() => {
    void getSiteStatus().then((s) => setOn(s.maintenance));
  }, []);

  const toggle = async () => {
    setBusy(true);
    const next = !on;
    const out = await setSiteMaintenance(next);
    setBusy(false);
    if (!out.ok) {
      setMsg(out.error || 'Falhou.');
      return;
    }
    setOn(next);
    setMsg(next ? 'Manutenção ligada.' : 'Manutenção desligada.');
  };

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <h3 className="text-sm font-bold uppercase tracking-wide">Manutenção do site</h3>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Fecha landing e jogo para jogadores. Admins continuam a entrar.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void toggle()}
        className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {on ? 'Desligar manutenção' : 'Ligar manutenção'}
      </button>
      {msg ? <p className="text-xs text-slate-500">{msg}</p> : null}
    </div>
  );
};
