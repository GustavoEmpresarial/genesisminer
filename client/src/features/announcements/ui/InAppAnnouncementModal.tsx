import React, { useEffect } from 'react';
import { ExternalLink, Info, X } from 'lucide-react';
import { isSafeHttpsLink, normalizeSafeInAppImagePath } from '../../../shared/utils/inAppAnnouncementSafe';
import { RemoteBannerImage } from '../../mini-blog/ui/RemoteBannerImage';

export type InAppAnnouncement = {
  id: string;
  title: string;
  message: string;
  link: string | null;
  imageUrl?: string | null;
};

type Props = {
  announcement: InAppAnnouncement | null;
  onDismiss: () => void;
  dismissing?: boolean;
};

export const InAppAnnouncementModal: React.FC<Props> = ({ announcement, onDismiss, dismissing }) => {
  useEffect(() => {
    if (!announcement || dismissing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [announcement, dismissing, onDismiss]);

  if (!announcement) return null;

  const rawLink = announcement.link?.trim() || null;
  const link = rawLink && isSafeHttpsLink(rawLink) ? rawLink : null;
  const imageUrl = normalizeSafeInAppImagePath(announcement.imageUrl);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-label={announcement.title || 'Aviso'}
      onClick={onDismiss}
    >
      <div
        className="flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-slate-600/80 bg-slate-900 p-5 shadow-2xl dark:bg-slate-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex shrink-0 items-start justify-between">
          <div className="inline-flex rounded-full bg-amber-500/20 p-2 text-amber-400">
            <Info size={22} aria-hidden />
          </div>
          <button
            type="button"
            onClick={onDismiss}
            disabled={dismissing}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:opacity-50"
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
          <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-white">
            {announcement.title}
          </h3>
          {imageUrl ? (
            <div className="mb-3 overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
              <RemoteBannerImage
                src={imageUrl}
                alt={announcement.title}
                className="max-h-56 w-full object-contain"
                failureHint="Imagem indisponível"
              />
            </div>
          ) : null}
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{announcement.message}</p>
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-amber-400 hover:text-amber-300"
            >
              Saiba mais
              <ExternalLink size={14} aria-hidden />
            </a>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          disabled={dismissing}
          className="mt-6 w-full shrink-0 rounded-xl bg-orange-600 py-2.5 text-xs font-black uppercase tracking-widest text-white transition hover:bg-orange-500 disabled:opacity-60"
        >
          {dismissing ? 'A guardar…' : 'Li'}
        </button>
      </div>
    </div>
  );
};
