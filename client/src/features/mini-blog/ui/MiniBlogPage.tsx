/**
 * Mini Blog hub / sidebar — announcements feed.
 * API: `shared/api/mini-blog.ts` · GAME_SHELL.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, ExternalLink, Newspaper, RefreshCw } from 'lucide-react';
import { getMiniBlogEntries, type MiniBlogEntry } from '../../../shared/api/mini-blog';
import { mapApiErrorToMessage } from '../../../shared/api/client-errors';
import { isSafeHttpsLink } from '../../../shared/utils/safe-https-link';
import { useT } from '../../../shared/i18n';
import { normalizePublicAssetUrl } from '../../../shared/utils/public-url';
import { RemoteBannerImage } from './RemoteBannerImage';

type MiniBlogPageProps = {
  /** `page` = Hub screen; `sidebar` = optional right rail. */
  variant?: 'sidebar' | 'page';
  /** Sidebar only: collapse the right rail. */
  onCollapse?: () => void;
};

export function MiniBlogPage({ variant = 'page', onCollapse }: MiniBlogPageProps) {
  const t = useT();
  const [entries, setEntries] = useState<MiniBlogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const isPage = variant === 'page';

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    const { entries: rows, error } = await getMiniBlogEntries();
    setEntries(rows);
    if (error) setErrorMsg(mapApiErrorToMessage(error, t, 'miniBlog'));
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void load();
    const onRefresh = () => void load();
    window.addEventListener('genesis:mini-blog-refresh', onRefresh);
    return () => window.removeEventListener('genesis:mini-blog-refresh', onRefresh);
  }, [load]);

  return (
    <div
      className={
        isPage
          ? 'mx-auto flex h-full min-h-0 w-full max-w-4xl flex-1 flex-col overflow-hidden rounded-2xl border border-orange-500/35 bg-gradient-to-b from-slate-900/95 to-slate-950 shadow-[0_0_32px_-8px_rgba(251,146,60,0.35)]'
          : 'flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border-2 border-orange-500/35 bg-gradient-to-b from-slate-900/90 to-slate-950/95 shadow-[0_0_32px_-8px_rgba(251,146,60,0.45)]'
      }
    >
      <div
        className={`flex shrink-0 items-center justify-between gap-2 border-b border-orange-500/30 bg-gradient-to-r from-orange-950/80 to-slate-950/90 ${
          isPage ? 'px-4 py-3 sm:px-5 sm:py-4' : 'px-4 py-3'
        }`}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Newspaper size={isPage ? 22 : 20} className="shrink-0 text-orange-400" />
          <div className="min-w-0">
            <span
              className={`block truncate font-black uppercase tracking-widest text-orange-200 ${
                isPage ? 'text-base sm:text-lg' : 'text-sm'
              }`}
            >
              {t('miniBlog.title')}
            </span>
            {isPage ? (
              <p className="mt-0.5 line-clamp-2 text-[11px] font-medium normal-case tracking-normal text-slate-400 sm:text-xs">
                {t('miniBlog.subtitle')}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 rounded-lg p-2 text-slate-400 transition-colors hover:bg-orange-500/10 hover:text-orange-300"
            title={t('miniBlog.refresh')}
            aria-label={t('miniBlog.refresh')}
          >
            <RefreshCw size={isPage ? 18 : 16} className={loading ? 'animate-spin' : ''} />
          </button>
          {!isPage && onCollapse ? (
            <button
              type="button"
              onClick={onCollapse}
              className="shrink-0 rounded-lg border border-orange-500/40 p-2 text-orange-200 transition-colors hover:bg-orange-500/15 hover:text-orange-100"
              title={t('miniBlog.collapse')}
              aria-label={t('miniBlog.collapse')}
            >
              <ChevronRight size={16} />
            </button>
          ) : null}
        </div>
      </div>

      <div
        className={`custom-scrollbar min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto ${
          isPage ? 'space-y-4 p-3 sm:p-5' : 'p-3'
        }`}
      >
        {loading && entries.length === 0 ? (
          <p className={`py-8 text-center text-slate-500 ${isPage ? 'text-sm sm:text-base' : 'text-sm'}`}>
            {t('common.loading')}
          </p>
        ) : errorMsg ? (
          <p className={`py-6 text-center text-red-400 ${isPage ? 'text-sm sm:text-base' : 'text-sm'}`}>
            {errorMsg}
          </p>
        ) : entries.length === 0 ? (
          <p
            className={`px-2 py-8 text-center leading-relaxed text-slate-500 ${
              isPage ? 'text-sm sm:text-base' : 'text-sm'
            }`}
          >
            {t('miniBlog.empty')}
          </p>
        ) : (
          entries.map((entry) => {
            const link = entry.link && isSafeHttpsLink(entry.link) ? entry.link : null;
            const imageUrl = entry.imageUrl
              ? normalizePublicAssetUrl(entry.imageUrl) || entry.imageUrl
              : null;
            return (
              <article
                key={entry.id}
                className={`min-w-0 rounded-xl border border-slate-700/90 bg-slate-950/80 shadow-sm transition-colors hover:border-orange-500/30 ${
                  isPage ? 'space-y-3 p-4 sm:p-5' : 'space-y-2 p-3'
                }`}
              >
                <h4
                  className={`break-words font-bold leading-snug text-white ${
                    isPage ? 'text-base sm:text-lg' : 'text-sm'
                  }`}
                >
                  {entry.title}
                </h4>
                {imageUrl ? (
                  <div className="aspect-[16/9] max-h-72 w-full overflow-hidden rounded-lg border border-slate-800 sm:max-h-80">
                    <RemoteBannerImage
                      src={imageUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      failureHint={t('miniBlog.imageUnavailable')}
                    />
                  </div>
                ) : null}
                <p
                  className={`break-words whitespace-pre-wrap leading-relaxed text-slate-300 ${
                    isPage ? 'text-sm sm:text-[15px]' : 'line-clamp-8 text-xs'
                  }`}
                >
                  {entry.message}
                </p>
                {link ? (
                  <a
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex items-center gap-1.5 font-bold uppercase text-amber-400 hover:text-amber-300 ${
                      isPage ? 'py-1 text-xs sm:text-sm' : 'text-[11px]'
                    }`}
                  >
                    {t('miniBlog.readMore')}
                    <ExternalLink size={isPage ? 14 : 12} />
                  </a>
                ) : null}
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
