import { useCallback, useEffect, useState } from 'react';
import { Loader2, Save, SlidersHorizontal } from 'lucide-react';
import {
  getAdminTransparencyHealthSettings,
  putAdminTransparencyHealthSettings,
  TRANSPARENCY_HEALTH_SETTINGS_DEFAULTS,
  type TransparencyHealthPeriodScope,
  type TransparencyHealthSettings
} from '../../../shared/api/admin-legacy';
import { currentPeriodYmUtc, normalizePeriodYm } from '../../transparency/lib/periodYm';

const SCOPES: { id: TransparencyHealthPeriodScope; label: string; hint: string }[] = [
  {
    id: 'season',
    label: 'Temporada',
    hint: 'Só lançamentos do mês de início da temporada em diante. Alinha com a janela dos depósitos on-chain.'
  },
  {
    id: 'all_time',
    label: 'Tudo',
    hint: 'Soma lançamentos de todos os meses contra os depósitos da temporada. É o que fazia antes.'
  },
  {
    id: 'current_month',
    label: 'Mês corrente',
    hint: 'Só lançamentos do mês atual (UTC).'
  }
];

/** ms → `AAAA-MM` para o input de mês. */
function msToPeriodYm(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return currentPeriodYmUtc();
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `AAAA-MM` → ms do primeiro instante UTC desse mês. */
function periodYmToMs(ym: string): number | null {
  const norm = normalizePeriodYm(ym);
  if (!norm) return null;
  const [y, m] = norm.split('-').map(Number);
  return Date.UTC(y, m - 1, 1, 0, 0, 0, 0);
}

function weightSum(s: TransparencyHealthSettings): number {
  return s.weightInflow + s.weightRent + s.weightLedger;
}

type Props = {
  /** Chamado após gravar, para o painel recarregar o snapshot do servidor. */
  onSaved?: () => void;
};

export function AdminTransparencyHealthSettings({ onSaved }: Props) {
  const [form, setForm] = useState<TransparencyHealthSettings>(TRANSPARENCY_HEALTH_SETTINGS_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const res = await getAdminTransparencyHealthSettings();
      if (res.ok) setForm(res.settings);
      else setMsg({ kind: 'err', text: res.error || 'Não foi possível ler as definições.' });
      setLoading(false);
    })();
  }, []);

  const set = useCallback(<K extends keyof TransparencyHealthSettings>(
    key: K,
    value: TransparencyHealthSettings[K]
  ) => {
    setForm((f) => ({ ...f, [key]: value }));
    setMsg(null);
  }, []);

  const sum = weightSum(form);
  const sumOk = Math.abs(sum - 1) <= 1e-3;
  const overrideOk = !form.overrideEnabled || form.overrideValue != null;
  const canSave = !saving && !loading && sumOk && overrideOk;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    const res = await putAdminTransparencyHealthSettings(form);
    setSaving(false);
    if (!res.ok) {
      setMsg({ kind: 'err', text: res.error || 'Falha ao guardar.' });
      return;
    }
    setForm(res.settings);
    setMsg({ kind: 'ok', text: 'Guardado. O índice foi recalculado.' });
    onSaved?.();
  };

  if (loading) {
    return (
      <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-4 flex items-center gap-2 text-slate-400 text-sm">
        <Loader2 size={16} className="animate-spin" />
        A carregar definições da saúde…
      </div>
    );
  }

  const numberField = (
    label: string,
    key: 'weightInflow' | 'weightRent' | 'weightLedger',
    hint: string
  ) => (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase font-bold tracking-wider text-slate-400">{label}</span>
      <input
        type="number"
        min={0}
        max={1}
        step={0.05}
        value={form[key]}
        onChange={(e) => set(key, Number(e.target.value))}
        className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100"
      />
      <span className="text-[10px] text-slate-500">{hint}</span>
    </label>
  );

  return (
    <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-4 space-y-4">
      <div className="flex items-center gap-2 text-amber-400/90">
        <SlidersHorizontal size={16} />
        <h3 className="text-sm font-bold uppercase tracking-wider">Definições da saúde do jogo</h3>
      </div>

      {/* --- âmbito dos lançamentos --- */}
      <div className="space-y-2">
        <p className="text-[11px] uppercase font-bold tracking-wider text-slate-400">
          Que lançamentos entram no cálculo
        </p>
        <div className="flex flex-wrap gap-2">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => set('periodScope', s.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                form.periodScope === s.id
                  ? 'bg-amber-600/25 border-amber-500/60 text-amber-200'
                  : 'bg-slate-900 border-slate-600 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-slate-500">
          {SCOPES.find((s) => s.id === form.periodScope)?.hint}
        </p>

        <div className="flex flex-wrap items-end gap-4 pt-1">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase font-bold tracking-wider text-slate-400">
              Início da temporada
            </span>
            <input
              type="month"
              value={msToPeriodYm(form.seasonStartMs)}
              onChange={(e) => {
                const ms = periodYmToMs(e.target.value);
                if (ms != null) set('seasonStartMs', ms);
              }}
              className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100"
            />
            <span className="text-[10px] text-slate-500">
              Vale para os depósitos/saques on-chain e para o âmbito «Temporada».
            </span>
          </label>

          <label className="flex items-center gap-2 pb-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={form.countUndated}
              onChange={(e) => set('countUndated', e.target.checked)}
              className="accent-amber-500"
            />
            Contar lançamentos sem mês («Geral»)
          </label>
        </div>
      </div>

      {/* --- pesos e piso --- */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-2 border-t border-slate-700/70">
        {numberField('Peso · quanto entra', 'weightInflow', 'Depósitos vs saques on-chain.')}
        {numberField('Peso · rentabilização', 'weightRent', 'Margem entre entradas e saídas.')}
        {numberField('Peso · portal', 'weightLedger', 'Pool + trade − despesas publicadas.')}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase font-bold tracking-wider text-slate-400">Piso</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={form.floor}
            onChange={(e) => set('floor', Math.round(Number(e.target.value)))}
            className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100"
          />
          <span className="text-[10px] text-slate-500">O índice público nunca desce disto.</span>
        </label>
      </div>

      {!sumOk ? (
        <p className="text-xs text-rose-300">
          Os três pesos têm de somar 1 — somam {sum.toFixed(3)}.
        </p>
      ) : (
        <p className="text-[10px] text-slate-500">Soma dos pesos: {sum.toFixed(2)} ✓</p>
      )}

      {/* --- override --- */}
      <div className="pt-2 border-t border-slate-700/70 space-y-2">
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={form.overrideEnabled}
            onChange={(e) => set('overrideEnabled', e.target.checked)}
            className="accent-amber-500"
          />
          <span className="font-bold">Fixar a saúde à mão</span>
        </label>
        {form.overrideEnabled ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase font-bold tracking-wider text-slate-400">
                Valor publicado (0–100)
              </span>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={form.overrideValue ?? ''}
                onChange={(e) => {
                  const raw = e.target.value;
                  set('overrideValue', raw === '' ? null : Math.round(Number(raw)));
                }}
                className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 w-32"
              />
            </label>
            <p className="text-[10px] text-slate-500 max-w-md pb-2">
              Substitui o número calculado em todo o lado (painel, página pública e badge do topo).
              Os sub-scores continuam a mostrar os valores reais. Fica registado quem alterou.
            </p>
          </div>
        ) : null}
        {!overrideOk ? (
          <p className="text-xs text-rose-300">Indique o valor a fixar, ou desligue a opção.</p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-bold text-white hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          Guardar
        </button>
        <button
          type="button"
          onClick={() => {
            setForm((f) => ({
              ...TRANSPARENCY_HEALTH_SETTINGS_DEFAULTS,
              updatedAt: f.updatedAt,
              updatedBy: f.updatedBy
            }));
            setMsg(null);
          }}
          disabled={saving}
          className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-bold text-slate-300 hover:bg-slate-700 disabled:opacity-50"
        >
          Repor valores por omissão
        </button>
        {msg ? (
          <span className={`text-xs ${msg.kind === 'ok' ? 'text-emerald-300' : 'text-rose-300'}`}>
            {msg.text}
          </span>
        ) : null}
        {form.updatedAt > 0 ? (
          <span className="text-[10px] text-slate-500 ml-auto">
            Última alteração: {new Date(form.updatedAt).toLocaleString('pt-BR')}
            {form.updatedBy ? ` · admin #${form.updatedBy}` : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}
