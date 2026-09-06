/**
 * YouTube partner studio — apply, profile, submit videos.
 * Layout aligned with `legacy/frontend/components/YoutubePartnerStudio.tsx`.
 * API: `shared/api/partners.ts` · DECISIONS #99.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BadgeCheck,
  Camera,
  ChevronDown,
  ChevronUp,
  Clock,
  Gem,
  ImagePlus,
  Loader2,
  Lock,
  Rocket,
  Sparkles,
  Youtube
} from 'lucide-react';
import {
  submitPartnerYoutubeApplication,
  submitPartnerYoutubeVideo,
  updatePartnerYoutubeMyProfile,
  uploadPartnerYoutubeAvatar,
  type PartnerYoutubeMySubmission,
  type PartnersStatePayload
} from '../../../shared/api/partners';
import { mapApiErrorToMessage } from '../../../shared/api/client-errors';
import {
  PARTNER_CHANNEL_DESCRIPTION_MAX,
  PARTNER_CHANNEL_NAME_MAX,
  PARTNER_CHANNEL_URL_MAX,
  PARTNER_VIDEO_DESCRIPTION_MAX,
  PARTNER_VIDEO_TITLE_MAX,
  PARTNER_VIDEO_YOUTUBE_URL_MAX
} from '../../../shared/constants/partnerFormLimits';
import { useI18n, useT, type TranslateFn } from '../../../shared/i18n';
import { normalizePublicAssetUrl } from '../../../shared/utils/public-url';
import { formatPartnerDateShort } from '../lib/formatPartnerDate';

function statusLabel(st: string, t: TranslateFn): string {
  if (st === 'approved') return t('partners.statusApproved');
  if (st === 'rejected') return t('partners.statusRejected');
  if (st === 'pending') return t('partners.statusPending');
  return st;
}

function statusClass(st: string): string {
  if (st === 'approved') return 'bg-emerald-900/60 text-emerald-200 border-emerald-700/50';
  if (st === 'rejected') return 'bg-red-950/50 text-red-200 border-red-800/50';
  return 'bg-amber-900/40 text-amber-100 border-amber-700/50';
}

function partnerApiError(error: string | undefined, t: TranslateFn, fallbackKey: string): string {
  if (error === 'NETWORK') return mapApiErrorToMessage(error, t, 'partners');
  return error || t(fallbackKey);
}

function previewAssetUrl(url: string | null | undefined): string {
  if (!url) return '';
  return normalizePublicAssetUrl(url) || url;
}

function emphasizeName(text: string, name: string) {
  if (!name) return text;
  const i = text.indexOf(name);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <strong className="text-amber-300">{name}</strong>
      {text.slice(i + name.length)}
    </>
  );
}

type Props = {
  state: PartnersStatePayload;
  mySubs: PartnerYoutubeMySubmission[];
  onReload: () => Promise<void>;
};

export function YoutubePartnerStudio({ state, mySubs, onReload }: Props) {
  const t = useT();
  const { locale } = useI18n();
  const auth = state.auth || {};
  const isPartner = !!auth.isPartner;
  const canApply = !!auth.canApply;
  const application = auth.application ?? null;
  const profile = state.creatorProfile ?? null;
  const nftRoom = state.nftRoom ?? null;

  const [applyOpen, setApplyOpen] = useState(true);
  const [channelName, setChannelName] = useState('');
  const [channelUrl, setChannelUrl] = useState('');
  const [description, setDescription] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [avatarPreview, setAvatarPreview] = useState('');
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyErr, setApplyErr] = useState<string | null>(null);
  const applyFileRef = useRef<HTMLInputElement>(null);

  const [editName, setEditName] = useState(profile?.channelName || '');
  const [editAvatar, setEditAvatar] = useState(profile?.avatarUrl || '');
  const [editPreview, setEditPreview] = useState(previewAssetUrl(profile?.avatarUrl));
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileErr, setProfileErr] = useState<string | null>(null);
  const editFileRef = useRef<HTMLInputElement>(null);

  const [formOpen, setFormOpen] = useState(true);
  const [title, setTitle] = useState('');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [videoDesc, setVideoDesc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      setEditName(profile.channelName || '');
      setEditAvatar(profile.avatarUrl || '');
      setEditPreview(previewAssetUrl(profile.avatarUrl));
    }
  }, [profile?.channelName, profile?.avatarUrl]);

  const handleAvatarPick = useCallback(
    async (file: File | undefined, mode: 'apply' | 'edit') => {
      if (!file) return;
      const localUrl = URL.createObjectURL(file);
      if (mode === 'apply') setAvatarPreview(localUrl);
      else setEditPreview(localUrl);
      setApplyErr(null);
      setProfileErr(null);
      const up = await uploadPartnerYoutubeAvatar(file);
      if (!up.ok || !up.avatarUrl) {
        const msg = partnerApiError(up.error, t, 'partners.uploadFailed');
        if (mode === 'apply') setApplyErr(msg);
        else setProfileErr(msg);
        return;
      }
      if (mode === 'apply') {
        setAvatarUrl(up.avatarUrl);
        setAvatarPreview(previewAssetUrl(up.avatarUrl));
      } else {
        setEditAvatar(up.avatarUrl);
        setEditPreview(previewAssetUrl(up.avatarUrl));
      }
    },
    [t]
  );

  const onApply = async (e: FormEvent) => {
    e.preventDefault();
    setApplyErr(null);
    setApplyBusy(true);
    try {
      const r = await submitPartnerYoutubeApplication({
        channelName,
        channelUrl,
        avatarUrl,
        description
      });
      if (!r.ok) {
        setApplyErr(partnerApiError(r.error, t, 'partners.applyFailed'));
        return;
      }
      setChannelName('');
      setChannelUrl('');
      setDescription('');
      setAvatarUrl('');
      setAvatarPreview('');
      await onReload();
    } finally {
      setApplyBusy(false);
    }
  };

  const onSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setProfileErr(null);
    setProfileBusy(true);
    try {
      const r = await updatePartnerYoutubeMyProfile({ channelName: editName, avatarUrl: editAvatar });
      if (!r.ok) {
        setProfileErr(partnerApiError(r.error, t, 'partners.profileFailed'));
        return;
      }
      await onReload();
    } finally {
      setProfileBusy(false);
    }
  };

  const onSubmitVideo = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitErr(null);
    setSubmitting(true);
    try {
      const r = await submitPartnerYoutubeVideo({ title, youtubeUrl, description: videoDesc });
      if (!r.ok) {
        setSubmitErr(partnerApiError(r.error, t, 'partners.videoFailed'));
        return;
      }
      setTitle('');
      setYoutubeUrl('');
      setVideoDesc('');
      await onReload();
    } finally {
      setSubmitting(false);
    }
  };

  if (!auth.authenticated) {
    return (
      <section className="rounded-2xl border border-slate-700/80 bg-gradient-to-br from-slate-900/90 via-slate-900/70 to-red-950/20 p-6 text-center">
        <Youtube className="mx-auto mb-3 text-red-500" size={36} />
        <h2 className="text-lg font-black text-white">{t('partners.studioNeedLoginTitle')}</h2>
        <p className="mt-2 text-sm text-slate-400 max-w-lg mx-auto">{t('partners.studioNeedLoginBody')}</p>
      </section>
    );
  }

  if (canApply) {
    return (
      <section className="rounded-2xl border border-red-500/20 bg-gradient-to-br from-slate-950 via-slate-900 to-red-950/30 overflow-hidden shadow-2xl shadow-red-950/20">
        <button
          type="button"
          onClick={() => setApplyOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-3 px-5 py-4 bg-gradient-to-r from-red-950/50 to-slate-900/80 text-left"
        >
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-600 text-white shadow-lg shadow-red-900/40">
              <Youtube size={22} />
            </span>
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-red-300/90 font-bold">
                {t('partners.studioApplyEyebrow')}
              </div>
              <div className="font-black text-white text-lg leading-tight">{t('partners.studioApplyTitle')}</div>
            </div>
          </div>
          {applyOpen ? <ChevronUp className="text-slate-400" /> : <ChevronDown className="text-slate-400" />}
        </button>

        {applyOpen && (
          <div className="p-5 sm:p-6 border-t border-slate-800 space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 p-4">
                <Gem className="text-emerald-400 mb-2" size={20} />
                <div className="text-sm font-bold text-white">{t('partners.studioBenefitRoomTitle')}</div>
                <p className="text-xs text-slate-400 mt-1">{t('partners.studioBenefitRoomBody')}</p>
              </div>
              <div className="rounded-xl border border-amber-800/40 bg-amber-950/20 p-4">
                <Rocket className="text-amber-400 mb-2" size={20} />
                <div className="text-sm font-bold text-white">{t('partners.studioBenefitVideoTitle')}</div>
                <p className="text-xs text-slate-400 mt-1">{t('partners.studioBenefitVideoBody')}</p>
              </div>
              <div className="rounded-xl border border-sky-800/40 bg-sky-950/20 p-4">
                <Clock className="text-sky-400 mb-2" size={20} />
                <div className="text-sm font-bold text-white">{t('partners.studioBenefitRuleTitle')}</div>
                <p className="text-xs text-slate-400 mt-1">{t('partners.studioBenefitRuleBody')}</p>
              </div>
            </div>

            {application?.status === 'rejected' && (
              <div className="rounded-xl border border-red-800/50 bg-red-950/30 px-4 py-3 text-sm text-red-200">
                {t('partners.studioRejectedPrefix')}
                {application.rejectReason ? `: ${application.rejectReason}` : '.'}
              </div>
            )}

            <form onSubmit={onApply} className="grid gap-4 lg:grid-cols-[220px_1fr]">
              <div className="space-y-3">
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {t('partners.studioCoverRequired')}
                </label>
                <button
                  type="button"
                  onClick={() => applyFileRef.current?.click()}
                  className="group relative flex aspect-square w-full max-w-[220px] mx-auto lg:mx-0 flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-slate-600 bg-slate-950/80 hover:border-red-500/60 transition"
                >
                  {avatarPreview ? (
                    <img src={avatarPreview} alt="" className="absolute inset-0 h-full w-full object-cover" />
                  ) : (
                    <>
                      <ImagePlus className="text-slate-500 group-hover:text-red-400 mb-2" size={32} />
                      <span className="text-xs font-bold text-slate-400 px-3 text-center">
                        {t('partners.studioUploadPc')}
                      </span>
                    </>
                  )}
                  <span className="absolute bottom-2 right-2 rounded-lg bg-black/70 p-2 text-white">
                    <Camera size={16} />
                  </span>
                </button>
                <input
                  ref={applyFileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => void handleAvatarPick(e.target.files?.[0], 'apply')}
                />
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    {t('partners.studioChannelName')}
                  </label>
                  <input
                    value={channelName}
                    onChange={(e) => setChannelName(e.target.value)}
                    maxLength={PARTNER_CHANNEL_NAME_MAX}
                    required
                    minLength={2}
                    placeholder={t('partners.studioChannelNamePh')}
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/40"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    {t('partners.studioChannelUrl')}
                  </label>
                  <input
                    value={channelUrl}
                    onChange={(e) => setChannelUrl(e.target.value)}
                    maxLength={PARTNER_CHANNEL_URL_MAX}
                    required
                    placeholder={t('partners.studioChannelUrlPh')}
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500/40"
                  />
                  <p className="text-[11px] text-slate-500 mt-1 flex items-center gap-1">
                    <Lock size={12} /> {t('partners.studioUrlLockedHint')}
                  </p>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    {t('partners.studioDescOptional')}
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={PARTNER_CHANNEL_DESCRIPTION_MAX}
                    rows={3}
                    placeholder={t('partners.studioDescPh')}
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-red-500/40"
                  />
                </div>
                {applyErr && <p className="text-sm text-red-400">{applyErr}</p>}
                <button
                  type="submit"
                  disabled={applyBusy || !avatarUrl}
                  className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-red-600 to-orange-600 px-5 py-3 text-sm font-black uppercase tracking-wide text-white shadow-lg shadow-red-900/30 disabled:opacity-40"
                >
                  {applyBusy ? <Loader2 className="animate-spin" size={18} /> : <Sparkles size={18} />}
                  {t('partners.studioSendApply')}
                </button>
              </div>
            </form>
          </div>
        )}
      </section>
    );
  }

  if (application?.status === 'pending') {
    return (
      <section className="rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-950/30 to-slate-900/80 p-6 text-center">
        <Clock className="mx-auto mb-3 text-amber-400 animate-pulse" size={40} />
        <h2 className="text-xl font-black text-white">{t('partners.studioPendingTitle')}</h2>
        <p className="mt-2 text-sm text-slate-300 max-w-md mx-auto">
          {emphasizeName(t('partners.studioPendingBody', { name: application.channelName }), application.channelName)}
        </p>
        <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-amber-700/50 bg-amber-950/40 px-4 py-1.5 text-xs font-bold text-amber-200 uppercase">
          {t('partners.studioPendingBadge', { date: formatPartnerDateShort(application.createdAt, locale) })}
        </div>
      </section>
    );
  }

  if (!isPartner) return null;

  return (
    <div className="space-y-6">
      {nftRoom?.active && (
        <section
          className={`rounded-2xl border px-4 py-3 flex flex-wrap items-center gap-3 ${
            nftRoom.overdue
              ? 'border-red-700/50 bg-red-950/30'
              : 'border-emerald-700/40 bg-emerald-950/20'
          }`}
        >
          <Gem className={nftRoom.overdue ? 'text-red-400' : 'text-emerald-400'} size={22} />
          <div className="flex-1 min-w-[200px]">
            <div className="text-sm font-bold text-white">
              {nftRoom.overdue ? t('partners.studioRoomRisk') : t('partners.studioRoomActive')}
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {nftRoom.overdue
                ? t('partners.studioRoomOverdueHint')
                : nftRoom.nextDeadlineAt
                  ? t('partners.studioRoomDeadline', {
                      date: formatPartnerDateShort(nftRoom.nextDeadlineAt, locale),
                      count: String(nftRoom.approvedLast60d)
                    })
                  : t('partners.studioRoomFirstVideo')}
            </p>
          </div>
          <span
            className={`text-[10px] font-black uppercase px-2.5 py-1 rounded-full border ${
              nftRoom.compliant ? 'border-emerald-600/50 text-emerald-300' : 'border-red-600/50 text-red-300'
            }`}
          >
            {nftRoom.compliant ? t('partners.studioCompliant') : t('partners.studioOverdue')}
          </span>
        </section>
      )}

      <section className="rounded-2xl border border-slate-700 bg-slate-900/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-2">
          <BadgeCheck className="text-emerald-400" size={20} />
          <h2 className="font-black text-white">{t('partners.studioYourChannel')}</h2>
        </div>
        <form onSubmit={onSaveProfile} className="p-5 grid gap-4 lg:grid-cols-[160px_1fr]">
          <div>
            <button
              type="button"
              onClick={() => editFileRef.current?.click()}
              className="relative mx-auto lg:mx-0 flex h-36 w-36 overflow-hidden rounded-2xl border border-slate-700 bg-slate-950"
            >
              {editPreview ? (
                <img src={editPreview} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="grid place-items-center text-slate-500 text-xs p-3 text-center">
                  {t('partners.studioNoCover')}
                </div>
              )}
              <span className="absolute bottom-2 right-2 rounded-lg bg-black/70 p-1.5 text-white">
                <Camera size={14} />
              </span>
            </button>
            <input
              ref={editFileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => void handleAvatarPick(e.target.files?.[0], 'edit')}
            />
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                {t('partners.studioChannelName')}
              </label>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                maxLength={PARTNER_CHANNEL_NAME_MAX}
                required
                className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                {t('partners.studioChannelUrlReadonly')}
              </label>
              <input
                value={profile?.channelUrl || ''}
                readOnly
                disabled
                className="w-full rounded-xl bg-slate-900/50 border border-slate-800 px-3 py-2.5 text-sm text-slate-500 cursor-not-allowed"
              />
            </div>
            {profileErr && <p className="text-sm text-red-400">{profileErr}</p>}
            <button
              type="submit"
              disabled={profileBusy}
              className="rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
            >
              {profileBusy ? t('partners.studioSaving') : t('partners.studioSaveProfile')}
            </button>
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-slate-700 bg-slate-900/60 overflow-hidden">
        <button
          type="button"
          onClick={() => setFormOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-slate-800/80 hover:bg-slate-800 text-left"
        >
          <div className="flex items-center gap-2">
            <Rocket size={18} className="text-amber-400" />
            <span className="font-bold">{t('partners.studioSubmitVideo')}</span>
          </div>
          {formOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
        {formOpen && (
          <div className="p-4 sm:p-5 border-t border-slate-800 space-y-3">
            {!auth.canSubmitToday && (
              <div className="text-sm text-amber-200/90 bg-amber-950/25 border border-amber-900/40 rounded-lg px-3 py-2">
                {t('partners.studioDailyLimit')}
              </div>
            )}
            <form onSubmit={onSubmitVideo} className="space-y-3">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={PARTNER_VIDEO_TITLE_MAX}
                required
                minLength={3}
                placeholder={t('partners.studioVideoTitlePh')}
                className="w-full rounded-lg bg-slate-950 border border-slate-600 px-3 py-2 text-sm"
              />
              <input
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
                maxLength={PARTNER_VIDEO_YOUTUBE_URL_MAX}
                required
                placeholder={t('partners.studioYoutubeUrlPh')}
                className="w-full rounded-lg bg-slate-950 border border-slate-600 px-3 py-2 text-sm"
              />
              <textarea
                value={videoDesc}
                onChange={(e) => setVideoDesc(e.target.value)}
                maxLength={PARTNER_VIDEO_DESCRIPTION_MAX}
                rows={2}
                placeholder={t('partners.studioVideoDescPh')}
                className="w-full rounded-lg bg-slate-950 border border-slate-600 px-3 py-2 text-sm resize-y"
              />
              {submitErr && <p className="text-sm text-red-400">{submitErr}</p>}
              <button
                type="submit"
                disabled={submitting || !auth.canSubmitToday}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-sm font-black uppercase"
              >
                {submitting ? <Loader2 className="animate-spin" size={18} /> : <Rocket size={18} />}
                {t('partners.studioSubmitBtn')}
              </button>
            </form>
          </div>
        )}
      </section>

      {mySubs.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-bold text-white">{t('partners.studioMySubmissions')}</h2>
          <ul className="space-y-2">
            {mySubs.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-white truncate">{s.title}</div>
                  <div className="text-[11px] text-slate-500">{formatPartnerDateShort(s.createdAt, locale)}</div>
                </div>
                <span className={`text-[10px] font-black uppercase px-2 py-1 rounded border ${statusClass(s.status)}`}>
                  {statusLabel(s.status, t)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
