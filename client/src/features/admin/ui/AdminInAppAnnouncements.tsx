// @ts-nocheck — template legado 1:1.
import React, { useCallback, useEffect, useState } from 'react';
import { Bell, Edit, Image as ImageIcon, PlusCircle, Trash2, ToggleLeft, ToggleRight, Upload } from 'lucide-react';
import {
  createAdminInAppAnnouncement,
  deleteAdminInAppAnnouncement,
  getAdminInAppAnnouncements,
  updateAdminInAppAnnouncement,
  type InAppAnnouncementAdminPayload
} from '../../../shared/api/announcements';
import { uploadAdImage } from '../../../shared/api/admin-legacy';
import { isSafeInAppImagePath, normalizeSafeInAppImagePath } from '../../../shared/utils/inAppAnnouncementSafe';
import { RemoteBannerImage } from '../../mini-blog/ui/RemoteBannerImage';

const emptyForm = () => ({
  title: '',
  message: '',
  link: '',
  imageUrl: '',
  priority: 0,
  isActive: true,
  startsAt: '',
  endsAt: ''
});

export const AdminInAppAnnouncements: React.FC = () => {
  const [list, setList] = useState<InAppAnnouncementAdminPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { list: rows, error } = await getAdminInAppAnnouncements();
      setList(rows);
      if (error) setLoadError(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = () => {
    setForm(emptyForm());
    setEditingId(null);
  };

  const msToDatetimeLocal = (ms: number | null): string => {
    if (ms == null || !Number.isFinite(ms)) return '';
    const d = new Date(ms);
    const pad = (x: number) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const startEdit = (row: InAppAnnouncementAdminPayload) => {
    setEditingId(row.id);
    setForm({
      title: row.title,
      message: row.message,
      link: row.link || '',
      imageUrl: row.imageUrl || '',
      priority: row.priority ?? 0,
      isActive: row.isActive,
      startsAt: msToDatetimeLocal(row.startsAt),
      endsAt: msToDatetimeLocal(row.endsAt)
    });
  };

  const parseOptionalMs = (v: string): number | null => {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    if (Number.isFinite(n) && n > 1e11) return n;
    const parsed = Date.parse(t);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const handleSave = async () => {
    if (!form.title.trim() || !form.message.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = {
        title: form.title.trim(),
        message: form.message.trim(),
        link: form.link.trim() || undefined,
        imageUrl: normalizeSafeInAppImagePath(form.imageUrl),
        priority: Number(form.priority) || 0,
        isActive: form.isActive,
        startsAt: parseOptionalMs(form.startsAt),
        endsAt: parseOptionalMs(form.endsAt)
      };
      const result = editingId
        ? await updateAdminInAppAnnouncement(editingId, payload)
        : await createAdminInAppAnnouncement(payload);
      if (result.error || !result.announcement) {
        setSaveError(result.error || 'Não foi possível guardar o aviso.');
        return;
      }
      resetForm();
      await load();
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (row: InAppAnnouncementAdminPayload) => {
    const result = await updateAdminInAppAnnouncement(row.id, { isActive: !row.isActive });
    if (result.error) {
      setSaveError(result.error);
      return;
    }
    await load();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Apagar este aviso popup? Quem já leu mantém o registo; novos utilizadores deixam de ver.')) return;
    const ok = await deleteAdminInAppAnnouncement(id);
    if (!ok) {
      setSaveError('Não foi possível apagar o aviso.');
      return;
    }
    if (editingId === id) resetForm();
    await load();
  };

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 -mx-1 px-1 py-3 bg-slate-900/95 backdrop-blur border-b border-slate-700 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Bell className="text-amber-400 shrink-0" size={22} />
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-white">Avisos popup</h2>
            <p className="text-xs text-slate-400 hidden sm:block">
              Modal após login — uma vez por jogador por aviso.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            resetForm();
            document.getElementById('popup-announcement-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-5 py-2.5 text-sm font-bold uppercase text-white hover:bg-amber-500 shadow-lg shadow-amber-900/40 shrink-0"
        >
          <PlusCircle size={18} />
          Criar aviso popup
        </button>
      </div>

      <p className="text-xs text-slate-500 -mt-2">
        Aparecem após login para quem ainda não fechou. Banners «News» são outra coisa (Configurações → Gerenciar News).
        Se já fechaste na tua conta, não volta a aparecer — testa noutro utilizador.
      </p>

      {(loadError || saveError) && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          {saveError || loadError}
        </div>
      )}

      <div id="popup-announcement-form" className="rounded-xl border-2 border-amber-700/40 bg-slate-900/50 p-4 space-y-3 scroll-mt-24">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">
          {editingId ? 'Editar aviso' : 'Novo aviso'}
        </h3>
        <input
          className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
          placeholder="Título"
          value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
        />
        <textarea
          className="w-full min-h-[100px] rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
          placeholder="Mensagem"
          value={form.message}
          onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
        />
        <div>
          <label className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-1 block">
            Imagem do aviso (PNG, JPG, GIF)
          </label>
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <ImageIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                readOnly
                className="w-full rounded-lg border border-slate-600 bg-slate-950/80 pl-9 pr-3 py-2 text-sm text-slate-400 cursor-not-allowed"
                placeholder="Suba uma imagem (PNG, JPG ou GIF)"
                value={form.imageUrl}
                title="A imagem só pode vir do upload interno — URLs externas não são permitidas."
              />
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-amber-600/60 bg-amber-950/40 px-4 py-2 text-xs font-bold uppercase text-amber-200 hover:bg-amber-900/50">
              <Upload size={16} />
              {uploadingImage ? 'A subir…' : 'Subir imagem'}
              <input
                type="file"
                className="hidden"
                accept="image/*"
                disabled={uploadingImage}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploadingImage(true);
                  setSaveError(null);
                  try {
                    const res = await uploadAdImage(file);
                    if (res.ok && res.imageUrl && isSafeInAppImagePath(res.imageUrl)) {
                      setForm((f) => ({ ...f, imageUrl: res.imageUrl! }));
                    } else if (res.ok && res.imageUrl) {
                      setSaveError('URL de imagem devolvida pelo servidor é inválida.');
                    } else {
                      setSaveError(res.error || 'Erro no upload da imagem.');
                    }
                  } finally {
                    setUploadingImage(false);
                    e.target.value = '';
                  }
                }}
              />
            </label>
          </div>
          {normalizeSafeInAppImagePath(form.imageUrl) ? (
            <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950 p-2 flex justify-center max-h-48 overflow-hidden">
              <RemoteBannerImage
                src={normalizeSafeInAppImagePath(form.imageUrl)!}
                alt="Pré-visualização"
                className="max-h-44 w-auto object-contain rounded"
                failureHint="Imagem indisponível"
              />
            </div>
          ) : null}
        </div>
        <input
          className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
          placeholder="Link opcional (https://...)"
          value={form.link}
          onChange={(e) => setForm((f) => ({ ...f, link: e.target.value }))}
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="text-xs text-slate-400">
            Prioridade
            <input
              type="number"
              className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
              value={form.priority}
              onChange={(e) => setForm((f) => ({ ...f, priority: Number(e.target.value) || 0 }))}
            />
          </label>
          <label className="text-xs text-slate-400">
            Início (opcional)
            <input
              type="datetime-local"
              className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
              value={form.startsAt}
              onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))}
            />
          </label>
          <label className="text-xs text-slate-400">
            Fim (opcional)
            <input
              type="datetime-local"
              className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
              value={form.endsAt}
              onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))}
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
          />
          Ativo
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !form.title.trim() || !form.message.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-xs font-bold uppercase text-white hover:bg-amber-500 disabled:opacity-50"
          >
            <PlusCircle size={16} />
            {editingId ? 'Guardar' : 'Criar'}
          </button>
          {editingId ? (
            <button
              type="button"
              onClick={resetForm}
              className="rounded-lg border border-slate-600 px-4 py-2 text-xs font-bold text-slate-300 hover:text-white"
            >
              Cancelar
            </button>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">Publicados</h3>
        {loading ? (
          <p className="text-sm text-slate-500">A carregar…</p>
        ) : list.length === 0 ? (
          <p className="text-sm text-slate-500">Nenhum aviso popup.</p>
        ) : (
          list.map((row) => (
            <div
              key={row.id}
              className="flex flex-col sm:flex-row sm:items-start gap-3 rounded-xl border border-slate-700 bg-slate-900/40 p-4"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-white">{row.title}</span>
                  <span
                    className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                      row.isActive ? 'bg-emerald-900/50 text-emerald-400' : 'bg-slate-800 text-slate-500'
                    }`}
                  >
                    {row.isActive ? 'Ativo' : 'Inativo'}
                  </span>
                  <span className="text-[10px] text-slate-500">Prioridade {row.priority ?? 0}</span>
                  <span className="text-[10px] text-slate-500">{row.readCount} leituras</span>
                </div>
                <p className="mt-1 text-sm text-slate-400 line-clamp-3 whitespace-pre-wrap">{row.message}</p>
                {normalizeSafeInAppImagePath(row.imageUrl) ? (
                  <div className="mt-2 max-w-xs rounded border border-slate-700 overflow-hidden bg-slate-950">
                    <RemoteBannerImage
                      src={normalizeSafeInAppImagePath(row.imageUrl)!}
                      alt={row.title}
                      className="max-h-24 w-full object-contain"
                      failureHint="Imagem indisponível"
                    />
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => void handleToggleActive(row)}
                  className="p-2 rounded border border-slate-600 text-slate-400 hover:text-white"
                  title={row.isActive ? 'Desativar' : 'Ativar'}
                >
                  {row.isActive ? <ToggleRight className="text-emerald-400" size={18} /> : <ToggleLeft size={18} />}
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(row)}
                  className="p-2 rounded border border-slate-600 text-slate-400 hover:text-white"
                  title="Editar"
                >
                  <Edit size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(row.id)}
                  className="p-2 rounded border border-red-900/50 text-red-400 hover:bg-red-950/30"
                  title="Apagar"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
