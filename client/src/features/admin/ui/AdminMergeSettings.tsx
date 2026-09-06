// @ts-nocheck — template legado 1:1.
import React, { useEffect, useState } from 'react';
import { Combine, Save } from 'lucide-react';
import { getAdminMergeSettings, putAdminMergeSettings, type MergeAdminSettings } from '../../../shared/api/admin-legacy';

const RARITY_KEYS = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
const RACK_BONUS_KEYS = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'supreme'] as const;

const DEFAULTS: MergeAdminSettings = {
  enabled: true,
  enabledMachine: true,
  enabledMultiplier: true,
  enabledInfrastructure: true,
  gainPercent: 5,
  costPctByRarity: {
    common: 10,
    uncommon: 15,
    rare: 20,
    epic: 25,
    legendary: 30
  },
  rackHsBonusPctByRarity: {
    common: 0,
    uncommon: 0,
    rare: 0,
    epic: 0,
    legendary: 0,
    supreme: 0
  }
};

const TYPE_TOGGLES: Array<{
  key: 'enabledMachine' | 'enabledMultiplier' | 'enabledInfrastructure';
  title: string;
  hint: string;
}> = [
  {
    key: 'enabledMachine',
    title: 'Merge de GPUs',
    hint: 'Tipo machine — aba GPUs no Merge Station.'
  },
  {
    key: 'enabledMultiplier',
    title: 'Merge de Chips IA',
    hint: 'Tipo multiplier — aba Chips IA no Merge Station.'
  },
  {
    key: 'enabledInfrastructure',
    title: 'Merge de Rigs',
    hint: 'Tipo infrastructure — aba Rigs (racks) no Merge Station.'
  }
];

export const AdminMergeSettings: React.FC = () => {
  const [form, setForm] = useState<MergeAdminSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const res = await getAdminMergeSettings();
      if (res.ok && res.settings) setForm(res.settings);
      setLoading(false);
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    const res = await putAdminMergeSettings(form);
    setSaving(false);
    if (!res.ok) {
      setMsg(res.error || 'Falha ao guardar.');
      return;
    }
    if (res.settings) setForm(res.settings);
    if (!form.enabled) {
      setMsg('Merge desativado e configuração guardada.');
      return;
    }
    const on: string[] = [];
    if (form.enabledMachine) on.push('GPUs');
    if (form.enabledMultiplier) on.push('Chips IA');
    if (form.enabledInfrastructure) on.push('Rigs');
    setMsg(
      on.length
        ? `Merge ativo (${on.join(', ')}) e configuração guardada.`
        : 'Merge global ativo, mas todos os tipos estão desligados — menu escondido aos jogadores.'
    );
  };

  if (loading) {
    return <div className="p-6 text-sm text-slate-400">A carregar Merge…</div>;
  }

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800 p-6 space-y-6">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-amber-500/15 p-2 text-amber-400">
          <Combine size={20} />
        </div>
        <div>
          <h3 className="text-white font-bold">Merge Station</h3>
          <p className="text-xs text-slate-400 mt-1">
            Ativa/desativa o Merge para jogadores (global e por tipo) e define ganho de poder, taxa USDC e
            bónus H/s das rigs por raridade. A raridade de cada GPU/Chip/Rig edita-se no Editor de Upgrades.
          </p>
        </div>
      </div>

      {msg && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
          {msg}
        </div>
      )}

      <label className="flex items-center justify-between gap-4 rounded-lg border border-slate-600 bg-slate-900/80 px-4 py-3 cursor-pointer">
        <div>
          <div className="text-sm font-bold text-white">Merge ativo</div>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Desligado: esconde o menu e bloqueia inventário/execução no servidor.
          </p>
        </div>
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          className="h-5 w-5 accent-amber-500"
        />
      </label>

      <div className={`space-y-2 ${form.enabled ? '' : 'opacity-50'}`}>
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Tipos de merge</h4>
        <p className="text-[11px] text-slate-500">
          Com o Merge global ligado, escolhe quais categorias ficam disponíveis aos jogadores.
        </p>
        {TYPE_TOGGLES.map((row) => (
          <label
            key={row.key}
            className={`flex items-center justify-between gap-4 rounded-lg border border-slate-600 bg-slate-900/80 px-4 py-3 ${
              form.enabled ? 'cursor-pointer' : 'cursor-not-allowed'
            }`}
          >
            <div>
              <div className="text-sm font-bold text-white">{row.title}</div>
              <p className="text-[11px] text-slate-500 mt-0.5">{row.hint}</p>
            </div>
            <input
              type="checkbox"
              checked={form[row.key]}
              disabled={!form.enabled}
              onChange={(e) => setForm({ ...form, [row.key]: e.target.checked })}
              className="h-5 w-5 accent-amber-500 disabled:opacity-40"
            />
          </label>
        ))}
      </div>

      <div>
        <label className="text-xs font-bold text-slate-400 block mb-1">Ganho de stats por merge (%)</label>
        <input
          type="number"
          min={0}
          max={100}
          step={0.1}
          value={form.gainPercent}
          onChange={(e) => setForm({ ...form, gainPercent: parseFloat(e.target.value) || 0 })}
          className="w-full max-w-xs bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm"
        />
        <p className="text-[11px] text-slate-500 mt-1">
          Ex.: 5 → resultado = (stat₁ + stat₂) × 1,05
        </p>
      </div>

      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
          Taxa USDC por raridade de origem (%)
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {RARITY_KEYS.map((key) => (
            <div key={key}>
              <label className="text-[11px] font-bold text-slate-500 uppercase block mb-1">{key}</label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={form.costPctByRarity[key]}
                onChange={(e) =>
                  setForm({
                    ...form,
                    costPctByRarity: {
                      ...form.costPctByRarity,
                      [key]: parseFloat(e.target.value) || 0
                    }
                  })
                }
                className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm"
              />
            </div>
          ))}
        </div>
        <p className="text-[11px] text-slate-500 mt-2">
          Taxa = (custo₁ + custo₂) × taxa% / 100. Supreme não mergeia.
        </p>
      </div>

      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
          Bónus H/s da rig merged (%) por raridade do resultado
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {RACK_BONUS_KEYS.map((key) => (
            <div key={key}>
              <label className="text-[11px] font-bold text-slate-500 uppercase block mb-1">{key}</label>
              <input
                type="number"
                min={0}
                max={500}
                step={0.1}
                value={form.rackHsBonusPctByRarity[key]}
                onChange={(e) =>
                  setForm({
                    ...form,
                    rackHsBonusPctByRarity: {
                      ...form.rackHsBonusPctByRarity,
                      [key]: parseFloat(e.target.value) || 0
                    }
                  })
                }
                className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-white text-sm"
              />
            </div>
          ))}
        </div>
        <p className="text-[11px] text-slate-500 mt-2">
          Ex.: uncommon = 10 → rig merged uncommon dá +10% H/s (soma com chips de IA).
        </p>
      </div>

      <button
        type="button"
        disabled={saving}
        onClick={() => void save()}
        className="inline-flex items-center gap-2 rounded-lg bg-amber-600 hover:bg-amber-500 px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
      >
        <Save size={14} />
        {saving ? 'A guardar…' : 'Guardar'}
      </button>
    </div>
  );
};
