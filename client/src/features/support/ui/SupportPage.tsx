/**
 * Player support hub — list / new / detail tickets.
 * API: `shared/api/support.ts` · DECISIONS #96 / #98.
 *
 * Layout: HubPanel chrome; tab bodies live in `components/`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { LifeBuoy, List, MessageCircle } from 'lucide-react';
import {
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENT_MAX_COUNT,
  archiveSupportTicket,
  getMySupportTicketDetail,
  getSupportState,
  newSupportIdempotencyKey,
  postPlayerSupportTicketReply,
  reopenSupportTicket,
  submitSupportTicket,
  type MySupportTicketDetail,
  type MySupportTicketSummary
} from '../../../shared/api/support';
import { mapApiErrorToMessage } from '../../../shared/api/client-errors';
import { useI18n, useT } from '../../../shared/i18n';
import { HubPanel } from '../../../shared/ui/HubPanel';
import { formatInstantMs } from '../../../shared/utils/locale-format';
import { SupportNewTicketForm } from './SupportNewTicketForm';
import { SupportTicketDetailView } from './SupportTicketDetail';
import { SupportTicketList } from './SupportTicketList';
import { mergeSupportPicks } from '../lib/mergeSupportPicks';

type Tab = 'list' | 'new' | 'detail';

type SupportPageProps = {
  userEmail?: string | null;
  username?: string | null;
};

export function SupportPage({ userEmail, username }: SupportPageProps) {
  const t = useT();
  const { locale } = useI18n();
  const supportMutateBusyRef = useRef(false);
  const [tab, setTab] = useState<Tab>('list');
  const [list, setList] = useState<MySupportTicketSummary[]>([]);
  const [accountDisplay, setAccountDisplay] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MySupportTicketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [followMsg, setFollowMsg] = useState('');
  const [followFiles, setFollowFiles] = useState<File[]>([]);
  const [followSending, setFollowSending] = useState(false);
  const [followErr, setFollowErr] = useState<string | null>(null);
  const [detailActionErr, setDetailActionErr] = useState<string | null>(null);

  const fileTooLarge = useCallback(
    (name: string, mb: number) => t('support.fileTooLarge', { name, mb: String(mb) }),
    [t]
  );
  const tooManyFiles = useCallback(
    (max: number) => t('support.tooManyFiles', { max: String(max) }),
    [t]
  );

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const st = await getSupportState({ limit: '50' });
      if (!st) {
        setList([]);
        setListError(t('support.loadError'));
        setAccountDisplay((userEmail && userEmail.trim()) || (username && username.trim()) || null);
        return;
      }
      if (st.account) {
        const hint = st.account.emailHint || st.account.username;
        setAccountDisplay(hint || (userEmail && userEmail.trim()) || (username && username.trim()) || null);
      } else {
        setAccountDisplay((userEmail && userEmail.trim()) || (username && username.trim()) || null);
      }
      const rows = st.tickets ?? [];
      setList(
        rows.map((row) => ({
          id: row.publicId,
          subject: row.subject,
          status: row.status,
          createdAt: row.createdAt,
          adminReplyCount: row.adminReplyCount,
          lastActivityAt: row.lastActivityAt,
          unreadStaffReply: row.unreadStaffReply
        }))
      );
    } finally {
      setListLoading(false);
    }
  }, [t, userEmail, username]);

  useEffect(() => {
    if (tab === 'list') void loadList();
  }, [tab, loadList]);

  const openDetail = async (id: string) => {
    setDetailId(id);
    setTab('detail');
    setDetail(null);
    setFollowMsg('');
    setFollowFiles([]);
    setFollowErr(null);
    setDetailActionErr(null);
    setDetailLoading(true);
    try {
      const d = await getMySupportTicketDetail(id);
      setDetail(d);
    } finally {
      setDetailLoading(false);
    }
  };

  const onPickFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = e.target.files;
      if (!picked?.length) return;
      setErr(null);
      setFiles((prev) => {
        const { next, rejectReason } = mergeSupportPicks(
          prev,
          picked,
          SUPPORT_ATTACHMENT_MAX_COUNT,
          SUPPORT_ATTACHMENT_MAX_BYTES,
          fileTooLarge,
          tooManyFiles
        );
        if (rejectReason) setErr(rejectReason);
        return next;
      });
      e.target.value = '';
    },
    [fileTooLarge, tooManyFiles]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (supportMutateBusyRef.current) return;
    setErr(null);
    supportMutateBusyRef.current = true;
    setSending(true);
    try {
      const res = await submitSupportTicket({
        subject,
        message,
        files,
        idempotencyKey: newSupportIdempotencyKey()
      });
      if (!res.ok) {
        setErr(mapApiErrorToMessage(res.error || 'LOAD_FAILED', t, 'support') || t('support.sendFailed'));
        return;
      }
      setDone(t('support.submitSuccess'));
      setSubject('');
      setMessage('');
      setFiles([]);
      await loadList();
    } finally {
      supportMutateBusyRef.current = false;
      setSending(false);
    }
  };

  const onPickFollow = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files;
    if (!picked?.length) return;
    setFollowErr(null);
    setFollowFiles((prev) => {
      const { next, rejectReason } = mergeSupportPicks(
        prev,
        picked,
        SUPPORT_ATTACHMENT_MAX_COUNT,
        SUPPORT_ATTACHMENT_MAX_BYTES,
        fileTooLarge,
        tooManyFiles
      );
      if (rejectReason) setFollowErr(rejectReason);
      return next;
    });
    e.target.value = '';
  };

  const sendFollow = async () => {
    if (!detailId || supportMutateBusyRef.current) return;
    setFollowErr(null);
    supportMutateBusyRef.current = true;
    setFollowSending(true);
    try {
      const r = await postPlayerSupportTicketReply({
        ticketId: detailId,
        message: followMsg,
        files: followFiles,
        idempotencyKey: newSupportIdempotencyKey()
      });
      if (!r.ok) {
        setFollowErr(mapApiErrorToMessage(r.error || 'LOAD_FAILED', t, 'support') || t('support.replyFailed'));
        return;
      }
      setFollowMsg('');
      setFollowFiles([]);
      await openDetail(detailId);
      await loadList();
    } finally {
      supportMutateBusyRef.current = false;
      setFollowSending(false);
    }
  };

  const fmt = (ts: unknown) => formatInstantMs(ts, locale);

  const accountLabel =
    accountDisplay || (userEmail && userEmail.trim()) || (username && username.trim()) || t('support.noEmail');

  const goList = () => {
    setTab('list');
    setDetailId(null);
    setDetail(null);
  };

  return (
    <HubPanel
      accent="sky"
      maxWidthClass="max-w-2xl"
      header={
        <div className="flex items-center justify-between gap-2 px-3 py-3 sm:gap-3 sm:px-5 sm:py-3.5">
          <div className="flex min-w-0 items-center gap-2 text-sky-400 sm:gap-2.5">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-cyan-600 text-slate-950 shadow-[0_8px_22px_-8px_rgba(56,189,248,0.7)] sm:h-10 sm:w-10">
              <LifeBuoy size={20} strokeWidth={2.4} />
            </span>
            <div className="min-w-0">
              <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-sky-300/90 sm:text-[10px] sm:tracking-[0.2em]">
                {t('support.eyebrow')}
              </div>
              <h1 className="truncate text-base font-black tracking-tight text-white sm:text-xl">{t('support.title')}</h1>
            </div>
          </div>
        </div>
      }
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-90"
        aria-hidden
        style={{
          background:
            'radial-gradient(ellipse 70% 45% at 12% 0%, rgba(56,189,248,0.16), transparent 55%), radial-gradient(ellipse 50% 40% at 90% 8%, rgba(14,165,233,0.1), transparent 50%)'
        }}
      />

      <div className="relative flex shrink-0 border-b border-slate-800 bg-slate-950/50">
        <button
          type="button"
          onClick={goList}
          className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 px-1 py-2.5 text-center text-[10px] font-bold uppercase leading-tight tracking-wide sm:gap-2 sm:py-3 sm:text-xs ${
            tab === 'list'
              ? 'border-b-2 border-sky-400 bg-slate-900/60 text-sky-300'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          <List size={16} className="shrink-0" />
          <span className="line-clamp-2 max-w-[9.5rem] sm:max-w-none">{t('support.tabList')}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setTab('new');
            setDetailId(null);
            setDetail(null);
            setDone(null);
          }}
          className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 px-1 py-2.5 text-center text-[10px] font-bold uppercase leading-tight tracking-wide sm:gap-2 sm:py-3 sm:text-xs ${
            tab === 'new'
              ? 'border-b-2 border-sky-400 bg-slate-900/60 text-sky-300'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          <MessageCircle size={16} className="shrink-0" />
          <span className="line-clamp-2 max-w-[9.5rem] sm:max-w-none">{t('support.tabNew')}</span>
        </button>
      </div>

      <div className="custom-scrollbar relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
        <p className="mb-4 break-all text-xs text-slate-500">
          {t('support.account')}{' '}
          <span className="font-mono text-slate-300">{accountLabel}</span>
        </p>

        {tab === 'list' ? (
          listError ? (
            <p className="py-10 text-center text-sm text-red-400">{listError}</p>
          ) : (
            <SupportTicketList
              loading={listLoading}
              list={list}
              fmt={fmt}
              onOpen={(id) => void openDetail(id)}
              t={t}
            />
          )
        ) : null}

        {tab === 'detail' ? (
          <SupportTicketDetailView
            detail={detail}
            detailLoading={detailLoading}
            detailActionErr={detailActionErr}
            followMsg={followMsg}
            followFiles={followFiles}
            followSending={followSending}
            followErr={followErr}
            fmt={fmt}
            onBack={goList}
            onArchive={() => {
              void (async () => {
                if (!detailId || supportMutateBusyRef.current) return;
                setDetailActionErr(null);
                supportMutateBusyRef.current = true;
                try {
                  const r = await archiveSupportTicket(detailId);
                  if (!r.ok) {
                    setDetailActionErr(
                      mapApiErrorToMessage(r.error || 'LOAD_FAILED', t, 'support') || t('support.archiveFailed')
                    );
                    return;
                  }
                  await openDetail(detailId);
                  await loadList();
                } finally {
                  supportMutateBusyRef.current = false;
                }
              })();
            }}
            onReopen={() => {
              void (async () => {
                if (!detailId || supportMutateBusyRef.current) return;
                setDetailActionErr(null);
                supportMutateBusyRef.current = true;
                try {
                  const r = await reopenSupportTicket(detailId);
                  if (!r.ok) {
                    setDetailActionErr(
                      mapApiErrorToMessage(r.error || 'LOAD_FAILED', t, 'support') || t('support.reopenFailed')
                    );
                    return;
                  }
                  await openDetail(detailId);
                  await loadList();
                } finally {
                  supportMutateBusyRef.current = false;
                }
              })();
            }}
            onFollowMsgChange={setFollowMsg}
            onPickFollow={onPickFollow}
            onRemoveFollowFile={(i) => setFollowFiles((p) => p.filter((_, j) => j !== i))}
            onSendFollow={() => void sendFollow()}
            t={t}
          />
        ) : null}

        {tab === 'new' ? (
          <SupportNewTicketForm
            subject={subject}
            message={message}
            files={files}
            sending={sending}
            done={done}
            err={err}
            onSubjectChange={setSubject}
            onMessageChange={setMessage}
            onPickFiles={onPickFiles}
            onRemoveFile={(i) => setFiles((prev) => prev.filter((_, j) => j !== i))}
            onSubmit={(e) => void handleSubmit(e)}
            t={t}
          />
        ) : null}
      </div>
    </HubPanel>
  );
}
