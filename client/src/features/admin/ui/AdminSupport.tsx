// @ts-nocheck — template legado 1:1.
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  RefreshCw,
  Archive,
  Inbox,
  ExternalLink,
  Paperclip,
  Send,
  Loader2,
  X,
  History,
  Copy,
  UserCog,
  Search,
  MessageSquare,
} from 'lucide-react';
import {
  getAdminSupportTickets,
  updateAdminSupportTicketStatus,
  postAdminSupportTicketReply,
  getAdminUserActivity,
  getAdminSupportUserHistory,
  getAdminSupportTicketDetail,
  type SupportTicketRow,
  type SupportTicketReplyRow,
  type SupportTicketAttachment,
  type SupportUserHistoryResponse,
} from '../../../shared/api/admin-legacy';
import { SUPPORT_TICKET_MESSAGE_MAX } from '../../../shared/constants/formLimits';
import type { GameUserActivityEntry } from '../lib/adminTypes';
import { ACTIVITY_LOG_FILTER_GROUPS, filterUserActivityLogs, formatAccountCreatedBrt } from '../utils/adminUserActivityLog';
import { AdminActivityLogTable } from './AdminActivityLogTable';
import { AdminUserAccountTracePanel } from './AdminUserAccountTracePanel';
import { safeSupportAttachmentHref } from '../../../shared/utils/supportAttachmentUrls';

export type AdminSupportOpenPlayerPayload = { userId: number; email: string; username: string };

type AdminSupportProps = {
    /** Se o admin tem permissão do separador Utilizadores, mostra o atalho para o editor. */
    canOpenPlayerProfile?: boolean;
    onOpenPlayerProfile?: (p: AdminSupportOpenPlayerPayload) => void;
};

const ACCEPT = 'image/png,image/jpeg,image/jpg,image/gif,image/webp,video/mp4,video/webm,video/quicktime,.mov';

function isVideoAtt(a: { mime?: string; url?: string }) {
  const m = (a.mime || '').toLowerCase();
  if (m.startsWith('video/')) return true;
  const u = (a.url || '').toLowerCase();
  return /\.(mp4|webm|mov)(\?|$)/.test(u);
}

/** userId vindo da API pode ser número ou string; o salto para Utilizadores precisa de número ≥ 0. */
function ticketUserNumericId(t: SupportTicketRow): number {
  const v = t.userId as unknown;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const ReplyAttachments: React.FC<{ items: SupportTicketReplyRow['attachments'] }> = ({ items }) => {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {items.map((a, i) => {
        const href = safeSupportAttachmentHref(a.url);
        const label = a.originalName || (typeof a.url === 'string' ? a.url : 'anexo');
        if (!href) {
          return (
            <span
              key={i}
              className="text-[10px] text-slate-500 border border-slate-800 rounded px-2 py-1 max-w-full truncate"
              title="URL de anexo inválida ou não permitida"
            >
              Anexo bloqueado: {label}
            </span>
          );
        }
        return isVideoAtt({ ...a, url: href }) ? (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 border border-sky-900/50 rounded px-2 py-1"
          >
            <ExternalLink size={11} />
            Vídeo: {label}
          </a>
        ) : (
          <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="block shrink-0">
            <img
              src={href}
              alt={typeof a.originalName === 'string' ? a.originalName : ''}
              className="max-h-24 rounded border border-slate-700 object-cover hover:opacity-90"
            />
          </a>
        );
      })}
    </div>
  );
};

export const AdminSupport: React.FC<AdminSupportProps> = ({
    canOpenPlayerProfile = false,
    onOpenPlayerProfile,
}) => {
  const [tickets, setTickets] = useState<SupportTicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [replyMessage, setReplyMessage] = useState('');
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  const [replying, setReplying] = useState(false);
  const [replyErr, setReplyErr] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'thread' | 'activity' | 'trace'>('thread');
  const [activityLogs, setActivityLogs] = useState<GameUserActivityEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityFilterId, setActivityFilterId] = useState('all');
  const [activitySearch, setActivitySearch] = useState('');
  const [activityAccountCreatedAtMs, setActivityAccountCreatedAtMs] = useState<number | null>(null);
  const [activityExpandedTech, setActivityExpandedTech] = useState<Record<string, boolean>>({});
  const [copiedTicketId, setCopiedTicketId] = useState<string | null>(null);
  type SupportListTab = 'open' | 'archived' | 'userHistory';
  const [listTab, setListTab] = useState<SupportListTab>('open');
  /** Evita duplo clique em Arquivar/Reabrir e mostra estado no botão. */
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);

  const [historyEmail, setHistoryEmail] = useState('');
  const [historySearching, setHistorySearching] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyEmptyUser, setHistoryEmptyUser] = useState(false);
  const [historyData, setHistoryData] = useState<SupportUserHistoryResponse | null>(null);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'open' | 'archived' | 'closed'>('all');
  const [historySubjectSearch, setHistorySubjectSearch] = useState('');
  const [historyOpenTicket, setHistoryOpenTicket] = useState<SupportTicketRow | null>(null);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { tickets: t } = await getAdminSupportTickets();
      setTickets(t);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setReplyMessage('');
    setReplyFiles([]);
    setReplyErr(null);
  }, [openId]);

  useEffect(() => {
    setDetailTab('thread');
  }, [openId]);

  useEffect(() => {
    setOpenId(null);
    setHistoryOpenTicket(null);
    setHistoryError(null);
    setHistoryEmptyUser(false);
    if (listTab !== 'userHistory') {
      setHistoryNotice(null);
    }
  }, [listTab]);

  useEffect(() => {
    if (!historyNotice) return;
    const id = window.setTimeout(() => setHistoryNotice(null), 4500);
    return () => window.clearTimeout(id);
  }, [historyNotice]);

  const openTicketCount = useMemo(() => tickets.filter((x) => x.status !== 'archived').length, [tickets]);
  const archivedTicketCount = useMemo(() => tickets.filter((x) => x.status === 'archived').length, [tickets]);
  const filteredTickets = useMemo(
    () =>
      listTab === 'archived'
        ? tickets.filter((x) => x.status === 'archived')
        : tickets.filter((x) => x.status !== 'archived'),
    [tickets, listTab]
  );

  const filteredHistoryTickets = useMemo(() => {
    if (!historyData?.tickets) return [];
    let rows = historyData.tickets;
    if (historyFilter === 'open') rows = rows.filter((t) => t.status !== 'archived');
    else if (historyFilter === 'archived' || historyFilter === 'closed') {
      rows = rows.filter((t) => t.status === 'archived');
    }
    const q = historySubjectSearch.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (t) =>
          t.subject.toLowerCase().includes(q) ||
          (t.preview || '').toLowerCase().includes(q)
      );
    }
    return rows;
  }, [historyData, historyFilter, historySubjectSearch]);

  const openTicket = useMemo((): SupportTicketRow | null => {
    if (!openId) return null;
    if (listTab === 'userHistory') {
      return historyOpenTicket?.id === openId ? historyOpenTicket : null;
    }
    return tickets.find((x) => x.id === openId) ?? null;
  }, [openId, listTab, historyOpenTicket, tickets]);

  const searchUserHistory = async (opts?: { preserveOpen?: boolean }) => {
    const em = historyEmail.trim();
    if (!em) {
      setHistoryError('Informe um email para buscar.');
      setHistoryData(null);
      setHistoryEmptyUser(false);
      return;
    }
    setHistorySearching(true);
    setHistoryError(null);
    setHistoryEmptyUser(false);
    setHistoryData(null);
    if (!opts?.preserveOpen) {
      setHistoryOpenTicket(null);
      setOpenId(null);
    }
    try {
      const r = await getAdminSupportUserHistory(em);
      if (r.ok === false) {
        if (r.notFound) {
          setHistoryEmptyUser(true);
          setHistoryError('Usuário não encontrado.');
        } else {
          setHistoryError(r.error || 'Erro ao buscar.');
        }
        return;
      }
      setHistoryData(r.data);
      if (r.data.summary.total === 0) {
        setHistoryNotice('Nenhum ticket encontrado para este usuário.');
      }
    } finally {
      setHistorySearching(false);
    }
  };

  const openHistoryTicket = async (ticketId: string) => {
    if (historyDetailLoading) return;
    setHistoryDetailLoading(true);
    setHistoryError(null);
    try {
      const r = await getAdminSupportTicketDetail(ticketId);
      if (r.ok === false) {
        setHistoryError(r.error || 'Não foi possível abrir o ticket.');
        return;
      }
      setHistoryOpenTicket(r.ticket);
      setOpenId(ticketId);
      setDetailTab('thread');
    } finally {
      setHistoryDetailLoading(false);
    }
  };

  const refreshAfterHistoryAction = async () => {
    const currentOpenId = openId;
    if (historyEmail.trim()) {
      await searchUserHistory({ preserveOpen: true });
    }
    if (currentOpenId) {
      const r = await getAdminSupportTicketDetail(currentOpenId);
      if (r.ok === true) {
        setHistoryOpenTicket(r.ticket);
        setOpenId(currentOpenId);
      }
    }
    await load();
  };

  useEffect(() => {
    if (!openId) return;
    setActivityFilterId('all');
    setActivitySearch('');
    setActivityLogs([]);
    setActivityError(null);
    setActivityAccountCreatedAtMs(null);
    setActivityExpandedTech({});
  }, [openId]);

  useEffect(() => {
    if (detailTab !== 'activity' || !openId) return;
    const t = openTicket;
    if (!t) return;
    const uidN = ticketUserNumericId(t);
    const uid = uidN > 0 ? uidN : undefined;
    if (!t.email?.trim() && !uid) return;
    let cancelled = false;
    (async () => {
      setActivityLoading(true);
      setActivityError(null);
      const { logs, error, accountCreatedAtMs } = await getAdminUserActivity(t.email || '', { userId: uid, limit: 150 });
      if (cancelled) return;
      setActivityLoading(false);
      if (error) {
        setActivityError(error);
        setActivityLogs([]);
        setActivityAccountCreatedAtMs(null);
      } else {
        setActivityLogs(logs);
        setActivityAccountCreatedAtMs(accountCreatedAtMs ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detailTab, openId, openTicket]);

  const filteredActivityLogs = useMemo(
    () => filterUserActivityLogs(activityLogs, activityFilterId, activitySearch, { accountCreatedAtMs: activityAccountCreatedAtMs }),
    [activityLogs, activityFilterId, activitySearch, activityAccountCreatedAtMs]
  );

  const copyPlayerEmail = async (email: string, ticketId: string) => {
    const em = email.trim();
    if (!em) return;
    const done = () => {
      setCopiedTicketId(ticketId);
      window.setTimeout(() => {
        setCopiedTicketId((v) => (v === ticketId ? null : v));
      }, 2000);
    };
    try {
      await navigator.clipboard.writeText(em);
      done();
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = em;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch {
        alert('Não foi possível copiar o email.');
      }
    }
  };

  const refreshTicketActivity = async (t: SupportTicketRow) => {
    const uidN = ticketUserNumericId(t);
    const uid = uidN > 0 ? uidN : undefined;
    if (!t.email?.trim() && !uid) return;
    setActivityLoading(true);
    setActivityError(null);
    const { logs, error, accountCreatedAtMs } = await getAdminUserActivity(t.email || '', { userId: uid, limit: 150 });
    setActivityLoading(false);
    if (error) {
      setActivityError(error);
      setActivityLogs([]);
      setActivityAccountCreatedAtMs(null);
    } else {
      setActivityLogs(logs);
      setActivityAccountCreatedAtMs(accountCreatedAtMs ?? null);
    }
  };

  const archive = async (id: string) => {
    if (statusBusyId) return;
    setStatusBusyId(id);
    try {
      const r = await updateAdminSupportTicketStatus(id, 'archived');
      if (!r.ok) {
        setHistoryError(r.error || 'Erro ao arquivar.');
        return;
      }
      if (listTab === 'userHistory') await refreshAfterHistoryAction();
      else await load();
    } finally {
      setStatusBusyId(null);
    }
  };

  const reopen = async (id: string) => {
    if (statusBusyId) return;
    setStatusBusyId(id);
    try {
      const r = await updateAdminSupportTicketStatus(id, 'open');
      if (!r.ok) {
        setHistoryError(r.error || 'Erro ao reabrir.');
        return;
      }
      if (listTab === 'userHistory') await refreshAfterHistoryAction();
      else await load();
    } finally {
      setStatusBusyId(null);
    }
  };

  const onPickReplyFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list?.length) return;
    setReplyFiles((prev) => {
      const next = [...prev];
      for (let i = 0; i < list.length && next.length < 5; i++) {
        const f = list.item(i);
        if (f) next.push(f);
      }
      return next;
    });
    e.target.value = '';
  };

  const removeReplyFile = (idx: number) => {
    setReplyFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const sendReply = async (ticketId: string) => {
    const msg = replyMessage.trim();
    if (msg.length < 3 && replyFiles.length === 0) {
      setReplyErr('Escreve pelo menos 3 caracteres ou anexa ficheiros.');
      return;
    }
    setReplyErr(null);
    setReplying(true);
    try {
      const r = await postAdminSupportTicketReply({
        ticketId,
        message: replyMessage,
        files: replyFiles,
      });
      if (!r.ok) {
        setReplyErr(r.error || 'Falha ao enviar.');
        return;
      }
      setReplyMessage('');
      setReplyFiles([]);
      if (listTab === 'userHistory') await refreshAfterHistoryAction();
      else await load();
    } finally {
      setReplying(false);
    }
  };

  const canSendReply = replyMessage.trim().length >= 3 || replyFiles.length > 0;

  const fmt = (ts: unknown) => {
    if (ts == null) return '—';
    const n = typeof ts === 'string' ? Number(ts) : typeof ts === 'number' ? ts : NaN;
    if (!Number.isFinite(n) || n <= 0) return '—';
    const d = new Date(Math.trunc(n));
    if (Number.isNaN(d.getTime())) return '—';
    try {
      return d.toLocaleString('pt-PT');
    } catch {
      return '—';
    }
  };

  const toTime = (ts: unknown): number => {
    if (ts == null) return 0;
    const n = typeof ts === 'string' ? Number(ts) : typeof ts === 'number' ? ts : NaN;
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  };

  const buildAdminTimeline = (t: SupportTicketRow) => {
    type E =
      | { k: 'open'; at: number; message: string; attachments: SupportTicketAttachment[] }
      | { k: 'player'; at: number; message: string; attachments: SupportTicketAttachment[] }
      | { k: 'admin'; at: number; adminUsername: string; message: string; attachments: SupportTicketAttachment[] };
    const out: E[] = [
      {
        k: 'open',
        at: toTime(t.createdAt),
        message: t.message,
        attachments: Array.isArray(t.attachments) ? t.attachments : [],
      },
    ];
    for (const p of t.playerReplies || []) {
      out.push({
        k: 'player',
        at: toTime(p.createdAt),
        message: p.message,
        attachments: Array.isArray(p.attachments) ? p.attachments : [],
      });
    }
    for (const r of t.replies || []) {
      out.push({
        k: 'admin',
        at: toTime(r.createdAt),
        adminUsername: r.adminUsername,
        message: r.message,
        attachments: Array.isArray(r.attachments) ? r.attachments : [],
      });
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  };

  const renderTicketDetailPanel = (t: SupportTicketRow) => (
    <div className="px-4 pb-4 pt-2 border-t border-slate-800 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-600 overflow-hidden text-[11px] font-bold">
            <button
              type="button"
              onClick={() => setDetailTab('thread')}
              className={`px-3 py-1.5 inline-flex items-center gap-1 ${
                detailTab === 'thread'
                  ? 'bg-amber-600 text-white'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              Conversa
            </button>
            <button
              type="button"
              onClick={() => setDetailTab('activity')}
              className={`px-3 py-1.5 inline-flex items-center gap-1 ${
                detailTab === 'activity'
                  ? 'bg-amber-600 text-white'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              <History size={12} /> Atividade
            </button>
            <button
              type="button"
              onClick={() => setDetailTab('trace')}
              className={`px-3 py-1.5 inline-flex items-center gap-1 ${
                detailTab === 'trace'
                  ? 'bg-amber-600 text-white'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Search size={12} /> Rastreio
            </button>
          </div>
          <button
            type="button"
            onClick={() => void copyPlayerEmail(t.email, t.id)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-600 px-2 py-1 text-[10px] font-bold uppercase text-amber-500/95 hover:bg-slate-800"
            title="Copiar email do jogador"
          >
            <Copy size={12} />
            {copiedTicketId === t.id ? 'Copiado' : 'Copiar email'}
          </button>
          {onOpenPlayerProfile && (
            <button
              type="button"
              disabled={!canOpenPlayerProfile}
              onClick={() => {
                if (!canOpenPlayerProfile) return;
                onOpenPlayerProfile({
                  userId: ticketUserNumericId(t),
                  email: t.email,
                  username: t.username,
                });
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-amber-600/70 px-2 py-1 text-[10px] font-bold uppercase text-amber-500 hover:bg-amber-950/30 hover:bg-slate-800/80 disabled:pointer-events-none disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                canOpenPlayerProfile
                  ? 'Abrir editor de perfil, estoque e dados do jogador'
                  : 'Precisa da permissão Utilizadores'
              }
            >
              <UserCog size={12} />
              Gerir perfil
            </button>
          )}
        </div>
      </div>

      {detailTab === 'thread' ? (
        <>
          <div className="text-[10px] font-bold text-slate-500 uppercase">Conversa (ordem cronológica)</div>
          <ul className="space-y-3">
            {buildAdminTimeline(t).map((e, idx) => (
              <li
                key={`${e.k}-${idx}-${e.at}`}
                className={`text-sm rounded-lg p-3 border ${
                  e.k === 'admin'
                    ? 'border-emerald-900/50 bg-emerald-950/15'
                    : e.k === 'player'
                      ? 'border-slate-600 bg-slate-950/60'
                      : 'border-amber-900/30 bg-amber-950/10'
                }`}
              >
                <div className="text-[10px] text-slate-500 mb-1">
                  {e.k === 'open' && <span className="text-amber-200/90 font-semibold">Pedido inicial</span>}
                  {e.k === 'player' && <span className="text-slate-300 font-semibold">Jogador (seguimento)</span>}
                  {e.k === 'admin' && (
                    <span className="text-emerald-400 font-semibold">Equipe - {e.adminUsername || 'admin'}</span>
                  )}
                  {' · '}
                  {fmt(e.at)}
                </div>
                {e.message ? (
                  <pre className="whitespace-pre-wrap text-slate-300 font-sans text-[13px]">{e.message}</pre>
                ) : null}
                <ReplyAttachments items={e.attachments} />
              </li>
            ))}
          </ul>

          {t.status !== 'archived' ? (
            <div className="rounded-lg border border-amber-900/30 bg-slate-950/50 p-3 space-y-2">
              <div className="text-xs font-bold text-amber-500/90 uppercase">Responder ao jogador</div>
              {replyErr && <div className="text-xs text-red-400">{replyErr}</div>}
              <textarea
                value={replyMessage}
                onChange={(e) => setReplyMessage(e.target.value)}
                rows={4}
                maxLength={SUPPORT_TICKET_MESSAGE_MAX}
                placeholder="Texto da resposta (mín. 3 caracteres se não enviar anexos)"
                className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-600 text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 resize-y"
              />
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-slate-600 text-slate-300 text-xs cursor-pointer hover:bg-slate-800">
                  <Paperclip size={14} />
                  Anexar foto/vídeo
                  <input type="file" accept={ACCEPT} multiple className="hidden" onChange={onPickReplyFiles} />
                </label>
                {replyFiles.length > 0 && (
                  <span className="text-[11px] text-slate-500">{replyFiles.length}/5 ficheiros</span>
                )}
              </div>
              {replyFiles.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {replyFiles.map((f, i) => (
                    <li
                      key={`${f.name}-${i}`}
                      className="flex items-center gap-1 text-[11px] bg-slate-800 rounded px-2 py-1 text-slate-300 max-w-full"
                    >
                      <span className="truncate">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => removeReplyFile(i)}
                        className="p-0.5 text-slate-500 hover:text-white shrink-0"
                        aria-label="Remover"
                      >
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                disabled={replying || !canSendReply}
                onClick={() => void sendReply(t.id)}
                className="px-3 py-2 rounded-lg bg-amber-600 text-white text-xs font-bold flex items-center gap-2 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {replying ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                Enviar resposta
              </button>
            </div>
          ) : (
            <p className="text-xs text-slate-500 italic">Ticket arquivado — apenas leitura. Reabra para responder.</p>
          )}

          <div className="flex gap-2">
            {t.status !== 'archived' ? (
              <button
                type="button"
                disabled={!!statusBusyId}
                onClick={() => void archive(t.id)}
                className="px-3 py-1.5 rounded-lg bg-slate-700 text-white text-xs font-bold flex items-center gap-1 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-wait"
              >
                {statusBusyId === t.id ? <Loader2 size={14} className="animate-spin shrink-0" /> : <Archive size={14} />}
                Arquivar
              </button>
            ) : (
              <button
                type="button"
                disabled={!!statusBusyId}
                onClick={() => void reopen(t.id)}
                className="px-3 py-1.5 rounded-lg bg-slate-700 text-white text-xs font-bold hover:bg-slate-600 disabled:opacity-50 disabled:cursor-wait inline-flex items-center gap-1"
              >
                {statusBusyId === t.id ? <Loader2 size={14} className="animate-spin shrink-0" /> : null}
                Reabrir
              </button>
            )}
          </div>
        </>
      ) : detailTab === 'activity' ? (
        <div className="space-y-3">
          <p className="text-[11px] text-slate-500">
            Eventos Mongo <span className="font-mono text-slate-400">game_activity_logs</span> +{' '}
            <span className="font-mono text-slate-400">action_logs</span> (login, signup, …) para{' '}
            <span className="font-mono text-slate-300">{t.email}</span>
            {ticketUserNumericId(t) > 0 ? (
              <span className="text-slate-500"> (user #{ticketUserNumericId(t)})</span>
            ) : null}
          </p>
          {formatAccountCreatedBrt(activityAccountCreatedAtMs) ? (
            <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 px-3 py-2 text-[11px] text-emerald-100/95">
              <span className="font-bold text-emerald-400/95">Conta criada (estimativa): </span>
              {formatAccountCreatedBrt(activityAccountCreatedAtMs)} (Brasília)
            </div>
          ) : (
            <div className="rounded-lg border border-slate-700/80 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-500">
              Sem data de criação no save para este utilizador.
            </div>
          )}
          <div className="flex flex-col gap-2 rounded-lg border border-slate-700/80 bg-slate-950/50 p-2 sm:flex-row sm:flex-wrap sm:items-end">
            <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-[14rem]">
              <label className="text-[9px] font-bold uppercase tracking-wider text-slate-500" htmlFor={`activity-filter-${t.id}`}>
                Tipo de evento
              </label>
              <select
                id={`activity-filter-${t.id}`}
                value={activityFilterId}
                onChange={(e) => setActivityFilterId(e.target.value)}
                className="rounded border border-slate-600 bg-slate-900 px-2 py-1.5 text-xs text-white focus:border-amber-500 focus:outline-none"
              >
                {ACTIVITY_LOG_FILTER_GROUPS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0 flex-1 flex-col gap-1 sm:min-w-[12rem] sm:flex-[2]">
              <label className="text-[9px] font-bold uppercase tracking-wider text-slate-500" htmlFor={`activity-search-${t.id}`}>
                Pesquisar no resumo legível…
              </label>
              <input
                id={`activity-search-${t.id}`}
                type="search"
                value={activitySearch}
                onChange={(e) => setActivitySearch(e.target.value)}
                placeholder="ex: compra, rig, item sumiu, checkout…"
                className="w-full rounded border border-slate-600 bg-slate-900 px-2 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
              />
            </div>
          </div>
          {activityLoading && (
            <div className="flex items-center justify-center gap-2 py-8 text-slate-400 text-sm">
              <Loader2 className="animate-spin" size={18} /> A carregar…
            </div>
          )}
          {!activityLoading && activityError && (
            <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">{activityError}</div>
          )}
          {!activityLoading && !activityError && (
            <AdminActivityLogTable
              rows={filteredActivityLogs}
              loading={activityLoading}
              emptyMessage={
                activityLogs.length > 0
                  ? 'Nenhum evento corresponde ao filtro.'
                  : 'Nenhum evento registado para esta conta.'
              }
              expandedTech={activityExpandedTech}
              setExpandedTech={setActivityExpandedTech}
            />
          )}
          {!activityLoading && !activityError && (
            <button
              type="button"
              onClick={() => void refreshTicketActivity(t)}
              className="text-xs font-bold text-amber-500 hover:text-amber-400 uppercase"
            >
              Atualizar lista
            </button>
          )}
        </div>
      ) : (
        <AdminUserAccountTracePanel userId={ticketUserNumericId(t) > 0 ? ticketUserNumericId(t) : null} />
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700 pb-3">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Inbox size={22} className="text-amber-500" />
            Pedidos de suporte
          </h2>
          <p className="text-xs text-slate-500 mt-1">Mensagens e anexos dos jogadores; pode responder por texto e anexar foto ou vídeo.</p>
        </div>
        <button
          type="button"
          onClick={() => load()}
          disabled={loading}
          className="px-3 py-2 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800 text-xs font-bold flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Atualizar
        </button>
      </div>
      <div className="inline-flex flex-wrap rounded-lg border border-slate-600 overflow-hidden text-[11px] font-bold">
        <button
          type="button"
          onClick={() => setListTab('open')}
          className={`px-3 py-2 inline-flex items-center gap-1.5 ${
            listTab === 'open'
              ? 'bg-amber-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200'
          }`}
        >
          <Inbox size={14} />
          Abertos ({openTicketCount})
        </button>
        <button
          type="button"
          onClick={() => setListTab('archived')}
          className={`px-3 py-2 inline-flex items-center gap-1.5 ${
            listTab === 'archived'
              ? 'bg-amber-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200'
          }`}
        >
          <Archive size={14} />
          Arquivados ({archivedTicketCount})
        </button>
        <button
          type="button"
          onClick={() => setListTab('userHistory')}
          className={`px-3 py-2 inline-flex items-center gap-1.5 ${
            listTab === 'userHistory'
              ? 'bg-amber-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200'
          }`}
        >
          <History size={14} />
          Histórico por usuário
        </button>
      </div>

      {listTab === 'userHistory' ? (
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-bold text-white">Histórico de tickets por usuário</h3>
            <p className="mt-1 text-xs text-slate-500">
              Busque pelo email para visualizar todos os tickets enviados por um operador.
            </p>
          </div>

          {(historyError || historyNotice) && (
            <div
              role="status"
              className={`rounded-lg border px-4 py-3 text-sm ${
                historyNotice
                  ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-200'
                  : historyEmptyUser
                    ? 'border-amber-800/60 bg-amber-950/30 text-amber-200'
                    : 'border-red-800/60 bg-red-950/40 text-red-200'
              }`}
            >
              {historyNotice || historyError}
            </div>
          )}

          <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1">
                <label className="text-[10px] font-bold uppercase text-slate-500" htmlFor="support-history-email">
                  Email do usuário
                </label>
                <input
                  id="support-history-email"
                  type="email"
                  value={historyEmail}
                  onChange={(e) => setHistoryEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void searchUserHistory();
                  }}
                  placeholder="Digite o email do usuário..."
                  className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
                />
              </div>
              <button
                type="button"
                disabled={historySearching}
                onClick={() => void searchUserHistory()}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-xs font-bold text-white hover:bg-amber-500 disabled:opacity-50"
              >
                {historySearching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                {historySearching ? 'Buscando...' : 'Buscar histórico'}
              </button>
            </div>
            {!historyData && !historySearching && !historyError && (
              <p className="text-xs text-slate-500">Digite o email e clique em buscar para ver o histórico completo.</p>
            )}
          </div>

          {historyData && (
            <>
              <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
                <div>
                  <div className="text-[10px] uppercase font-bold text-slate-500">Email</div>
                  <div className="font-mono text-white truncate" title={historyData.user.email}>
                    {historyData.user.email}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase font-bold text-slate-500">Usuário</div>
                  <div className="text-slate-200">{historyData.user.username || '—'}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase font-bold text-slate-500">Total / Abertos / Arquivados</div>
                  <div className="text-slate-200 font-mono">
                    {historyData.summary.total} · {historyData.summary.open} · {historyData.summary.archived}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase font-bold text-slate-500">Última interação</div>
                  <div className="text-slate-200 font-mono text-xs">
                    {historyData.summary.lastTicketAt ? fmt(historyData.summary.lastTicketAt) : '—'}
                  </div>
                </div>
              </div>

              {historyData.summary.total > 0 && (
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                  <div className="inline-flex rounded-lg border border-slate-600 overflow-hidden text-[10px] font-bold">
                    {(
                      [
                        ['all', 'Todos'],
                        ['open', 'Abertos'],
                        ['archived', 'Arquivados'],
                        ['closed', 'Fechados'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setHistoryFilter(id)}
                        className={`px-2.5 py-1.5 ${
                          historyFilter === id ? 'bg-amber-600 text-white' : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <input
                    type="search"
                    value={historySubjectSearch}
                    onChange={(e) => setHistorySubjectSearch(e.target.value)}
                    placeholder="Filtrar por assunto..."
                    className="rounded-lg border border-slate-600 bg-slate-950 px-3 py-1.5 text-xs text-white placeholder:text-slate-600 focus:border-amber-500 focus:outline-none sm:min-w-[14rem]"
                  />
                </div>
              )}

              {historyData.summary.total > 0 && filteredHistoryTickets.length === 0 ? (
                <div className="text-slate-500 text-sm py-8 text-center">Nenhum ticket corresponde ao filtro.</div>
              ) : null}

              {filteredHistoryTickets.length > 0 ? (
                <div className="space-y-2">
                  {filteredHistoryTickets.map((ht) => (
                    <div
                      key={ht.id}
                      className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-3 flex flex-wrap items-center justify-between gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-white truncate">{ht.subject}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                          <span
                            className={`uppercase font-bold px-1.5 py-0.5 rounded ${
                              ht.status === 'archived' ? 'bg-slate-700 text-slate-400' : 'bg-amber-900/50 text-amber-300'
                            }`}
                          >
                            {ht.status === 'archived' ? 'Arquivado' : 'Aberto'}
                          </span>
                          <span className="font-mono">{fmt(ht.createdAt)}</span>
                          <span>· última: {fmt(ht.lastMessageAt)}</span>
                          <span>· {ht.messageCount} msg</span>
                          {ht.hasAttachments ? (
                            <span className="inline-flex items-center gap-0.5 text-sky-400">
                              <Paperclip size={11} /> anexos
                            </span>
                          ) : null}
                          {ht.assignedTo ? <span>· {ht.assignedTo}</span> : null}
                        </div>
                        {ht.preview ? (
                          <p className="mt-1 text-xs text-slate-400 line-clamp-2">{ht.preview}</p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => void copyPlayerEmail(historyData.user.email, ht.id)}
                          className="inline-flex items-center gap-1 rounded border border-slate-600 px-2 py-1 text-[10px] font-bold uppercase text-amber-500 hover:bg-slate-800"
                        >
                          <Copy size={11} />
                          {copiedTicketId === ht.id ? 'Copiado' : 'Copiar email'}
                        </button>
                        {onOpenPlayerProfile && (
                          <button
                            type="button"
                            disabled={!canOpenPlayerProfile}
                            onClick={() => {
                              if (!canOpenPlayerProfile) return;
                              onOpenPlayerProfile({
                                userId: historyData.user.id,
                                email: historyData.user.email,
                                username: historyData.user.username,
                              });
                            }}
                            className="inline-flex items-center gap-1 rounded border border-amber-600/70 px-2 py-1 text-[10px] font-bold uppercase text-amber-500 hover:bg-amber-950/30 disabled:opacity-40"
                          >
                            <UserCog size={11} /> Gerir perfil
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={historyDetailLoading}
                          onClick={() => void openHistoryTicket(ht.id)}
                          className="inline-flex items-center gap-1 rounded-lg bg-amber-600 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-amber-500 disabled:opacity-50"
                        >
                          {historyDetailLoading && openId === ht.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <MessageSquare size={12} />
                          )}
                          Abrir conversa
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              {openTicket && listTab === 'userHistory' && (
                <div className="rounded-xl border border-amber-900/40 bg-slate-900/80 overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-2">
                    <div className="font-bold text-white truncate">{openTicket.subject}</div>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenId(null);
                        setHistoryOpenTicket(null);
                      }}
                      className="text-slate-500 hover:text-white p-1"
                      aria-label="Fechar conversa"
                    >
                      <X size={16} />
                    </button>
                  </div>
                  {openTicket && renderTicketDetailPanel(openTicket)}
                </div>
              )}
            </>
          )}
        </div>
      ) : null}

      {listTab !== 'userHistory' && err && <div className="text-red-400 text-sm">{err}</div>}
      {listTab !== 'userHistory' &&
        (loading && tickets.length === 0 ? (
        <div className="text-slate-500 text-sm py-12 text-center">A carregar…</div>
      ) : tickets.length === 0 ? (
        <div className="text-slate-500 text-sm py-12 text-center">Nenhum pedido ainda.</div>
      ) : filteredTickets.length === 0 ? (
        <div className="text-slate-500 text-sm py-12 text-center">
          {listTab === 'archived' ? 'Nenhum ticket arquivado.' : 'Nenhum ticket aberto.'}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredTickets.map((t) => (
            <div key={t.id} className="rounded-xl border border-slate-700 bg-slate-900/60 overflow-hidden">
              {/* Não usar <button> aqui: filhos com botões (copiar / perfil) são HTML inválido e partem cliques. */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => setOpenId((v) => (v === t.id ? null : t.id))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpenId((v) => (v === t.id ? null : t.id));
                  }
                }}
                className="w-full text-left px-4 py-3 flex flex-wrap items-center justify-between gap-2 hover:bg-slate-800/50 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 rounded-t-xl"
              >
                <div className="min-w-0">
                  <div className="font-bold text-white truncate">{t.subject}</div>
                  <div className="text-[11px] text-slate-500 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
                    <span className="font-mono truncate max-w-[min(100%,14rem)]" title={t.email}>
                      {t.email}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyPlayerEmail(t.email, t.id);
                      }}
                      className="shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-bold uppercase text-amber-500/95 hover:bg-amber-950/40 hover:text-amber-400"
                      title="Copiar email do jogador"
                    >
                      <Copy size={11} />
                      {copiedTicketId === t.id ? 'Copiado' : 'Copiar email'}
                    </button>
                    {onOpenPlayerProfile && ticketUserNumericId(t) > 0 && (
                      <button
                        type="button"
                        disabled={!canOpenPlayerProfile}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!canOpenPlayerProfile) return;
                          onOpenPlayerProfile({
                            userId: ticketUserNumericId(t),
                            email: t.email,
                            username: t.username,
                          });
                        }}
                        className="shrink-0 inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase border-amber-600/70 text-amber-500 hover:bg-amber-950/35 hover:text-amber-400 disabled:pointer-events-none disabled:opacity-40 disabled:cursor-not-allowed"
                        title={
                          canOpenPlayerProfile
                            ? 'Abrir editor de perfil, estoque e dados do jogador (separador Utilizadores)'
                            : 'Precisa da permissão Utilizadores para abrir o editor de perfil'
                        }
                      >
                        <UserCog size={11} />
                        Gerir perfil
                      </button>
                    )}
                    <span className="text-slate-600">·</span>
                    <span className="truncate">{t.username}</span>
                    {ticketUserNumericId(t) <= 0 ? (
                      <span className="shrink-0 rounded bg-sky-950/60 px-1.5 py-0.5 text-[10px] font-bold uppercase text-sky-300">
                        Guest
                      </span>
                    ) : null}
                    <span className="text-slate-600">·</span>
                    <span className="font-mono shrink-0">{fmt(t.createdAt)}</span>
                    {Array.isArray(t.replies) && t.replies.length > 0 && (
                      <span className="text-amber-600/90">· {t.replies.length} resposta(s)</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${
                      t.status === 'archived' ? 'bg-slate-700 text-slate-400' : 'bg-amber-900/50 text-amber-300'
                    }`}
                  >
                    {t.status === 'archived' ? 'Arquivado' : 'Aberto'}
                  </span>
                </div>
              </div>
              {openId === t.id && (
                <div className="px-4 pb-4 pt-2 border-t border-slate-800 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="inline-flex rounded-lg border border-slate-600 overflow-hidden text-[11px] font-bold">
                        <button
                          type="button"
                          onClick={() => setDetailTab('thread')}
                          className={`px-3 py-1.5 inline-flex items-center gap-1 ${
                            detailTab === 'thread'
                              ? 'bg-amber-600 text-white'
                              : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          Conversa
                        </button>
                        <button
                          type="button"
                          onClick={() => setDetailTab('activity')}
                          className={`px-3 py-1.5 inline-flex items-center gap-1 ${
                            detailTab === 'activity'
                              ? 'bg-amber-600 text-white'
                              : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <History size={12} /> Atividade
                        </button>
                        <button
                          type="button"
                          onClick={() => setDetailTab('trace')}
                          className={`px-3 py-1.5 inline-flex items-center gap-1 ${
                            detailTab === 'trace'
                              ? 'bg-amber-600 text-white'
                              : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <Search size={12} /> Rastreio
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => void copyPlayerEmail(t.email, t.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-600 px-2 py-1 text-[10px] font-bold uppercase text-amber-500/95 hover:bg-slate-800"
                        title="Copiar email do jogador"
                      >
                        <Copy size={12} />
                        {copiedTicketId === t.id ? 'Copiado' : 'Copiar email'}
                      </button>
                      {onOpenPlayerProfile && (
                        <button
                          type="button"
                          disabled={!canOpenPlayerProfile}
                          onClick={() => {
                            if (!canOpenPlayerProfile) return;
                            onOpenPlayerProfile({
                              userId: ticketUserNumericId(t),
                              email: t.email,
                              username: t.username,
                            });
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-amber-600/70 px-2 py-1 text-[10px] font-bold uppercase text-amber-500 hover:bg-amber-950/30 hover:bg-slate-800/80 disabled:pointer-events-none disabled:opacity-40 disabled:cursor-not-allowed"
                          title={
                            canOpenPlayerProfile
                              ? 'Abrir editor de perfil, estoque e dados do jogador'
                              : 'Precisa da permissão Utilizadores'
                          }
                        >
                          <UserCog size={12} />
                          Gerir perfil
                        </button>
                      )}
                    </div>
                  </div>

                  {detailTab === 'thread' ? (
                    <>
                      <div className="text-[10px] font-bold text-slate-500 uppercase">Conversa (ordem cronológica)</div>
                      <ul className="space-y-3">
                        {buildAdminTimeline(t).map((e, idx) => (
                          <li
                            key={`${e.k}-${idx}-${e.at}`}
                            className={`text-sm rounded-lg p-3 border ${
                              e.k === 'admin'
                                ? 'border-emerald-900/50 bg-emerald-950/15'
                                : e.k === 'player'
                                  ? 'border-slate-600 bg-slate-950/60'
                                  : 'border-amber-900/30 bg-amber-950/10'
                            }`}
                          >
                            <div className="text-[10px] text-slate-500 mb-1">
                              {e.k === 'open' && <span className="text-amber-200/90 font-semibold">Pedido inicial</span>}
                              {e.k === 'player' && <span className="text-slate-300 font-semibold">Jogador (seguimento)</span>}
                              {e.k === 'admin' && (
                                <span className="text-emerald-400 font-semibold">
                                  Equipe - {e.adminUsername || 'admin'}
                                </span>
                              )}
                              {' · '}
                              {fmt(e.at)}
                            </div>
                            {e.message ? (
                              <pre className="whitespace-pre-wrap text-slate-300 font-sans text-[13px]">{e.message}</pre>
                            ) : null}
                            <ReplyAttachments items={e.attachments} />
                          </li>
                        ))}
                      </ul>

                      <div className="rounded-lg border border-amber-900/30 bg-slate-950/50 p-3 space-y-2">
                        <div className="text-xs font-bold text-amber-500/90 uppercase">Responder ao jogador</div>
                        {replyErr && <div className="text-xs text-red-400">{replyErr}</div>}
                        <textarea
                          value={replyMessage}
                          onChange={(e) => setReplyMessage(e.target.value)}
                          rows={4}
                          maxLength={SUPPORT_TICKET_MESSAGE_MAX}
                          placeholder="Texto da resposta (mín. 3 caracteres se não enviar anexos)"
                          className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-600 text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 resize-y"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-slate-600 text-slate-300 text-xs cursor-pointer hover:bg-slate-800">
                            <Paperclip size={14} />
                            Anexar foto/vídeo
                            <input type="file" accept={ACCEPT} multiple className="hidden" onChange={onPickReplyFiles} />
                          </label>
                          {replyFiles.length > 0 && (
                            <span className="text-[11px] text-slate-500">{replyFiles.length}/5 ficheiros</span>
                          )}
                        </div>
                        {replyFiles.length > 0 && (
                          <ul className="flex flex-wrap gap-2">
                            {replyFiles.map((f, i) => (
                              <li
                                key={`${f.name}-${i}`}
                                className="flex items-center gap-1 text-[11px] bg-slate-800 rounded px-2 py-1 text-slate-300 max-w-full"
                              >
                                <span className="truncate">{f.name}</span>
                                <button
                                  type="button"
                                  onClick={() => removeReplyFile(i)}
                                  className="p-0.5 text-slate-500 hover:text-white shrink-0"
                                  aria-label="Remover"
                                >
                                  <X size={12} />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        <button
                          type="button"
                          disabled={replying || !canSendReply}
                          onClick={() => void sendReply(t.id)}
                          className="px-3 py-2 rounded-lg bg-amber-600 text-white text-xs font-bold flex items-center gap-2 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {replying ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                          Enviar resposta
                        </button>
                      </div>

                      <div className="flex gap-2">
                        {t.status !== 'archived' ? (
                          <button
                            type="button"
                            disabled={!!statusBusyId}
                            onClick={() => void archive(t.id)}
                            className="px-3 py-1.5 rounded-lg bg-slate-700 text-white text-xs font-bold flex items-center gap-1 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-wait"
                          >
                            {statusBusyId === t.id ? (
                              <Loader2 size={14} className="animate-spin shrink-0" />
                            ) : (
                              <Archive size={14} />
                            )}
                            Arquivar
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={!!statusBusyId}
                            onClick={() => void reopen(t.id)}
                            className="px-3 py-1.5 rounded-lg bg-slate-700 text-white text-xs font-bold hover:bg-slate-600 disabled:opacity-50 disabled:cursor-wait inline-flex items-center gap-1"
                          >
                            {statusBusyId === t.id ? <Loader2 size={14} className="animate-spin shrink-0" /> : null}
                            Reabrir
                          </button>
                        )}
                      </div>
                    </>
                  ) : detailTab === 'activity' ? (
                    <div className="space-y-3">
                      <p className="text-[11px] text-slate-500">
                        Eventos Mongo <span className="font-mono text-slate-400">game_activity_logs</span> +{' '}
                        <span className="font-mono text-slate-400">action_logs</span> (login, signup, …) para{' '}
                        <span className="font-mono text-slate-300">{t.email}</span>
                        {ticketUserNumericId(t) > 0 ? (
                          <span className="text-slate-500"> (user #{ticketUserNumericId(t)})</span>
                        ) : null}
                        : caixas, roleta, resgate de códigos, depósitos quando o servidor regista o evento.
                      </p>
                      {formatAccountCreatedBrt(activityAccountCreatedAtMs) ? (
                        <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 px-3 py-2 text-[11px] text-emerald-100/95">
                          <span className="font-bold text-emerald-400/95">Conta criada (estimativa): </span>
                          {formatAccountCreatedBrt(activityAccountCreatedAtMs)} (Brasília), a partir de{' '}
                          <span className="font-mono text-slate-300">game_states.start_time</span> no PostgreSQL — coincide com o
                          instante em que o save do jogador foi criado no registo.
                        </div>
                      ) : (
                        <div className="rounded-lg border border-slate-700/80 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-500">
                          Sem data de criação no save (sem linha em <span className="font-mono">game_states</span> para este utilizador).
                        </div>
                      )}
                      <div className="flex flex-col gap-2 rounded-lg border border-slate-700/80 bg-slate-950/50 p-2 sm:flex-row sm:flex-wrap sm:items-end">
                        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-[14rem]">
                          <label className="text-[9px] font-bold uppercase tracking-wider text-slate-500" htmlFor={`activity-filter-${t.id}`}>
                            Tipo de evento
                          </label>
                          <select
                            id={`activity-filter-${t.id}`}
                            value={activityFilterId}
                            onChange={(e) => setActivityFilterId(e.target.value)}
                            className="rounded border border-slate-600 bg-slate-900 px-2 py-1.5 text-xs text-white focus:border-amber-500 focus:outline-none"
                          >
                            {ACTIVITY_LOG_FILTER_GROUPS.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="min-w-0 flex-1 flex-col gap-1 sm:min-w-[12rem] sm:flex-[2]">
                          <label className="text-[9px] font-bold uppercase tracking-wider text-slate-500" htmlFor={`activity-search-${t.id}`}>
                            Pesquisar no resumo legível…
                          </label>
                          <input
                            id={`activity-search-${t.id}`}
                            type="search"
                            value={activitySearch}
                            onChange={(e) => setActivitySearch(e.target.value)}
                            placeholder="ex: deposit, rackId, mining_rack…"
                            className="w-full rounded border border-slate-600 bg-slate-900 px-2 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-amber-500 focus:outline-none"
                          />
                        </div>
                        <p className="w-full text-[10px] text-slate-600 sm:order-last">
                          {activityLogs.length > 0
                            ? `A mostrar ${filteredActivityLogs.length} de ${activityLogs.length} evento(s) carregados.`
                            : null}
                        </p>
                      </div>
                      {activityLoading && (
                        <div className="flex items-center justify-center gap-2 py-8 text-slate-400 text-sm">
                          <Loader2 className="animate-spin" size={18} /> A carregar…
                        </div>
                      )}
                      {!activityLoading && activityError && (
                        <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">{activityError}</div>
                      )}
                      {!activityLoading && !activityError && (
                        <AdminActivityLogTable
                          rows={filteredActivityLogs}
                          loading={activityLoading}
                          emptyMessage={
                            activityLogs.length > 0
                              ? 'Nenhum evento corresponde ao filtro ou à pesquisa. Ajuste o tipo ou limpe a pesquisa.'
                              : 'Nenhum evento registado para esta conta (ou a tabela de logs ainda não recebeu dados).'
                          }
                          expandedTech={activityExpandedTech}
                          setExpandedTech={setActivityExpandedTech}
                        />
                      )}
                      {!activityLoading && !activityError && (
                        <button
                          type="button"
                          onClick={() => void refreshTicketActivity(t)}
                          className="text-xs font-bold text-amber-500 hover:text-amber-400 uppercase"
                        >
                          Atualizar lista
                        </button>
                      )}
                    </div>
                  ) : (
                    <AdminUserAccountTracePanel userId={ticketUserNumericId(t) > 0 ? ticketUserNumericId(t) : null} />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};
