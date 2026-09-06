import React, { useCallback, useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { BookOpen, ChevronRight, Loader2, Menu, X } from 'lucide-react';
import { getGuideContent, type GuideCategoryPayload, type GuidePagePayload } from '../../../shared/api/guide';

export const GuidePage: React.FC = () => {
  const [categories, setCategories] = useState<GuideCategoryPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { categories: cats } = await getGuideContent();
    setCategories(cats);
    setLoading(false);
    if (cats.length > 0) {
      setActiveCategoryId((prev) => prev && cats.some((c) => c.id === prev) ? prev : cats[0].id);
      const firstCat = cats[0];
      const firstPage = firstCat.pages[0];
      setActivePageId((prev) => {
        if (prev && cats.some((c) => c.pages.some((p) => p.id === prev))) return prev;
        return firstPage?.id ?? null;
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeCategory = useMemo(
    () => categories.find((c) => c.id === activeCategoryId) ?? null,
    [categories, activeCategoryId]
  );

  const activePage = useMemo(() => {
    if (!activePageId) return null;
    for (const c of categories) {
      const p = c.pages.find((x) => x.id === activePageId);
      if (p) return p;
    }
    return null;
  }, [categories, activePageId]);

  const selectPage = (cat: GuideCategoryPayload, page: GuidePagePayload) => {
    setActiveCategoryId(cat.id);
    setActivePageId(page.id);
    setNavOpen(false);
  };

  const safeHtml = (html: string) =>
    DOMPurify.sanitize(html || '', {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'u', 's', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'img', 'blockquote', 'code', 'pre', 'span', 'div'
      ],
      ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'rel', 'class']
    });

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 text-slate-700 dark:text-slate-300">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
            <BookOpen className="text-amber-600 dark:text-amber-500" /> Genesis Miner Guide
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-2">
            Manual oficial — conteúdo gerido pelo admin, sempre atualizado.
          </p>
        </div>
        <button
          type="button"
          className="lg:hidden p-2 rounded-lg border border-slate-300 dark:border-slate-700"
          onClick={() => setNavOpen((v) => !v)}
          aria-label="Menu do guia"
        >
          {navOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20 text-amber-500">
          <Loader2 className="animate-spin" size={32} />
        </div>
      ) : categories.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center text-slate-500">
          O guia ainda não foi publicado. Volte em breve.
        </div>
      ) : (
        <div className="flex flex-col lg:flex-row gap-6">
          <nav
            className={`lg:w-72 shrink-0 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/50 p-3 ${
              navOpen ? 'block' : 'hidden lg:block'
            }`}
          >
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-3 px-2">Navegação</p>
            <ul className="space-y-3">
              {categories.map((cat) => (
                <li key={cat.id}>
                  <div className="text-xs font-bold uppercase text-amber-600 dark:text-amber-400 px-2 mb-1">{cat.title}</div>
                  <ul className="space-y-0.5">
                    {cat.pages.map((page) => (
                      <li key={page.id}>
                        <button
                          type="button"
                          onClick={() => selectPage(cat, page)}
                          className={`w-full text-left px-2 py-1.5 rounded-lg text-sm flex items-center gap-1 transition-colors ${
                            activePageId === page.id
                              ? 'bg-amber-100 dark:bg-amber-950/50 text-amber-800 dark:text-amber-300 font-semibold'
                              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          <ChevronRight size={12} className="shrink-0 opacity-60" />
                          <span className="truncate">{page.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </nav>

          <article className="flex-1 min-w-0 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-6 shadow-sm">
            {activePage ? (
              <>
                {activeCategory && (
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{activeCategory.title}</p>
                )}
                <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-4">{activePage.title}</h2>
                <div
                  className="prose prose-slate dark:prose-invert max-w-none prose-a:text-amber-600 prose-img:rounded-lg"
                  dangerouslySetInnerHTML={{ __html: safeHtml(activePage.contentHtml) }}
                />
              </>
            ) : (
              <p className="text-slate-500">Selecione uma página no menu.</p>
            )}
          </article>
        </div>
      )}
    </div>
  );
};
