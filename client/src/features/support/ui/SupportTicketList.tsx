/**
 * Ticket list tab — summaries only; open detail via `onOpen`.
 */
import type { MySupportTicketSummary } from '../../../shared/api/support';

type SupportTicketListProps = {
  loading: boolean;
  list: MySupportTicketSummary[];
  fmt: (ts: unknown) => string;
  onOpen: (id: string) => void;
  t: (key: string, vars?: Record<string, string>) => string;
};

export function SupportTicketList({ loading, list, fmt, onOpen, t }: SupportTicketListProps) {
  if (loading) {
    return <div className="py-10 text-center text-sm text-slate-500">{t('support.loading')}</div>;
  }
  if (list.length === 0) {
    return <p className="py-10 text-center text-sm text-slate-400">{t('support.emptyList')}</p>;
  }
  return (
    <ul className="space-y-2.5">
      {list.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            onClick={() => onOpen(row.id)}
            className="w-full min-w-0 rounded-xl border border-slate-700/90 bg-slate-950/70 px-3 py-3 text-left shadow-sm transition hover:border-sky-500/45 hover:shadow-[0_10px_28px_-16px_rgba(56,189,248,0.45)] sm:px-4"
          >
            <div className="break-words text-sm font-bold text-white">{row.subject}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              <span
                className={`rounded px-2 py-0.5 font-bold uppercase ${
                  row.status === 'archived'
                    ? 'bg-slate-800 text-slate-400'
                    : 'bg-emerald-900/40 text-emerald-300'
                }`}
              >
                {row.status === 'archived' ? t('support.statusArchived') : t('support.statusOpen')}
              </span>
              <span>{fmt(row.createdAt)}</span>
              {row.unreadStaffReply ? (
                <span className="font-bold text-sky-400">{t('support.newFromTeam')}</span>
              ) : null}
              {row.adminReplyCount > 0 ? (
                <span className="text-sky-600/90">
                  {t('support.teamReplyCount', { count: String(row.adminReplyCount) })}
                </span>
              ) : null}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
