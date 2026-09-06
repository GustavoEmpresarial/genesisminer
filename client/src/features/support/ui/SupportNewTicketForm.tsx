/**
 * New-ticket form tab.
 */
import { Loader2, Paperclip, Send } from 'lucide-react';
import {
  SUPPORT_ATTACHMENT_MAX_COUNT,
  SUPPORT_TICKET_MESSAGE_MAX,
  SUPPORT_TICKET_SUBJECT_MAX
} from '../../../shared/api/support';
import { SUPPORT_FILE_ACCEPT } from '../lib/supportAccept';

type SupportNewTicketFormProps = {
  subject: string;
  message: string;
  files: File[];
  sending: boolean;
  done: string | null;
  err: string | null;
  onSubjectChange: (v: string) => void;
  onMessageChange: (v: string) => void;
  onPickFiles: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveFile: (index: number) => void;
  onSubmit: (e: React.FormEvent) => void;
  t: (key: string) => string;
};

export function SupportNewTicketForm({
  subject,
  message,
  files,
  sending,
  done,
  err,
  onSubjectChange,
  onMessageChange,
  onPickFiles,
  onRemoveFile,
  onSubmit,
  t
}: SupportNewTicketFormProps) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {done ? (
        <div className="rounded-lg border border-emerald-600/40 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200">
          {done}
        </div>
      ) : null}
      {err ? (
        <div className="rounded-lg border border-red-600/40 bg-red-950/30 px-3 py-2 text-sm text-red-300">{err}</div>
      ) : null}

      <label className="block space-y-1">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-400">{t('support.subject')}</span>
        <input
          type="text"
          value={subject}
          onChange={(e) => onSubjectChange(e.target.value)}
          maxLength={SUPPORT_TICKET_SUBJECT_MAX}
          required
          minLength={3}
          placeholder={t('support.subjectPlaceholder')}
          className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500/40"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-400">{t('support.message')}</span>
        <textarea
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          required
          minLength={10}
          maxLength={SUPPORT_TICKET_MESSAGE_MAX}
          rows={8}
          placeholder={t('support.messagePlaceholder')}
          className="min-h-[140px] w-full resize-y rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-500/40"
        />
      </label>

      <div className="space-y-2">
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
          <Paperclip size={14} /> {t('support.attachmentsOptional')}
        </span>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-600 px-3 py-2 text-sm text-slate-300 transition hover:border-sky-500/50 hover:text-sky-200">
          <input
            type="file"
            accept={SUPPORT_FILE_ACCEPT}
            multiple
            className="hidden"
            onChange={onPickFiles}
            disabled={files.length >= SUPPORT_ATTACHMENT_MAX_COUNT}
          />
          {t('support.chooseFiles')}
        </label>
        {files.length > 0 ? (
          <ul className="space-y-1 font-mono text-xs text-slate-400">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="flex items-center justify-between gap-2 rounded border border-slate-700 bg-slate-950/80 px-2 py-1"
              >
                <span className="truncate">{f.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveFile(i)}
                  className="shrink-0 text-red-400 hover:text-red-300"
                >
                  {t('support.remove')}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={sending}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-sky-600/20 transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
      >
        {sending ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
        {t('support.submit')}
      </button>
    </form>
  );
}
