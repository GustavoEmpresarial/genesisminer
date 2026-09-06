// @ts-nocheck — template legado 1:1.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2, Save, Scale, Table2 } from 'lucide-react';
import { TransparencyCategory, TransparencyEntry } from '../lib/adminTypes';
import {
  adminCreateTransparencyEntry,
  adminDeleteTransparencyEntry,
  adminUpdateTransparencyEntry,
  getTransparency
} from '../../../shared/api/admin-legacy';
import { getTransparencyHealth, type TransparencyHealthSnapshot } from '../../../shared/api/transparency';
import { TRANSPARENCY_BODY_MAX, TRANSPARENCY_LINK_MAX, TRANSPARENCY_TITLE_MAX } from '../../../shared/constants/formLimits';
import { computeTransparencyHealth } from '../../transparency/lib/health';
import { TransparencyHealthBoard } from '../../transparency/ui/TransparencyHealthBoard';
import {
  collectPeriodYmOptions,
  currentPeriodYmUtc,
  filterEntriesByPeriodYm,
  formatPeriodYmLabel,
  normalizePeriodYm,
  sumTransparencySheet
} from '../../transparency/lib/periodYm';

const CATS: { id: TransparencyCategory; label: string }[] = [
  { id: 'pool', label: 'Pool / tesouraria' },
  { id: 'trade', label: 'Trade / marketplace' },
  { id: 'expense', label: 'Gasto / saída' },
  { id: 'investment', label: 'Investimento / entrada' },
  { id: 'other', label: 'Outras entradas (fora do cálculo)' }
];

const emptyForm = (periodYm: string | null) => ({
  category: 'pool' as TransparencyCategory,
  title: '',
  body: '',
  amountUsdc: '',
  linkUrl: '',
  sortOrder: '0',
  periodYm: periodYm ?? ''
});

function periodSelectValue(periodYm: string | null | undefined): string {
  return normalizePeriodYm(periodYm ?? null) ?? '';
}

export const AdminTransparency: React.FC = () => {
  const [rows, setRows] = useState<TransparencyEntry[]>([]);
  const [healthFromApi, setHealthFromApi] = useState<TransparencyHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(() => currentPeriodYmUtc());
  const [form, setForm] = useState(() => emptyForm(currentPeriodYmUtc()));
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<ReturnType<typeof emptyForm> | null>(null);
  const [newMonth, setNewMonth] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [list, health] = await Promise.all([
      getTransparency(),
      getTransparencyHealth().catch(() => null)
    ]);
    setRows(list);
    setHealthFromApi(health);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const periodOptions = useMemo(() => collectPeriodYmOptions(rows), [rows]);

  const sheetRows = useMemo(() => {
    const list = filterEntriesByPeriodYm(rows, selectedPeriod);
    return [...list].sort((a, b) =>
      a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.id - b.id
    );
  }, [rows, selectedPeriod]);

  const sheetTotals = useMemo(() => sumTransparencySheet(sheetRows), [sheetRows]);

  const healthSnapshot = useMemo(
    () => healthFromApi ?? computeTransparencyHealth(rows),
    [healthFromApi, rows]
  );

  const formatUsdc = useCallback((n: number) => {
    if (!Number.isFinite(n)) return '—';
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(n);
  }, []);

  const selectPeriod = (ym: string | null) => {
    setSelectedPeriod(ym);
    setForm((f) => ({ ...f, periodYm: ym ?? '' }));
    cancelEdit();
  };

  const addMonthTab = () => {
    const ym = normalizePeriodYm(newMonth);
    if (!ym) {
      alert('Indique o mês no formato AAAA-MM (ex: 2026-10).');
      return;
    }
    setNewMonth('');
    selectPeriod(ym);
  };

  const parseAmount = (raw: string, allowEmptyAsNull: boolean): number | null | undefined | false => {
    if (raw.trim() === '') return allowEmptyAsNull ? null : undefined;
    const n = Number(raw.replace(',', '.'));
    if (!Number.isFinite(n)) return false;
    return n;
  };

  const handleCreate = async () => {
    const title = form.title.trim();
    if (!title) {
      alert('Indique um título.');
      return;
    }
    const amount = parseAmount(form.amountUsdc, false);
    if (amount === false) {
      alert('Valor USDC inválido.');
      return;
    }
    setSaving(true);
    const res = await adminCreateTransparencyEntry({
      category: form.category,
      title,
      body: form.body.trim() || undefined,
      amountUsdc: amount,
      linkUrl: form.linkUrl.trim() || undefined,
      periodYm: normalizePeriodYm(form.periodYm) ,
      sortOrder: parseInt(form.sortOrder, 10) || 0
    });
    setSaving(false);
    if (res.ok === false) {
      alert(res.error || 'Erro ao criar.');
      return;
    }
    const keptPeriod = normalizePeriodYm(form.periodYm);
    setForm(emptyForm(keptPeriod));
    if (keptPeriod !== selectedPeriod) setSelectedPeriod(keptPeriod);
    await load();
  };

  const startEdit = (r: TransparencyEntry) => {
    setEditingId(r.id);
    setEditDraft({
      category: r.category,
      title: r.title,
      body: r.body || '',
      amountUsdc: r.amountUsdc != null && Number.isFinite(r.amountUsdc) ? String(r.amountUsdc) : '',
      linkUrl: r.linkUrl || '',
      sortOrder: String(r.sortOrder ?? 0),
      periodYm: periodSelectValue(r.periodYm)
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft(null);
  };

  const saveEdit = async () => {
    if (editingId == null || !editDraft) return;
    const title = editDraft.title.trim();
    if (!title) {
      alert('Indique um título.');
      return;
    }
    const amount = parseAmount(editDraft.amountUsdc, true);
    if (amount === false) {
      alert('Valor USDC inválido.');
      return;
    }
    setSaving(true);
    const nextPeriod = normalizePeriodYm(editDraft.periodYm);
    const res = await adminUpdateTransparencyEntry(editingId, {
      category: editDraft.category,
      title,
      body: editDraft.body.trim() || null,
      amountUsdc: amount,
      linkUrl: editDraft.linkUrl.trim() || null,
      periodYm: nextPeriod,
      sortOrder: parseInt(editDraft.sortOrder, 10) || 0
    });
    setSaving(false);
    if (res.ok === false) {
      alert(res.error || 'Erro ao salvar.');
      return;
    }
    cancelEdit();
    if (nextPeriod !== selectedPeriod) setSelectedPeriod(nextPeriod);
    await load();
  };

  const remove = async (id: number) => {
    if (!confirm('Remover este registro?')) return;
    setSaving(true);
    const res = await adminDeleteTransparencyEntry(id);
    setSaving(false);
    if (res.ok === false) {
      alert(res.error || 'Erro ao remover.');
      return;
    }
    if (editingId === id) cancelEdit();
    await load();
  };

  const periodLabel = (ym: string | null) => formatPeriodYmLabel(ym, 'pt-BR');

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3 border-b border-slate-700 pb-4">
        <Scale className="text-amber-500" size={28} />
        <div>
          <h2 className="text-xl font-bold text-white">Transparência (jogadores)</h2>
          <p className="text-xs text-slate-500">
            Planilha mês a mês. «Geral» = comunicados e ativos permanentes. Saúde do jogo continua a usar todos os
            lançamentos. Depósitos/saques on-chain desde 01/09/2026 00:00 UTC.
          </p>
        </div>
      </div>

      {!loading ? (
        <TransparencyHealthBoard snapshot={healthSnapshot} formatUsdc={formatUsdc} variant="admin" />
      ) : null}

      <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2 text-amber-400/90">
          <Table2 size={16} />
          <h3 className="text-sm font-bold uppercase tracking-wider">Planilha por mês</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          {periodOptions.map((ym) => {
            const on = selectedPeriod === ym;
            const count = filterEntriesByPeriodYm(rows, ym).length;
            return (
              <button
                key={ym ?? 'geral'}
                type="button"
                onClick={() => selectPeriod(ym)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${
                  on
                    ? 'border-amber-500 bg-amber-900/40 text-amber-100'
                    : 'border-slate-600 bg-slate-900 text-slate-300 hover:border-slate-500'
                }`}
              >
                {periodLabel(ym)}
                <span className="ml-1.5 text-[10px] opacity-70">({count})</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <label className="block text-[10px] uppercase text-slate-500 font-bold">
            Abrir / criar mês
            <input
              type="month"
              className="mt-1 block bg-slate-900 border border-slate-600 rounded-lg px-2 py-1.5 text-sm text-white"
              value={newMonth}
              onChange={(e) => setNewMonth(e.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={addMonthTab}
            className="rounded-lg bg-slate-700 hover:bg-slate-600 px-3 py-2 text-xs font-bold text-white"
          >
            Ir para mês
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-emerald-800/50 bg-emerald-950/20 p-3">
          <div className="text-[10px] uppercase text-emerald-400/80 font-bold">Entradas (pool+trade)</div>
          <div className="text-lg font-bold text-white tabular-nums">{formatUsdc(sheetTotals.inUsdc)}</div>
        </div>
        <div className="rounded-xl border border-orange-800/50 bg-orange-950/20 p-3">
          <div className="text-[10px] uppercase text-orange-400/80 font-bold">Saídas (despesas)</div>
          <div className="text-lg font-bold text-white tabular-nums">{formatUsdc(sheetTotals.outUsdc)}</div>
        </div>
        <div className="rounded-xl border border-slate-600 bg-slate-900/60 p-3">
          <div className="text-[10px] uppercase text-slate-400 font-bold">Líquido do mês</div>
          <div
            className={`text-lg font-bold tabular-nums ${
              sheetTotals.netUsdc >= 0 ? 'text-emerald-300' : 'text-red-300'
            }`}
          >
            {formatUsdc(sheetTotals.netUsdc)}
          </div>
        </div>
        <div className="rounded-xl border border-violet-800/40 bg-violet-950/20 p-3">
          <div className="text-[10px] uppercase text-violet-300/80 font-bold">Invest. / outras (info)</div>
          <div className="text-sm font-bold text-white tabular-nums">
            {formatUsdc(sheetTotals.investment)} / {formatUsdc(sheetTotals.other)}
          </div>
        </div>
      </div>

      <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-6 space-y-4">
        <h3 className="text-sm font-bold text-amber-500 uppercase tracking-wider">
          Novo lançamento · {periodLabel(normalizePeriodYm(form.periodYm))}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="block text-xs text-slate-400">
            Mês da planilha
            <select
              className="mt-1 w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
              value={periodSelectValue(form.periodYm)}
              onChange={(e) => setForm({ ...form, periodYm: e.target.value })}
            >
              <option value="">Geral / permanente</option>
              {periodOptions
                .filter((ym) => ym != null)
                .map((ym) => (
                  <option key={ym} value={ym!}>
                    {periodLabel(ym)}
                  </option>
                ))}
              {form.periodYm &&
              normalizePeriodYm(form.periodYm) &&
              !periodOptions.includes(normalizePeriodYm(form.periodYm)) ? (
                <option value={normalizePeriodYm(form.periodYm)!}>
                  {periodLabel(normalizePeriodYm(form.periodYm))}
                </option>
              ) : null}
            </select>
          </label>
          <label className="block text-xs text-slate-400">
            Categoria
            <select
              className="mt-1 w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value as TransparencyCategory })}
            >
              {CATS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-slate-400">
            Ordem (menor = primeiro)
            <input
              type="number"
              className="mt-1 w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
              value={form.sortOrder}
              onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
            />
          </label>
          <label className="block text-xs text-slate-400 md:col-span-3">
            Título
            <input
              className="mt-1 w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              maxLength={TRANSPARENCY_TITLE_MAX}
            />
          </label>
          <label className="block text-xs text-slate-400 md:col-span-3">
            Descrição (opcional)
            <textarea
              className="mt-1 w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white min-h-[80px]"
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              maxLength={TRANSPARENCY_BODY_MAX}
            />
          </label>
          <label className="block text-xs text-slate-400">
            Valor USDC (opcional)
            <input
              className="mt-1 w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
              value={form.amountUsdc}
              onChange={(e) => setForm({ ...form, amountUsdc: e.target.value })}
              placeholder="ex: 1500 ou vazio"
            />
          </label>
          <label className="block text-xs text-slate-400 md:col-span-2">
            Link https (opcional)
            <input
              className="mt-1 w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
              value={form.linkUrl}
              onChange={(e) => setForm({ ...form, linkUrl: e.target.value })}
              maxLength={TRANSPARENCY_LINK_MAX}
              placeholder="https://…"
            />
          </label>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={() => void handleCreate()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-bold disabled:opacity-50"
        >
          {saving ? <Loader2 className="animate-spin" size={18} /> : <Plus size={18} />}
          Adicionar à planilha
        </button>
      </div>

      <div className="bg-slate-800/80 border border-slate-700 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider">
            {periodLabel(selectedPeriod)}
          </h3>
          <span className="text-[10px] text-slate-500">{sheetRows.length} linha(s)</span>
        </div>
        {loading ? (
          <div className="flex justify-center py-12 text-slate-500">
            <Loader2 className="animate-spin" size={28} />
          </div>
        ) : sheetRows.length === 0 ? (
          <p className="text-sm text-slate-500 italic p-6">Nenhum lançamento neste mês. Adicione acima.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="bg-slate-900/80 text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-bold">Ord</th>
                  <th className="px-3 py-2 font-bold">Categoria</th>
                  <th className="px-3 py-2 font-bold">Título</th>
                  <th className="px-3 py-2 font-bold text-right">USDC</th>
                  <th className="px-3 py-2 font-bold">Link</th>
                  <th className="px-3 py-2 font-bold w-28">Ações</th>
                </tr>
              </thead>
              <tbody>
                {sheetRows.map((r) =>
                  editingId === r.id && editDraft ? (
                    <tr key={r.id} className="border-t border-slate-700 bg-slate-900/40 align-top">
                      <td className="px-2 py-2" colSpan={6}>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                          <select
                            className="bg-slate-950 border border-slate-600 rounded px-2 py-1.5 text-xs text-white"
                            value={periodSelectValue(editDraft.periodYm)}
                            onChange={(e) => setEditDraft({ ...editDraft, periodYm: e.target.value })}
                          >
                            <option value="">Geral / permanente</option>
                            {periodOptions
                              .filter((ym) => ym != null)
                              .map((ym) => (
                                <option key={ym} value={ym!}>
                                  {periodLabel(ym)}
                                </option>
                              ))}
                          </select>
                          <select
                            className="bg-slate-950 border border-slate-600 rounded px-2 py-1.5 text-xs text-white"
                            value={editDraft.category}
                            onChange={(e) =>
                              setEditDraft({ ...editDraft, category: e.target.value as TransparencyCategory })
                            }
                          >
                            {CATS.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                          <input
                            type="number"
                            className="bg-slate-950 border border-slate-600 rounded px-2 py-1.5 text-xs text-white"
                            value={editDraft.sortOrder}
                            onChange={(e) => setEditDraft({ ...editDraft, sortOrder: e.target.value })}
                          />
                          <input
                            className="md:col-span-3 bg-slate-950 border border-slate-600 rounded px-2 py-1.5 text-xs text-white"
                            value={editDraft.title}
                            onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })}
                          />
                          <textarea
                            className="md:col-span-3 bg-slate-950 border border-slate-600 rounded px-2 py-1.5 text-xs text-white min-h-[60px]"
                            value={editDraft.body}
                            onChange={(e) => setEditDraft({ ...editDraft, body: e.target.value })}
                          />
                          <input
                            className="bg-slate-950 border border-slate-600 rounded px-2 py-1.5 text-xs text-white"
                            value={editDraft.amountUsdc}
                            onChange={(e) => setEditDraft({ ...editDraft, amountUsdc: e.target.value })}
                            placeholder="USDC"
                          />
                          <input
                            className="md:col-span-2 bg-slate-950 border border-slate-600 rounded px-2 py-1.5 text-xs text-white"
                            value={editDraft.linkUrl}
                            onChange={(e) => setEditDraft({ ...editDraft, linkUrl: e.target.value })}
                            placeholder="https://"
                          />
                          <div className="md:col-span-3 flex gap-2">
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => void saveEdit()}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-green-700 hover:bg-green-600 text-white text-xs font-bold"
                            >
                              <Save size={14} /> Salvar
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              className="px-3 py-1.5 rounded bg-slate-700 text-xs text-white"
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={r.id} className="border-t border-slate-700/80 hover:bg-slate-900/40 align-top">
                      <td className="px-3 py-2 text-slate-500 font-mono text-xs">{r.sortOrder}</td>
                      <td className="px-3 py-2 text-amber-400/90 text-xs font-bold">
                        {CATS.find((c) => c.id === r.category)?.label || r.category}
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-white font-semibold">{r.title}</div>
                        {r.body ? (
                          <p className="text-[11px] text-slate-500 mt-1 whitespace-pre-wrap max-h-16 overflow-y-auto">
                            {r.body}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-slate-200 tabular-nums">
                        {r.amountUsdc != null && Number.isFinite(r.amountUsdc) ? formatUsdc(r.amountUsdc) : '—'}
                      </td>
                      <td className="px-3 py-2 text-[11px] text-slate-500 max-w-[160px] truncate">
                        {r.linkUrl || '—'}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={() => startEdit(r)}
                            className="px-2 py-1 rounded border border-slate-600 text-[10px] text-slate-200 hover:bg-slate-800"
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            onClick={() => void remove(r.id)}
                            className="p-1.5 rounded border border-red-900/50 text-red-400 hover:bg-red-950/40"
                            title="Remover"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
