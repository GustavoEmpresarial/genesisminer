// @ts-nocheck — template legado 1:1.
import React, { useCallback, useEffect, useState } from 'react';
import { ListChecks, Loader2, Save } from 'lucide-react';
import {
  getAdminQuests,
  saveAdminQuest,
  type AdminQuestDefinition
} from '../../../shared/api/admin-legacy';

export const AdminQuests: React.FC = () => {
  const [defs, setDefs] = useState<AdminQuestDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    const { definitions, error } = await getAdminQuests();
    setDefs(definitions);
    if (error) setMsg(error);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (id: string, patch: Partial<AdminQuestDefinition>) => {
    setDefs((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  const save = async (d: AdminQuestDefinition) => {
    setSavingId(d.id);
    setMsg(null);
    const { definition, error } = await saveAdminQuest({
      id: d.id,
      title: d.title,
      description: d.description,
      targetCount: d.target_count,
      rewardUsdc: d.reward_usdc,
      sortOrder: d.sort_order,
      enabled: d.enabled === 1
    });
    setSavingId(null);
    if (error) {
      setMsg(error);
      return;
    }
    if (definition) {
      setDefs((prev) => prev.map((x) => (x.id === definition.id ? definition : x)));
      setMsg(`Guardado: ${definition.id}`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ListChecks className="text-amber-400" size={20} />
        <div>
          <h3 className="text-white font-bold">Tarefas diárias / semanais</h3>
          <p className="text-xs text-slate-400">Check-in, merge e offerwall — metas e recompensas USDC.</p>
        </div>
      </div>
      {msg ? <p className="text-xs text-amber-300">{msg}</p> : null}
      {loading ? (
        <p className="text-sm text-slate-500 flex items-center gap-2">
          <Loader2 className="animate-spin" size={14} /> A carregar…
        </p>
      ) : (
        <div className="space-y-3">
          {defs.map((d) => (
            <div key={d.id} className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-mono text-slate-400">
                  {d.id} · {d.period} · {d.action_type}
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={d.enabled === 1}
                    onChange={(e) => patch(d.id, { enabled: e.target.checked ? 1 : 0 })}
                    className="accent-amber-500"
                  />
                  Activa
                </label>
              </div>
              <input
                className="w-full rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-white"
                value={d.title}
                onChange={(e) => patch(d.id, { title: e.target.value })}
              />
              <textarea
                className="w-full rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 min-h-[56px]"
                value={d.description}
                onChange={(e) => patch(d.id, { description: e.target.value })}
              />
              <div className="grid grid-cols-3 gap-2">
                <label className="text-[10px] text-slate-400 uppercase">
                  Meta
                  <input
                    type="number"
                    min={1}
                    className="mt-1 w-full rounded bg-slate-950 border border-slate-700 px-2 py-1 text-sm text-white"
                    value={d.target_count}
                    onChange={(e) => patch(d.id, { target_count: Number(e.target.value) || 1 })}
                  />
                </label>
                <label className="text-[10px] text-slate-400 uppercase">
                  Reward USDC
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    className="mt-1 w-full rounded bg-slate-950 border border-slate-700 px-2 py-1 text-sm text-white"
                    value={d.reward_usdc}
                    onChange={(e) => patch(d.id, { reward_usdc: Number(e.target.value) || 0 })}
                  />
                </label>
                <label className="text-[10px] text-slate-400 uppercase">
                  Ordem
                  <input
                    type="number"
                    className="mt-1 w-full rounded bg-slate-950 border border-slate-700 px-2 py-1 text-sm text-white"
                    value={d.sort_order}
                    onChange={(e) => patch(d.id, { sort_order: Number(e.target.value) || 0 })}
                  />
                </label>
              </div>
              <button
                type="button"
                disabled={savingId === d.id}
                onClick={() => void save(d)}
                className="inline-flex items-center gap-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-60 text-white text-xs font-bold px-3 py-2"
              >
                {savingId === d.id ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Guardar
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
