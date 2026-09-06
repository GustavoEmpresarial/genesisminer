// @ts-nocheck — template legado 1:1.
import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Map, Plus, Save, Sparkles, Trash2, ToggleLeft, ToggleRight, Upload } from 'lucide-react';
import {
  adminCreateRoadmapStep,
  adminDeleteRoadmapStep,
  adminReorderRoadmapSteps,
  adminUpdateRoadmapStep,
  getAdminRoadmapSteps,
  type RoadmapStepPayload
} from '../../../shared/api/roadmap';
import { normalizePublicAssetUrl } from '../../servers/utils/publicUrl';
import { apiFetch } from '../../../shared/api/http';

const STATUSES = [
  { id: 'planned', label: 'Planejado' },
  { id: 'in_dev', label: 'Em Desenvolvimento' },
  { id: 'testing', label: 'Em Testes' },
  { id: 'done', label: 'Concluído' },
  { id: 'cancelled', label: 'Cancelado' }
] as const;

type Draft = {
  title: string;
  description: string;
  status: string;
  plannedDate: string;
  imageUrl: string;
  isHighlight: boolean;
  isPublished: boolean;
};

const emptyDraft = (): Draft => ({
  title: '',
  description: '',
  status: 'planned',
  plannedDate: '',
  imageUrl: '',
  isHighlight: false,
  isPublished: true
});

export const AdminRoadmap: React.FC = () => {
  const [steps, setSteps] = useState<RoadmapStepPayload[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingStepId, setUploadingStepId] = useState<string | null>(null);

  const handleImageUpload = async (stepId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    const okMime = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
    if (!okMime.includes(file.type)) {
      alert('Formato inválido. Usa PNG, JPG, WEBP ou GIF.');
      input.value = '';
      return;
    }
    setUploadingStepId(stepId);
    try {
      const fd = new FormData();
      fd.append('image', file, file.name);
      const res = await apiFetch('/api/admin/upload-image', {
        method: 'POST',
        credentials: 'include',
        body: fd
      });
      let payload: { ok?: boolean; path?: string; url?: string; error?: string } | null = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      const url = payload?.path || payload?.url;
      if (res.ok && payload?.ok && url) {
        setDrafts((p) => ({
          ...p,
          [stepId]: { ...(p[stepId] || emptyDraft()), imageUrl: url }
        }));
      } else {
        alert(payload?.error || `Falha ao enviar imagem (HTTP ${res.status}).`);
      }
    } catch {
      alert('Falha de rede ao enviar imagem.');
    } finally {
      setUploadingStepId(null);
      input.value = '';
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    const { steps: rows } = await getAdminRoadmapSteps();
    setSteps(rows);
    const d: Record<string, Draft> = {};
    for (const s of rows) {
      d[s.id] = {
        title: s.title,
        description: s.description,
        status: s.status,
        plannedDate: s.plannedDate || '',
        imageUrl: s.imageUrl || '',
        isHighlight: s.isHighlight,
        isPublished: s.isPublished
      };
    }
    setDrafts(d);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createStep = async () => {
    setSaving(true);
    await adminCreateRoadmapStep({ title: 'Nova etapa', description: '', status: 'planned' });
    await load();
    setSaving(false);
  };

  const saveStep = async (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    setSaving(true);
    await adminUpdateRoadmapStep(id, {
      title: draft.title,
      description: draft.description,
      status: draft.status,
      plannedDate: draft.plannedDate.trim() || null,
      imageUrl: draft.imageUrl.trim() || null,
      isHighlight: draft.isHighlight,
      isPublished: draft.isPublished
    });
    await load();
    setSaving(false);
  };

  const move = async (index: number, dir: -1 | 1) => {
    const next = [...steps];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    setSteps(next);
    await adminReorderRoadmapSteps(next.map((s) => s.id));
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-amber-400">
        <Loader2 className="animate-spin" size={28} />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Map className="text-amber-400" />
          <h2 className="text-lg font-bold text-white">Roadmap</h2>
        </div>
        <button
          type="button"
          onClick={() => void createStep()}
          disabled={saving}
          className="px-3 py-2 rounded-lg bg-amber-600 text-white text-sm font-bold flex items-center gap-1"
        >
          <Plus size={14} /> Etapa
        </button>
      </div>

      {steps.map((step, idx) => {
        const draft = drafts[step.id] || emptyDraft();
        return (
          <div key={step.id} className="rounded-xl border border-slate-700 bg-slate-900/50 p-4 space-y-2">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void move(idx, -1)} className="p-1 text-slate-400">
                <ChevronUp size={16} />
              </button>
              <button type="button" onClick={() => void move(idx, 1)} className="p-1 text-slate-400">
                <ChevronDown size={16} />
              </button>
              <input
                value={draft.title}
                onChange={(e) => setDrafts((p) => ({ ...p, [step.id]: { ...draft, title: e.target.value } }))}
                className="flex-1 min-w-[200px] rounded border border-slate-700 bg-slate-950 px-2 py-1 text-white font-bold"
                placeholder="Título"
              />
              <select
                value={draft.status}
                onChange={(e) => setDrafts((p) => ({ ...p, [step.id]: { ...draft, status: e.target.value } }))}
                className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-white"
              >
                {STATUSES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setDrafts((p) => ({ ...p, [step.id]: { ...draft, isHighlight: !draft.isHighlight } }))}
                className={draft.isHighlight ? 'text-amber-400' : 'text-slate-500'}
                title="Destacar"
              >
                <Sparkles size={18} />
              </button>
              <button
                type="button"
                onClick={() => setDrafts((p) => ({ ...p, [step.id]: { ...draft, isPublished: !draft.isPublished } }))}
              >
                {draft.isPublished ? <ToggleRight className="text-green-400" /> : <ToggleLeft className="text-slate-500" />}
              </button>
              <button type="button" onClick={() => void adminDeleteRoadmapStep(step.id).then(load)} className="text-red-400">
                <Trash2 size={16} />
              </button>
              <button
                type="button"
                onClick={() => void saveStep(step.id)}
                disabled={saving}
                className="px-2 py-1 rounded bg-green-700 text-white text-xs font-bold flex items-center gap-1"
              >
                <Save size={12} /> Guardar
              </button>
            </div>
            <input
              value={draft.plannedDate}
              onChange={(e) => setDrafts((p) => ({ ...p, [step.id]: { ...draft, plannedDate: e.target.value } }))}
              placeholder="Data prevista (ex.: Q2 2026)"
              className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-white"
            />
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wide text-slate-400">Imagem (opcional)</label>
              <div className="flex flex-wrap gap-2">
                <input
                  value={draft.imageUrl}
                  onChange={(e) => setDrafts((p) => ({ ...p, [step.id]: { ...draft, imageUrl: e.target.value } }))}
                  placeholder="URL imagem ou path após upload"
                  className="flex-1 min-w-[200px] rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-white"
                />
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-amber-600/60 bg-amber-950/40 px-3 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-900/50">
                  <Upload size={14} />
                  {uploadingStepId === step.id ? 'A subir…' : 'Subir do PC'}
                  <input
                    type="file"
                    className="hidden"
                    accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
                    disabled={uploadingStepId === step.id}
                    onChange={(e) => void handleImageUpload(step.id, e)}
                  />
                </label>
              </div>
              {draft.imageUrl.trim() ? (
                <div className="rounded-lg border border-slate-700 bg-slate-950 p-2 flex justify-center max-h-40 overflow-hidden">
                  <img
                    src={normalizePublicAssetUrl(draft.imageUrl) || draft.imageUrl}
                    alt="Pré-visualização"
                    className="max-h-36 w-auto object-contain rounded"
                  />
                </div>
              ) : null}
            </div>
            <textarea
              value={draft.description}
              onChange={(e) => setDrafts((p) => ({ ...p, [step.id]: { ...draft, description: e.target.value } }))}
              rows={4}
              placeholder="Descrição"
              className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-white"
            />
          </div>
        );
      })}
    </div>
  );
};
