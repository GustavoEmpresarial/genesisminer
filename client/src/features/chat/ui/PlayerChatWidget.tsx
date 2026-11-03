import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Briefcase,
  Check,
  Globe2,
  MessageCircle,
  Minus,
  Pencil,
  Send,
  Trash2,
  Users,
  X
} from 'lucide-react';
import {
  getChatHistory,
  getChatPeers,
  searchChatMentions,
  sendChatMessage,
  editChatMessage,
  deleteChatMessage,
  type ChatAmPeerDto,
  type ChatMentionDto,
  type ChatMessageDto
} from '../../../shared/api/admin-legacy';
import {
  amPeerPickerHeading,
  amPeerThreadLabel,
  CHAT_CHANNEL_GLOBAL,
  CHAT_MESSAGE_TTL_MS,
  chatChannelUsesMessageTtl,
  pickInitialAmPeerChannel
} from '../lib/chatPlacement';

type Props = {
  /** user.id da sessão (dono quando em modo gerência). */
  currentUserId: number;
  currentUsername?: string | null;
  /** Humano real (gerente se estiver a gerir). */
  realUserId?: number | null;
  isManagingAccount?: boolean;
  /** `panel` = embutido na página Gestão (sempre aberto, tab gerência). */
  variant?: 'floating' | 'panel';
  initialTab?: TabId;
  startOpen?: boolean;
};

type TabId = 'global' | 'am';

function formatChatTime(ms: number): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** Defesa XSS no cliente (React já escapa texto; isto remove vectores residuais). */
function sanitizeClientChatText(raw: unknown, maxLen = 280): string {
  if (raw == null || typeof raw === 'object') return '';
  let s = String(raw)
    // C0/DEL + bidi overrides — iguais ao sanitize do servidor; \u0000-\u001F dispara no-control-regex.
    // eslint-disable-next-line no-control-regex -- strip NUL
    .replace(/\u0000/g, '')
    // eslint-disable-next-line no-control-regex -- strip C0, DEL, bidi
    .replace(/[\u0001-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>`]/g, '')
    .replace(/(?:javascript|vbscript|data)\s*:/gi, '')
    .replace(/\bon[a-z]+\s*=/gi, '')
    .replace(/&(?:#x?0*3[ceCE]|lt|gt|quot|apos);/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function normalizeMentionKey(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s_]+/g, '');
}

function mentionInsertToken(username: string): string {
  const s = String(username || '').trim();
  if (/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,49}$/.test(s)) return s;
  return s.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
}

/** Contexto activo de @menção sob o cursor. */
function getMentionContext(text: string, caret: number): { start: number; query: string } | null {
  const before = String(text || '').slice(0, Math.max(0, caret));
  const m = /(^|[\s([{])@([a-zA-Z0-9_][a-zA-Z0-9_-]{0,49})$/.exec(before);
  if (!m) return null;
  return { start: before.length - String(m[2]).length - 1, query: String(m[2] || '') };
}

function renderChatBody(
  body: string,
  opts?: { myUsername?: string | null; mineBubble?: boolean }
): React.ReactNode {
  const myKey = normalizeMentionKey(opts?.myUsername || '');
  const safe = sanitizeClientChatText(body);
  const parts = safe.split(/(@[a-zA-Z0-9_][a-zA-Z0-9_-]{0,49})/g);
  return parts.map((part, i) => {
    if (/^@[a-zA-Z0-9_][a-zA-Z0-9_-]{0,49}$/.test(part)) {
      const isMe = !!myKey && normalizeMentionKey(part.slice(1)) === myKey;
      return (
        <span
          key={`m-${i}`}
          className={
            isMe
              ? opts?.mineBubble
                ? 'font-bold text-yellow-100 underline decoration-yellow-200/80'
                : 'rounded bg-amber-400/25 px-0.5 font-bold text-amber-300'
              : opts?.mineBubble
                ? 'font-semibold text-sky-100'
                : 'font-semibold text-sky-300'
          }
        >
          {part}
        </span>
      );
    }
    return <React.Fragment key={`t-${i}`}>{part}</React.Fragment>;
  });
}

function normalizeIncomingChatMessage(raw: ChatMessageDto | null | undefined): ChatMessageDto | null {
  if (!raw?.id) return null;
  const id = String(raw.id);
  if (!/^\d+$/.test(id)) return null;
  const kind = String(raw.kind || '').toLowerCase() === 'audio' ? 'audio' : 'text';
  const body = sanitizeClientChatText(raw.body);
  const deletedAt = raw.deletedAt != null ? Number(raw.deletedAt) || null : null;
  if (!body && kind !== 'audio' && !deletedAt) return null;
  return {
    ...raw,
    id,
    kind,
    audioUrl: null,
    durationMs: null,
    body,
    username: sanitizeClientChatText(raw.username, 64) || 'Jogador',
    channel: String(raw.channel || 'global').slice(0, 64),
    mentions: Array.isArray(raw.mentions)
      ? raw.mentions
          .map((x) => ({
            userId: Number(x?.userId) || 0,
            username: sanitizeClientChatText(x?.username, 64)
          }))
          .filter((x) => x.userId > 0 && x.username)
      : undefined
  };
}

function upsertMessage(prev: ChatMessageDto[], msg: ChatMessageDto): ChatMessageDto[] {
  const idx = prev.findIndex((m) => m.id === msg.id);
  if (idx < 0) {
    const next = [...prev, msg];
    return next.length > 200 ? next.slice(-200) : next;
  }
  const next = [...prev];
  next[idx] = msg;
  return next;
}

function removeMessage(prev: ChatMessageDto[], id: string): ChatMessageDto[] {
  return prev.filter((m) => m.id !== id);
}

function pruneExpiredMessages(
  prev: ChatMessageDto[],
  channel: string | null | undefined,
  nowMs = Date.now()
): ChatMessageDto[] {
  if (!chatChannelUsesMessageTtl(channel)) return prev;
  const cutoff = nowMs - CHAT_MESSAGE_TTL_MS;
  const next = prev.filter((m) => (Number(m.createdAt) || 0) >= cutoff);
  return next.length === prev.length ? prev : next;
}

export const PlayerChatWidget: React.FC<Props> = ({
  currentUserId,
  currentUsername,
  realUserId: realUserIdProp,
  isManagingAccount,
  variant = 'floating',
  initialTab,
  startOpen = false
}) => {
  const connected = true;
  const isPanel = variant === 'panel';
  const realUserId = Number(realUserIdProp) > 0 ? Number(realUserIdProp) : currentUserId;

  const [open, setOpen] = useState(() => isPanel || startOpen);
  const [tab, setTab] = useState<TabId>(() => initialTab ?? (isPanel ? 'am' : 'global'));
  const [peers, setPeers] = useState<ChatAmPeerDto[]>([]);
  const [activePeerChannel, setActivePeerChannel] = useState<string | null>(null);
  const [globalMessages, setGlobalMessages] = useState<ChatMessageDto[]>([]);
  const [amMessages, setAmMessages] = useState<ChatMessageDto[]>([]);
  const [draft, setDraft] = useState('');
  const [online] = useState(0);
  const [unreadGlobal, setUnreadGlobal] = useState(0);
  const [unreadAm, setUnreadAm] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [mentionUsers, setMentionUsers] = useState<ChatMentionDto[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionForEdit, setMentionForEdit] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const draftInputRef = useRef<HTMLInputElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const mentionTimerRef = useRef<number | null>(null);
  const openRef = useRef(open);
  const tabRef = useRef(tab);
  const peerRef = useRef(activePeerChannel);
  openRef.current = open;
  tabRef.current = tab;
  peerRef.current = activePeerChannel;

  const activeChannel = tab === 'global' ? CHAT_CHANNEL_GLOBAL : activePeerChannel;
  const messages = tab === 'global' ? globalMessages : amMessages;
  const unreadTotal = unreadGlobal + unreadAm;

  const activePeer = useMemo(
    () => peers.find((p) => p.channel === activePeerChannel) || null,
    [peers, activePeerChannel]
  );

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const refreshPeers = useCallback(async () => {
    const res = await getChatPeers();
    if (!res.ok || !res.peers) return;
    const nextPeers = res.peers;
    setPeers(nextPeers);
    setActivePeerChannel((prev) => {
      if (prev && nextPeers.some((p) => p.channel === prev)) return prev;
      return pickInitialAmPeerChannel(nextPeers, currentUserId);
    });
  }, [currentUserId]);

  useEffect(() => {
    void refreshPeers();
  }, [refreshPeers, realUserId, isManagingAccount]);

  useEffect(() => {
    if (isPanel) return;
    if (startOpen) setOpen(true);
  }, [isPanel, startOpen]);

  useEffect(() => {
    if (isPanel) return;
    if (initialTab) setTab(initialTab);
  }, [isPanel, initialTab]);

  useEffect(() => {
    if (!open || !activeChannel) return;
    if (tab === 'global') setUnreadGlobal(0);
    else setUnreadAm(0);

    let cancelled = false;
    setLoadingHistory(true);
    void getChatHistory(60, activeChannel).then((res) => {
      if (cancelled) return;
      setLoadingHistory(false);
      if (!res.ok || !res.messages) return;
      const setter = tab === 'global' ? setGlobalMessages : setAmMessages;
      setter(pruneExpiredMessages(res.messages!, activeChannel));
    });
    return () => {
      cancelled = true;
    };
  }, [open, activeChannel, tab]);

  useEffect(() => {
    if (open) scrollToBottom();
  }, [messages, open, scrollToBottom]);

  /**
   * Fallback de polling: o envio usa REST (POST /chat/messages) e o backend
   * não emite o evento de socket correspondente (emit_chat_message_to_channel
   * fica sem chamadas), então sem isto o painel aberto nunca recebe mensagens
   * novas de outra pessoa — só via fecha/reabre. Só substitui o estado quando
   * o conteúdo realmente muda, para não interromper edição/scroll.
   */
  useEffect(() => {
    if (!open || !activeChannel) return;
    const setter = tab === 'global' ? setGlobalMessages : setAmMessages;
    let cancelled = false;
    const poll = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void getChatHistory(60, activeChannel).then((res) => {
        if (cancelled || !res.ok || !res.messages) return;
        const next = pruneExpiredMessages(res.messages, activeChannel);
        setter((prev) => {
          const same =
            prev.length === next.length &&
            prev.every((m, i) => {
              const n = next[i];
              return (
                !!n &&
                m.id === n.id &&
                m.body === n.body &&
                m.editedAt === n.editedAt &&
                m.deletedAt === n.deletedAt
              );
            });
          return same ? prev : next;
        });
      });
    };
    const id = window.setInterval(poll, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, activeChannel, tab]);

  /** Limpeza local a cada minuto (mesmo sem evento do servidor). */
  useEffect(() => {
    const tick = () => {
      setGlobalMessages((prev) => pruneExpiredMessages(prev, CHAT_CHANNEL_GLOBAL));
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const closeMentions = useCallback(() => {
    setMentionOpen(false);
    setMentionUsers([]);
    setMentionIndex(0);
  }, []);

  const refreshMentionSuggestions = useCallback(
    (text: string, caret: number, forEdit: boolean) => {
      const ctx = getMentionContext(text, caret);
      if (!ctx) {
        closeMentions();
        return;
      }
      setMentionForEdit(forEdit);
      if (mentionTimerRef.current != null) window.clearTimeout(mentionTimerRef.current);
      mentionTimerRef.current = window.setTimeout(() => {
        void (async () => {
          const local: ChatMentionDto[] = [];
          if (activePeer?.peerUsername) {
            const key = normalizeMentionKey(ctx.query);
            if (!key || normalizeMentionKey(activePeer.peerUsername).startsWith(key)) {
              local.push({ userId: activePeer.peerUserId, username: activePeer.peerUsername });
            }
          }
          const remote =
            ctx.query.length >= 1
              ? ((await searchChatMentions(ctx.query)).users ?? [])
              : [];
          const merged: ChatMentionDto[] = [];
          const seen = new Set<number>();
          for (const u of [...local, ...remote]) {
            if (seen.has(u.userId)) continue;
            if (u.userId === realUserId || u.userId === currentUserId) continue;
            seen.add(u.userId);
            merged.push(u);
            if (merged.length >= 8) break;
          }
          setMentionUsers(merged);
          setMentionIndex(0);
          setMentionOpen(merged.length > 0);
        })();
      }, 180);
    },
    [activePeer, closeMentions, currentUserId, realUserId]
  );

  const applyMention = useCallback(
    (user: ChatMentionDto) => {
      const token = mentionInsertToken(user.username);
      if (!token) return;
      const forEdit = mentionForEdit && !!editingId;
      const input = forEdit ? editInputRef.current : draftInputRef.current;
      const text = forEdit ? editDraft : draft;
      const caret = input?.selectionStart ?? text.length;
      const ctx = getMentionContext(text, caret);
      if (!ctx) {
        closeMentions();
        return;
      }
      const insert = `@${token} `;
      const next = `${text.slice(0, ctx.start)}${insert}${text.slice(caret)}`.slice(0, 280);
      if (forEdit) setEditDraft(next);
      else setDraft(next);
      closeMentions();
      window.requestAnimationFrame(() => {
        const el = forEdit ? editInputRef.current : draftInputRef.current;
        if (!el) return;
        const pos = Math.min(280, ctx.start + insert.length);
        el.focus();
        try {
          el.setSelectionRange(pos, pos);
        } catch {
          /* ignore */
        }
      });
    },
    [closeMentions, draft, editDraft, editingId, mentionForEdit]
  );

  useEffect(() => {
    return () => {
      if (mentionTimerRef.current != null) window.clearTimeout(mentionTimerRef.current);
    };
  }, []);

  const canSend = useMemo(() => {
    return (
      connected &&
      !!activeChannel &&
      sanitizeClientChatText(draft).length > 0 &&
      !sending &&
      !editingId
    );
  }, [connected, activeChannel, draft, sending, editingId]);

  const send = () => {
    const body = sanitizeClientChatText(draft);
    if (!body || sending || !activeChannel) return;
    if (tab === 'am' && !activePeerChannel) {
      setError('Sem gerente/dono activo para conversar.');
      return;
    }
    setSending(true);
    setError(null);
    closeMentions();
    void sendChatMessage(body, activeChannel).then((res) => {
      setSending(false);
      if (!res.ok) {
        setError(res.error || 'Falha ao enviar.');
        return;
      }
      setDraft('');
      if (res.message) {
        const msg = normalizeIncomingChatMessage(res.message);
        if (msg) {
          const ch = String(msg.channel || 'global');
          if (ch === 'global') setGlobalMessages((prev) => upsertMessage(prev, msg));
          else if (peerRef.current === ch) setAmMessages((prev) => upsertMessage(prev, msg));
        }
      }
    });
  };

  const startEdit = (m: ChatMessageDto) => {
    if (m.kind === 'audio') return;
    setEditingId(m.id);
    setEditDraft(m.body);
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft('');
  };

  const saveEdit = () => {
    if (!editingId) return;
    const body = sanitizeClientChatText(editDraft);
    if (!body) {
      setError('Mensagem vazia.');
      return;
    }
    setError(null);
    closeMentions();
    void editChatMessage(editingId, body).then((res) => {
      if (!res.ok) {
        setError(res.error || 'Falha ao editar.');
        return;
      }
      if (res.message) {
        const msg = normalizeIncomingChatMessage(res.message);
        if (msg) {
          const ch = String(msg.channel || 'global');
          if (ch === 'global') setGlobalMessages((prev) => upsertMessage(prev, msg));
          else setAmMessages((prev) => upsertMessage(prev, msg));
        }
      }
      setEditingId(null);
      setEditDraft('');
    });
  };

  const deleteMsg = (id: string) => {
    if (!window.confirm('Apagar esta mensagem?')) return;
    setError(null);
    if (editingId === id) cancelEdit();
    void deleteChatMessage(id).then((res) => {
      if (!res.ok) {
        setError(res.error || 'Falha ao apagar.');
        return;
      }
      setGlobalMessages((prev) => removeMessage(prev, id));
      setAmMessages((prev) => removeMessage(prev, id));
    });
  };

  const hasAmTab = peers.length > 0;
  const composerDisabled = (tab === 'am' && !activePeerChannel) || !!editingId;
  const showPanel = isPanel || open;
  const shellClass = isPanel
    ? 'flex h-[min(460px,72vh)] w-full flex-col overflow-hidden rounded-2xl border border-amber-500/40 bg-slate-900 dark:bg-slate-950'
    : 'pointer-events-auto flex h-[min(460px,72vh)] w-[min(380px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-slate-600/80 bg-slate-900 shadow-2xl dark:bg-slate-950';

  const dialog = showPanel ? (
        <div
          className={shellClass}
          role="dialog"
          aria-label="Mini-chat da gerência"
        >
          <div className="flex items-center gap-2 border-b border-slate-700/80 bg-slate-950/80 px-3 py-2.5">
            <MessageCircle size={16} className="shrink-0 text-amber-400" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-black uppercase tracking-widest text-white">
                Mini-chat da gerência
              </div>
              <div className="flex items-center gap-1 text-[10px] text-slate-400">
                {tab === 'global' ? (
                  <>
                    <Users size={11} aria-hidden />
                    <span>{online > 0 ? `${online} no chat` : connected ? 'ligado' : 'a ligar…'}</span>
                  </>
                ) : (
                  <>
                    <Briefcase size={11} aria-hidden />
                    <span>
                      {activePeer ? amPeerThreadLabel(activePeer) : 'Precisas de gerente activo'}
                    </span>
                  </>
                )}
              </div>
            </div>
            {isPanel ? null : (
              <>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
              aria-label="Minimizar chat"
            >
              <Minus size={16} />
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
              aria-label="Fechar chat"
            >
              <X size={16} />
            </button>
              </>
            )}
          </div>

          <div className="flex gap-1 border-b border-amber-500/25 bg-slate-950 p-1.5">
            <button
              type="button"
              onClick={() => {
                setTab('global');
                cancelEdit();
              }}
              className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-2 text-[11px] font-black uppercase tracking-wide transition ${
                tab === 'global'
                  ? 'bg-orange-600 text-white shadow-md shadow-orange-900/40'
                  : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
            >
              <Globe2 size={13} />
              Global
              {unreadGlobal > 0 && tab !== 'global' && (
                <span className="rounded-full bg-amber-500 px-1.5 text-[9px] text-slate-950">{unreadGlobal}</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('am');
                cancelEdit();
                if (!peers.length) void refreshPeers();
              }}
              className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-2 text-[11px] font-black uppercase tracking-wide transition ${
                tab === 'am'
                  ? 'bg-orange-600 text-white shadow-md shadow-orange-900/40'
                  : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
              title={hasAmTab ? 'Conversa privada com gerente/dono' : 'Contrato de gerência activo necessário'}
            >
              <Briefcase size={13} />
              Gerente
              {unreadAm > 0 && tab !== 'am' && (
                <span className="rounded-full bg-amber-500 px-1.5 text-[9px] text-slate-950">{unreadAm}</span>
              )}
            </button>
          </div>

          {tab === 'am' && peers.length > 0 ? (
            <div className="border-b border-slate-800 px-2 py-1.5">
              <div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-slate-500">
                {amPeerPickerHeading(peers)}
              </div>
              <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
                {peers.map((p) => {
                  const selected = p.channel === activePeerChannel;
                  return (
                    <button
                      key={p.channel}
                      type="button"
                      onClick={() => {
                        if (p.channel === activePeerChannel) return;
                        setActivePeerChannel(p.channel);
                        setAmMessages([]);
                        cancelEdit();
                      }}
                      aria-pressed={selected}
                      className={`w-full truncate rounded-lg border px-2 py-1.5 text-left text-[11px] font-semibold transition ${
                        selected
                          ? 'border-amber-500/60 bg-amber-500/15 text-amber-200'
                          : 'border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500 hover:text-white'
                      }`}
                    >
                      {amPeerThreadLabel(p)}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div ref={listRef} className="custom-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
            {tab === 'am' && !activePeerChannel ? (
              <div className="space-y-2 py-6 text-center text-xs text-slate-400">
                <Briefcase className="mx-auto text-amber-500/80" size={22} />
                <p className="font-semibold text-slate-200">Chat com o gerente</p>
                <p>
                  Ainda não tens um contrato de gerência <span className="text-amber-400">activo</span>.
                </p>
                <p className="text-[11px] text-slate-500">
                  Em <strong className="text-slate-300">Gerência</strong> (menu), contrata ou aceita um gerente.
                  Depois volta aqui e a conversa privada abre.
                </p>
              </div>
            ) : loadingHistory && messages.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">A carregar…</p>
            ) : messages.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">
                {tab === 'global'
                  ? `Ainda não há mensagens. Diz olá${currentUsername ? `, ${currentUsername}` : ''}!`
                  : `Conversa privada com ${activePeer?.peerUsername || 'o teu par'}. Envia a primeira mensagem.`}
              </p>
            ) : (
              messages.map((m) => {
                const mine = Number(m.userId) === realUserId || Number(m.userId) === currentUserId;
                const isEditing = editingId === m.id;
                const isAudio = m.kind === 'audio';
                return (
                  <div key={m.id} className={`group flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                    <div
                      className={`max-w-[90%] rounded-xl px-2.5 py-1.5 text-xs leading-snug ${
                        mine
                          ? 'bg-orange-600/90 text-white'
                          : 'border border-slate-700/80 bg-slate-800/90 text-slate-100'
                      }`}
                    >
                      {!mine && (
                        <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300/90">
                          {m.username}
                        </div>
                      )}
                      {isEditing ? (
                        <div className="space-y-1.5">
                          <input
                            ref={editInputRef}
                            type="text"
                            value={editDraft}
                            maxLength={280}
                            onChange={(e) => {
                              const v = e.target.value;
                              setEditDraft(v);
                              refreshMentionSuggestions(v, e.target.selectionStart ?? v.length, true);
                            }}
                            className="w-full rounded-lg border border-white/30 bg-black/20 px-2 py-1 text-xs text-white outline-none"
                            autoFocus
                            onKeyDown={(e) => {
                              if (mentionOpen && mentionUsers.length > 0) {
                                if (e.key === 'ArrowDown') {
                                  e.preventDefault();
                                  setMentionIndex((i) => (i + 1) % mentionUsers.length);
                                  return;
                                }
                                if (e.key === 'ArrowUp') {
                                  e.preventDefault();
                                  setMentionIndex((i) => (i - 1 + mentionUsers.length) % mentionUsers.length);
                                  return;
                                }
                                if (e.key === 'Enter' || e.key === 'Tab') {
                                  e.preventDefault();
                                  applyMention(mentionUsers[mentionIndex] || mentionUsers[0]);
                                  return;
                                }
                                if (e.key === 'Escape') {
                                  e.preventDefault();
                                  closeMentions();
                                  return;
                                }
                              }
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                saveEdit();
                              }
                              if (e.key === 'Escape') cancelEdit();
                            }}
                          />
                          <div className="flex justify-end gap-1">
                            <button
                              type="button"
                              onClick={cancelEdit}
                              className="rounded p-1 text-white/80 hover:bg-black/20"
                              aria-label="Cancelar edição"
                            >
                              <X size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={saveEdit}
                              className="rounded p-1 text-white hover:bg-black/20"
                              aria-label="Guardar edição"
                            >
                              <Check size={12} />
                            </button>
                          </div>
                        </div>
                      ) : isAudio ? (
                        <div className="italic text-white/70">Mensagem de áudio</div>
                      ) : (
                        <div className="whitespace-pre-wrap break-words">
                          {renderChatBody(m.body, {
                            myUsername: currentUsername,
                            mineBubble: mine
                          })}
                        </div>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 px-1 text-[9px] text-slate-500">
                      <span>
                        {formatChatTime(m.createdAt)}
                        {m.editedAt ? ' · editada' : ''}
                      </span>
                      {mine && !isEditing && (
                        <span className="inline-flex gap-0.5 opacity-90 sm:opacity-0 sm:group-hover:opacity-100">
                          {!isAudio && (
                            <button
                              type="button"
                              onClick={() => startEdit(m)}
                              className="rounded p-0.5 hover:bg-slate-700 hover:text-amber-300"
                              aria-label="Editar mensagem"
                              title="Editar"
                            >
                              <Pencil size={11} />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => deleteMsg(m.id)}
                            className="rounded p-0.5 hover:bg-slate-700 hover:text-red-400"
                            aria-label="Apagar mensagem"
                            title="Apagar"
                          >
                            <Trash2 size={11} />
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {error && (
            <div className="border-t border-red-900/40 bg-red-950/40 px-3 py-1.5 text-[10px] text-red-300">{error}</div>
          )}

          <div className="relative border-t border-slate-700/80 bg-slate-950/60 p-2">
            {mentionOpen && mentionUsers.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 z-20 mb-1 overflow-hidden rounded-xl border border-sky-500/40 bg-slate-900 shadow-2xl">
                <div className="border-b border-slate-700/80 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-slate-500">
                  Mencionar
                </div>
                <ul className="max-h-36 overflow-y-auto py-1">
                  {mentionUsers.map((u, i) => (
                    <li key={u.userId}>
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applyMention(u);
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition ${
                          i === mentionIndex
                            ? 'bg-sky-600/30 text-white'
                            : 'text-slate-200 hover:bg-slate-800'
                        }`}
                      >
                        <span className="font-bold text-sky-300">@{mentionInsertToken(u.username)}</span>
                        {mentionInsertToken(u.username) !== u.username && (
                          <span className="truncate text-[10px] text-slate-500">{u.username}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                <input
                  ref={draftInputRef}
                  type="text"
                  value={draft}
                  maxLength={280}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDraft(v);
                    refreshMentionSuggestions(v, e.target.selectionStart ?? v.length, false);
                  }}
                  onKeyDown={(e) => {
                    if (mentionOpen && mentionUsers.length > 0) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setMentionIndex((i) => (i + 1) % mentionUsers.length);
                        return;
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setMentionIndex((i) => (i - 1 + mentionUsers.length) % mentionUsers.length);
                        return;
                      }
                      if (e.key === 'Enter' || e.key === 'Tab') {
                        e.preventDefault();
                        applyMention(mentionUsers[mentionIndex] || mentionUsers[0]);
                        return;
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        closeMentions();
                        return;
                      }
                    }
                  }}
                  placeholder={
                    editingId
                      ? 'A editar mensagem acima…'
                      : tab === 'am'
                        ? 'Mensagem privada… (@user)'
                        : 'Escreve… usa @user para mencionar'
                  }
                  className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white outline-none placeholder:text-slate-500 focus:border-amber-500/60"
                  autoComplete="off"
                  disabled={composerDisabled}
                />
                <button
                  type="submit"
                  disabled={!canSend || (tab === 'am' && !activePeerChannel)}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-600 text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="Enviar"
                >
                  <Send size={15} />
                </button>
              </form>
          </div>
        </div>
  ) : null;

  if (isPanel) return dialog;

  return (
    <div className="flex flex-col items-end gap-2">
      {dialog}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex h-14 w-14 items-center justify-center rounded-full border-2 border-amber-500/70 bg-slate-900 text-amber-400 shadow-[0_8px_30px_rgba(0,0,0,0.55)] transition hover:bg-slate-800 hover:text-amber-300 dark:bg-slate-950"
        aria-label={open ? 'Fechar mini-chat da gerência' : 'Abrir mini-chat da gerência'}
        aria-expanded={open}
      >
        <MessageCircle size={26} />
        {unreadTotal > 0 && !open && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-orange-600 px-1 text-[10px] font-black text-white">
            {unreadTotal > 99 ? '99+' : unreadTotal}
          </span>
        )}
      </button>
    </div>
  );
};
