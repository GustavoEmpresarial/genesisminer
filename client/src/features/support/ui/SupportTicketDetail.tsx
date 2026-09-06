/**
 * Ticket detail tab — timeline, archive/reopen, follow-up reply.
 */
import { Archive, ChevronLeft, Loader2, Paperclip, Send, X } from 'lucide-react';
import {
  SUPPORT_TICKET_MESSAGE_MAX,
  type MySupportTicketDetail
} from '../../../shared/api/support';
import { buildSupportTimeline } from '../lib/supportTimeline';
import { SUPPORT_FILE_ACCEPT } from '../lib/supportAccept';
import { SupportAttachmentLinks } from './SupportAttachmentLinks';

type SupportTicketDetailProps = {
  detail: MySupportTicketDetail | null;
  detailLoading: boolean;
  detailActionErr: string | null;
  followMsg: string;
  followFiles: File[];
  followSending: boolean;
  followErr: string | null;
  fmt: (ts: unknown) => string;
  onBack: () => void;
  onArchive: () => void;
  onReopen: () => void;
  onFollowMsgChange: (v: string) => void;
  onPickFollow: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveFollowFile: (index: number) => void;
  onSendFollow: () => void;
  t: (key: string, vars?: Record<string, string>) => string;
};

export function SupportTicketDetailView({
  detail,
  detailLoading,
  detailActionErr,
  followMsg,
  followFiles,
  followSending,
  followErr,
  fmt,
  onBack,
  onArchive,
  onReopen,
  onFollowMsgChange,
  onPickFollow,
  onRemoveFollowFile,
  onSendFollow,
  t
}: SupportTicketDetailProps) {
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs font-bold text-sky-400 hover:text-sky-300"
      >
        <ChevronLeft size={16} />
        {t('support.backToList')}
      </button>
      {detailLoading ? <div className="py-6 text-sm text-slate-500">{t('support.loading')}</div> : null}
      {!detailLoading && !detail ? (
        <p className="text-sm text-red-400">{t('support.detailLoadError')}</p>
      ) : null}
      {detail ? (
        <>
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <h3 className="min-w-0 flex-1 break-words text-base font-bold text-white">{detail.ticket.subject}</h3>
            <span
              className={`shrink-0 rounded px-2 py-1 text-[10px] font-bold uppercase ${
                detail.ticket.status === 'archived'
                  ? 'bg-slate-800 text-slate-400'
                  : 'bg-emerald-900/40 text-emerald-300'
              }`}
            >
              {detail.ticket.status === 'archived' ? t('support.statusArchived') : t('support.statusOpen')}
            </span>
          </div>
          {detail.ticket.status === 'archived' ? (
            <div className="flex items-start gap-2 rounded-lg border border-slate-600 bg-slate-950/80 px-3 py-2 text-xs text-slate-400">
              <Archive size={16} className="mt-0.5 shrink-0 text-slate-500" />
              <span>{t('support.archivedHint')}</span>
            </div>
          ) : null}

          {detailActionErr ? (
            <div className="rounded-lg border border-red-900/40 px-3 py-2 text-xs text-red-400">{detailActionErr}</div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {detail.ticket.status === 'open' ? (
              <button
                type="button"
                disabled={detailLoading}
                onClick={onArchive}
                className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-bold text-slate-300 hover:bg-slate-800"
              >
                {t('support.archive')}
              </button>
            ) : null}
            {detail.ticket.status === 'archived' ? (
              <button
                type="button"
                disabled={detailLoading}
                onClick={onReopen}
                className="rounded-lg border border-sky-700/50 px-3 py-1.5 text-xs font-bold text-sky-200 hover:bg-sky-950/40"
              >
                {t('support.reopen')}
              </button>
            ) : null}
          </div>

          <div className="space-y-4 border-t border-slate-800 pt-4">
            <div className="text-[10px] font-bold uppercase text-slate-500">{t('support.conversation')}</div>
            {buildSupportTimeline(detail).map((entry, idx) => (
              <div
                key={`${entry.kind}-${idx}-${entry.at}`}
                className={`rounded-lg border p-3 ${
                  entry.kind === 'admin'
                    ? 'ml-0 border-emerald-900/50 bg-emerald-950/20 sm:ml-4'
                    : entry.kind === 'player'
                      ? 'mr-0 border-slate-600 bg-slate-950/60 sm:mr-4'
                      : 'border-sky-900/30 bg-sky-950/10'
                }`}
              >
                <div className="mb-1 text-[10px] text-slate-500">
                  {entry.kind === 'open' ? t('support.timelineOpen') : null}
                  {entry.kind === 'player' ? t('support.timelineYou') : null}
                  {entry.kind === 'admin' ? (
                    <span className="font-semibold text-emerald-400">
                      {t('support.timelineTeam', { name: entry.adminUsername || 'admin' })}
                    </span>
                  ) : null}
                  {' · '}
                  {fmt(entry.at)}
                </div>
                {entry.message ? (
                  <pre className="max-w-full whitespace-pre-wrap break-words font-sans text-sm text-slate-200 [overflow-wrap:anywhere]">
                    {entry.message}
                  </pre>
                ) : null}
                <SupportAttachmentLinks
                  items={entry.attachments}
                  unavailableLabel={t('support.attachmentUnavailable')}
                  videoFallback={t('support.video')}
                />
              </div>
            ))}
          </div>

          {detail.ticket.status === 'open' ? (
            <div className="space-y-3 rounded-xl border border-slate-700 bg-slate-950/50 p-3 sm:p-4">
              <div className="text-xs font-bold uppercase text-sky-400/90">{t('support.followUp')}</div>
              {followErr ? <div className="break-words text-xs text-red-400">{followErr}</div> : null}
              <textarea
                value={followMsg}
                onChange={(e) => onFollowMsgChange(e.target.value)}
                rows={4}
                maxLength={SUPPORT_TICKET_MESSAGE_MAX}
                placeholder={t('support.followPlaceholder')}
                className="w-full min-w-0 resize-y rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500/40"
              />
              <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-xs text-slate-400">
                <Paperclip size={14} />
                {t('support.attachments')}
                <input type="file" accept={SUPPORT_FILE_ACCEPT} multiple className="hidden" onChange={onPickFollow} />
              </label>
              {followFiles.length > 0 ? (
                <ul className="space-y-1 text-[11px] text-slate-400">
                  {followFiles.map((f, i) => (
                    <li key={i} className="flex min-w-0 justify-between gap-2">
                      <span className="min-w-0 truncate">{f.name}</span>
                      <button
                        type="button"
                        className="shrink-0 p-1 text-red-400"
                        onClick={() => onRemoveFollowFile(i)}
                        aria-label={t('support.remove')}
                      >
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <button
                type="button"
                disabled={followSending}
                onClick={onSendFollow}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-50 sm:w-auto"
              >
                {followSending ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
                {t('support.sendMessage')}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
