// @ts-nocheck — template legado 1:1.
import React, { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  Save,
  Trash2,
  ToggleLeft,
  ToggleRight
} from 'lucide-react';
import {
  adminCreateGuideCategory,
  adminCreateGuidePage,
  adminDeleteGuideCategory,
  adminDeleteGuidePage,
  adminReorderGuideCategories,
  adminReorderGuidePages,
  adminUpdateGuideCategory,
  adminUpdateGuidePage,
  getAdminGuideContent,
  type GuideCategoryPayload,
  type GuidePagePayload
} from '../../../shared/api/guide';
import { AdminRichTextEditor } from './AdminRichTextEditor';

export const AdminGuide: React.FC = () => {
  const [categories, setCategories] = useState<GuideCategoryPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newCatTitle, setNewCatTitle] = useState('');
  const [pageDrafts, setPageDrafts] = useState<Record<string, { title: string; contentHtml: string; isPublished: boolean }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const { categories: cats } = await getAdminGuideContent();
    setCategories(cats);
    const drafts: Record<string, { title: string; contentHtml: string; isPublished: boolean }> = {};
    for (const c of cats) {
      for (const p of c.pages) {
        drafts[p.id] = { title: p.title, contentHtml: p.contentHtml, isPublished: p.isPublished };
      }
    }
    setPageDrafts(drafts);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createCategory = async () => {
    const title = newCatTitle.trim();
    if (!title) return;
    setSaving(true);
    await adminCreateGuideCategory({ title });
    setNewCatTitle('');
    await load();
    setSaving(false);
  };

  const createPage = async (categoryId: string) => {
    setSaving(true);
    await adminCreateGuidePage({ categoryId, title: 'Nova página', contentHtml: '<p>Conteúdo…</p>', isPublished: false });
    await load();
    setSaving(false);
  };

  const savePage = async (page: GuidePagePayload) => {
    const draft = pageDrafts[page.id];
    if (!draft) return;
    setSaving(true);
    await adminUpdateGuidePage(page.id, {
      title: draft.title,
      contentHtml: draft.contentHtml,
      isPublished: draft.isPublished
    });
    await load();
    setSaving(false);
  };

  const moveCategory = async (index: number, dir: -1 | 1) => {
    const next = [...categories];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    setCategories(next);
    await adminReorderGuideCategories(next.map((c) => c.id));
  };

  const movePage = async (categoryId: string, pages: GuidePagePayload[], index: number, dir: -1 | 1) => {
    const next = [...pages];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    setCategories((prev) =>
      prev.map((c) => (c.id === categoryId ? { ...c, pages: next } : c))
    );
    await adminReorderGuidePages(categoryId, next.map((p) => p.id));
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-amber-400">
        <Loader2 className="animate-spin" size={28} />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4">
      <div className="flex items-center gap-2">
        <BookOpen className="text-amber-400" />
        <h2 className="text-lg font-bold text-white">Genesis Miner Guide</h2>
      </div>

      <div className="flex gap-2">
        <input
          value={newCatTitle}
          onChange={(e) => setNewCatTitle(e.target.value)}
          placeholder="Nova categoria…"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
        />
        <button
          type="button"
          onClick={() => void createCategory()}
          disabled={saving}
          className="px-3 py-2 rounded-lg bg-amber-600 text-white text-sm font-bold flex items-center gap-1"
        >
          <Plus size={14} /> Categoria
        </button>
      </div>

      {categories.map((cat, catIdx) => (
        <section key={cat.id} className="rounded-xl border border-slate-700 bg-slate-900/50 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              defaultValue={cat.title}
              onBlur={(e) => void adminUpdateGuideCategory(cat.id, { title: e.target.value.trim() })}
              className="flex-1 min-w-[200px] rounded border border-slate-700 bg-slate-950 px-2 py-1 text-white font-bold"
            />
            <button type="button" onClick={() => void moveCategory(catIdx, -1)} className="p-1 text-slate-400 hover:text-white">
              <ChevronUp size={16} />
            </button>
            <button type="button" onClick={() => void moveCategory(catIdx, 1)} className="p-1 text-slate-400 hover:text-white">
              <ChevronDown size={16} />
            </button>
            <button
              type="button"
              onClick={() => void adminUpdateGuideCategory(cat.id, { isPublished: !cat.isPublished })}
              className="text-slate-300"
              title={cat.isPublished ? 'Publicada' : 'Rascunho'}
            >
              {cat.isPublished ? <ToggleRight className="text-green-400" /> : <ToggleLeft />}
            </button>
            <button
              type="button"
              onClick={() => void adminDeleteGuideCategory(cat.id).then(load)}
              className="p-1 text-red-400 hover:text-red-300"
            >
              <Trash2 size={16} />
            </button>
            <button
              type="button"
              onClick={() => void createPage(cat.id)}
              className="ml-auto text-xs font-bold text-amber-400 flex items-center gap-1"
            >
              <Plus size={12} /> Página
            </button>
          </div>

          {cat.pages.map((page, pageIdx) => {
            const draft = pageDrafts[page.id] || { title: page.title, contentHtml: page.contentHtml, isPublished: page.isPublished };
            return (
              <div key={page.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-2">
                <div className="flex flex-wrap gap-2 items-center">
                  <input
                    value={draft.title}
                    onChange={(e) =>
                      setPageDrafts((prev) => ({ ...prev, [page.id]: { ...draft, title: e.target.value } }))
                    }
                    className="flex-1 min-w-[180px] rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-white"
                  />
                  <button type="button" onClick={() => void movePage(cat.id, cat.pages, pageIdx, -1)} className="p-1 text-slate-500">
                    <ChevronUp size={14} />
                  </button>
                  <button type="button" onClick={() => void movePage(cat.id, cat.pages, pageIdx, 1)} className="p-1 text-slate-500">
                    <ChevronDown size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setPageDrafts((prev) => ({
                        ...prev,
                        [page.id]: { ...draft, isPublished: !draft.isPublished }
                      }))
                    }
                  >
                    {draft.isPublished ? <ToggleRight className="text-green-400" size={20} /> : <ToggleLeft size={20} className="text-slate-500" />}
                  </button>
                  <button type="button" onClick={() => void adminDeleteGuidePage(page.id).then(load)} className="text-red-400">
                    <Trash2 size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void savePage(page)}
                    disabled={saving}
                    className="px-2 py-1 rounded bg-green-700 text-white text-xs font-bold flex items-center gap-1"
                  >
                    <Save size={12} /> Guardar
                  </button>
                </div>
                <AdminRichTextEditor
                  value={draft.contentHtml}
                  onChange={(html) =>
                    setPageDrafts((prev) => ({
                      ...prev,
                      [page.id]: {
                        ...(prev[page.id] ?? {
                          title: page.title,
                          contentHtml: page.contentHtml,
                          isPublished: page.isPublished
                        }),
                        contentHtml: html
                      }
                    }))
                  }
                />
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
};
