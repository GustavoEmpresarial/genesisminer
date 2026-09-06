/**
 * Streamer partnership Hub — YouTube showcase + studio.
 * Layout aligned with `legacy/frontend/components/PartnersPage.tsx`.
 * API: `shared/api/partners.ts` · DECISIONS #99.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  BadgeCheck,
  Calendar,
  Clapperboard,
  Loader2,
  Play,
  Sparkles,
  ThumbsUp,
  Youtube
} from 'lucide-react';
import {
  getPartnersState,
  mapMySubmissionsFromState,
  type PartnerYoutubeMySubmission,
  type PartnersShowcaseVideoDto,
  type PartnersStatePayload
} from '../../../shared/api/partners';
import { mapApiErrorToMessage } from '../../../shared/api/client-errors';
import { useI18n, useT } from '../../../shared/i18n';
import { PartnerShowcaseAvatar } from './PartnerShowcaseAvatar';
import { PartnerSplitHero } from './PartnerSplitHero';
import { formatPartnerDate } from '../lib/formatPartnerDate';
import {
  channelOpenUrl,
  isYoutubeChannelHref,
  youtubeSubscribeHref,
  youtubeThumbUrl
} from '../lib/partnerLinks';
import { YoutubePartnerStudio } from './YoutubePartnerStudio';

type PartnersPageTab = 'videos' | 'studio';

export function PartnersPage() {
  const t = useT();
  const { locale } = useI18n();
  const [videos, setVideos] = useState<PartnersShowcaseVideoDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PartnersPageTab>('videos');
  const [partnersState, setPartnersState] = useState<PartnersStatePayload | null>(null);
  const [mySubs, setMySubs] = useState<PartnerYoutubeMySubmission[]>([]);

  const mapStateToUi = useCallback((st: PartnersStatePayload) => {
    const raw = Array.isArray(st.showcase?.videos) ? st.showcase!.videos : [];
    setVideos(raw);
    setPartnersState(st);
    setMySubs(mapMySubmissionsFromState(st));
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const { data, error } = await getPartnersState({ limit: 48 });
    if (!data) {
      setErr(mapApiErrorToMessage(error || 'LOAD_FAILED', t, 'partners'));
      setVideos([]);
      setPartnersState(null);
      setMySubs([]);
      setLoading(false);
      return;
    }
    mapStateToUi(data);
    setLoading(false);
  }, [mapStateToUi, t]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const auth = partnersState?.auth;
  const isPartner = !!auth?.isPartner;
  const canApply = !!auth?.canApply;
  const applicationPending = auth?.application?.status === 'pending';
  const studioTabLabel = isPartner ? t('partners.tabStudioPartner') : t('partners.tabStudioApply');

  return (
    <div className="flex w-full flex-col gap-8 pb-8 text-slate-100">
      <div id="parceiros-youtube" className="mx-auto w-full max-w-7xl scroll-mt-6 space-y-8 px-3 pt-4 sm:px-4 sm:pt-5">
        <div className="space-y-2 rounded-2xl border border-slate-700/80 bg-gradient-to-br from-slate-900/90 via-slate-900/70 to-amber-950/20 px-4 py-5 sm:px-6 sm:py-6">
          <div className="text-[11px] font-bold uppercase tracking-widest text-amber-500/90">
            {t('partners.eyebrow')}
          </div>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-black tracking-tight sm:text-4xl">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-red-600/90 text-white shadow-lg shadow-red-900/30">
              <Clapperboard className="shrink-0" size={26} />
            </span>
            <span className="bg-gradient-to-r from-white to-slate-300 bg-clip-text text-transparent">
              {t('partners.title')}
            </span>
          </h1>
          <p className="max-w-3xl text-sm text-slate-400">
            {activeTab === 'videos'
              ? t('partners.subtitleVideos')
              : isPartner
                ? t('partners.subtitleStudioPartner')
                : t('partners.subtitleStudioApply')}
          </p>

          <div className="flex flex-wrap gap-2 pt-2" role="tablist" aria-label={t('partners.tabsAria')}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'videos'}
              onClick={() => setActiveTab('videos')}
              className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-black uppercase tracking-wide transition ${
                activeTab === 'videos'
                  ? 'border-violet-500/50 bg-violet-600/25 text-violet-100 shadow-lg shadow-violet-950/30'
                  : 'border-slate-700 bg-slate-950/50 text-slate-400 hover:border-slate-600 hover:text-slate-200'
              }`}
            >
              <Play size={16} className={activeTab === 'videos' ? 'text-violet-300' : 'text-slate-500'} />
              {t('partners.tabVideos')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'studio'}
              onClick={() => setActiveTab('studio')}
              className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-black uppercase tracking-wide transition ${
                activeTab === 'studio'
                  ? 'border-red-500/45 bg-red-600/20 text-red-100 shadow-lg shadow-red-950/25'
                  : 'border-slate-700 bg-slate-950/50 text-slate-400 hover:border-slate-600 hover:text-slate-200'
              }`}
            >
              {isPartner ? (
                <BadgeCheck size={16} className={activeTab === 'studio' ? 'text-emerald-300' : 'text-slate-500'} />
              ) : (
                <Sparkles size={16} className={activeTab === 'studio' ? 'text-red-300' : 'text-slate-500'} />
              )}
              {studioTabLabel}
              {applicationPending && activeTab !== 'studio' ? (
                <span className="rounded-full bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-black normal-case tracking-normal text-black">
                  {t('partners.badgePending')}
                </span>
              ) : null}
              {canApply && !applicationPending && !isPartner && activeTab !== 'studio' ? (
                <span className="rounded-full bg-red-500/90 px-1.5 py-0.5 text-[9px] font-black normal-case tracking-normal text-white">
                  {t('partners.badgeNew')}
                </span>
              ) : null}
            </button>
          </div>
        </div>

        {activeTab === 'studio' ? (
          loading && !partnersState ? (
            <div className="flex justify-center py-16 text-red-400">
              <Loader2 className="animate-spin" size={32} />
            </div>
          ) : partnersState ? (
            <YoutubePartnerStudio state={partnersState} mySubs={mySubs} onReload={loadAll} />
          ) : (
            <div className="rounded-xl border border-red-900/40 p-6 text-center text-sm text-red-400">
              {err || t('partners.studioLoadError')}
            </div>
          )
        ) : null}

        {activeTab === 'videos' ? (
          <section className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-800 pb-3">
              <div>
                <h2 className="text-lg font-black tracking-tight text-white sm:text-xl">
                  {t('partners.latestTitle')}
                </h2>
                <p className="mt-0.5 max-w-2xl text-xs font-semibold text-slate-500">
                  {!loading && !err && videos.length > 0
                    ? t('partners.latestHintCount', { count: String(videos.length) })
                    : t('partners.latestHintEmpty')}
                </p>
              </div>
            </div>
            {loading ? (
              <div className="flex justify-center py-16 text-amber-500">
                <Loader2 className="animate-spin" size={32} />
              </div>
            ) : err ? (
              <div className="text-sm text-red-400">{err}</div>
            ) : videos.length === 0 ? (
              <div className="rounded-xl border border-slate-800 p-8 text-center text-sm text-slate-500">
                {t('partners.emptyVideos')}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
                {videos.map((v) => {
                  const displayName = String(v.creator?.displayName || '').trim() || t('partners.fallbackPartner');
                  const customChannel = String(v.creator?.channelUrl || '').trim();
                  const channelHref = channelOpenUrl(customChannel, displayName);
                  const channelLabel = customChannel
                    ? t('partners.viewChannel')
                    : t('partners.searchChannel');
                  const subHref = youtubeSubscribeHref(customChannel, displayName);
                  const isYt = isYoutubeChannelHref(channelHref);
                  const avatarUrl = String(v.creator?.avatarUrl || '').trim();
                  const thumb = v.thumbnailUrl || youtubeThumbUrl(v.youtubeVideoId);
                  return (
                    <article
                      key={v.publicId}
                      className="flex flex-col overflow-hidden rounded-xl border border-slate-600/80 bg-slate-950/60 shadow-xl shadow-black/30 ring-1 ring-white/5 transition-all hover:ring-amber-500/20"
                    >
                      <PartnerSplitHero youtubeUrl={v.youtubeUrl} videoThumb={thumb} vitrineUrl={avatarUrl} />
                      <div className="flex items-center gap-2.5 border-t border-slate-800 bg-slate-950/95 px-3 py-2">
                        <PartnerShowcaseAvatar name={displayName} imageUrl={avatarUrl} compact />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-bold leading-tight text-white">{displayName}</div>
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                            {t('partners.partnerBadge')}
                          </div>
                        </div>
                        <a
                          href={subHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md border border-red-500/30 bg-gradient-to-b from-red-600 to-red-800 px-2.5 py-2 text-[10px] font-black uppercase text-white shadow-md shadow-red-900/40 hover:from-red-500 hover:to-red-700"
                        >
                          {isYt ? t('partners.subscribe') : t('partners.youtube')}
                        </a>
                      </div>
                      <div className="flex flex-1 flex-col gap-2 border-t border-slate-800/80 p-3">
                        <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-bold leading-snug text-white">
                          {v.title}
                        </h3>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                          <span className="inline-flex items-center gap-1">
                            <Calendar size={12} /> {formatPartnerDate(v.publishedAt, locale)}
                          </span>
                        </div>
                        <div className="mt-auto grid grid-cols-2 gap-2 pt-1">
                          <a
                            href={v.youtubeUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-orange-400/30 bg-gradient-to-b from-orange-500 to-orange-700 py-2.5 text-center text-[10px] font-black uppercase text-white shadow-md shadow-orange-900/30 hover:from-orange-400 hover:to-orange-600 sm:text-[11px]"
                          >
                            <ThumbsUp size={14} className="shrink-0" />
                            {t('partners.likeOnYoutube')}
                          </a>
                          <a
                            href={channelHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500/30 bg-gradient-to-b from-red-600 to-red-800 py-2.5 text-center text-[10px] font-black uppercase text-white shadow-md shadow-red-900/40 hover:from-red-500 hover:to-red-700 sm:text-[11px]"
                          >
                            <Youtube size={14} className="shrink-0" />
                            {channelLabel}
                          </a>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
