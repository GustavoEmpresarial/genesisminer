import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Briefcase,
  Check,
  Globe2,
  MessageCircle,
  Mic,
  Minus,
  Pencil,
  Send,
  Smile,
  Square,
  Trash2,
  Users,
  X
} from 'lucide-react';
import {
  getChatHistory,
  getChatPeers,
  searchChatMentions,
  uploadChatAudio,
  sendChatMessage,
  editChatMessage,
  deleteChatMessage,
  type ChatAmPeerDto,
  type ChatMentionDto,
  type ChatMessageDto
} from '../../../shared/api/admin-legacy';

type Props = {
  /** user.id da sessão (dono quando em modo gerência). */
  currentUserId: number;
  currentUsername?: string | null;
  /** Humano real (gerente se estiver a gerir). */
  realUserId?: number | null;
  isManagingAccount?: boolean;
};

type TabId = 'global' | 'am';

const CHAT_AUDIO_MAX_MS = 30_000;
/** Alinhado com backend: mensagens > 1h somem do chat. */
const CHAT_MESSAGE_TTL_MS = 60 * 60 * 1000;

/** Emojis comuns em chats (reação / status / jogo). */
const CHAT_EMOJI_GROUPS: Array<{ label: string; emojis: string[] }> = [
  {
    label: 'Frequentes',
    emojis: ['😀', '😂', '🤣', '😊', '😍', '😎', '🤔', '😅', '😭', '😡', '👍', '👎', '👏', '🙏', '🔥', '❤️', '💯', '✨']
  },
  {
    label: 'Gestos',
    emojis: ['👋', '🤝', '✌️', '🤞', '💪', '👀', '🙌', '👌', '🫡', '🤙', '👊', '🤘']
  },
  {
    label: 'Miner / game',
    emojis: ['⛏️', '💎', '🪙', '💰', '📈', '📉', '⚡', '🔋', '🖥️', '🕹️', '🚀', '🎯', '🏆', '🎁', '📦', '🛒']
  },
  {
    label: 'Status',
    emojis: ['✅', '❌', '⚠️', '❓', '❗', '💤', '🕐', '🟢', '🔴', '🟡', '⭐', '📌']
  }
];

function formatChatTime(ms: number): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatAudioSecs(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `0:${String(s).padStart(2, '0')}`;
}

/** Defesa XSS no cliente (React já escapa texto; isto remove vectores residuais). */
function sanitizeClientChatText(raw: unknown, maxLen = 280): string {
  if (raw == null || typeof raw === 'object') return '';
  let s = String(raw)
    .replace(/\u0000/g, '')
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

function isSafeClientChatAudioUrl(url: unknown): string | null {
  const s = String(url || '').trim();
  if (!s.startsWith('/img/chat-audio/')) return null;
  if (s.includes('..') || s.includes('\\') || s.includes('://') || s.includes('?') || s.includes('#')) {
    return null;
  }
  if (!/^\/img\/chat-audio\/[a-zA-Z0-9._-]+\.(webm|ogg|mp3|m4a|mp4|aac|wav)$/i.test(s)) return null;
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
  const audioUrl = kind === 'audio' ? isSafeClientChatAudioUrl(raw.audioUrl) : null;
  const body = sanitizeClientChatText(raw.body);
  const deletedAt = raw.deletedAt != null ? Number(raw.deletedAt) || null : null;
  if (!body && !audioUrl && !deletedAt) return null;
  return {
    ...raw,
    id,
    kind,
    audioUrl,
    durationMs:
      kind === 'audio' && raw.durationMs != null && Number.isFinite(Number(raw.durationMs))
        ? Math.max(0, Math.floor(Number(raw.durationMs)))
        : null,
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

function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/aac'
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return '';
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

function pruneExpiredMessages(prev: ChatMessageDto[], nowMs = Date.now()): ChatMessageDto[] {
  const cutoff = nowMs - CHAT_MESSAGE_TTL_MS;
  const next = prev.filter((m) => (Number(m.createdAt) || 0) >= cutoff);
  return next.length === prev.length ? prev : next;
}

export const PlayerChatWidget: React.FC<Props> = ({
  currentUserId,
  currentUsername,
  realUserId: realUserIdProp,
  isManagingAccount
}) => {
  const connected = true;
  const realUserId = Number(realUserIdProp) > 0 ? Number(realUserIdProp) : currentUserId;

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabId>('global');
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
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordElapsedMs, setRecordElapsedMs] = useState(0);
  const [mentionUsers, setMentionUsers] = useState<ChatMentionDto[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionForEdit, setMentionForEdit] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const draftInputRef = useRef<HTMLInputElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const emojiPanelRef = useRef<HTMLDivElement | null>(null);
  const mentionTimerRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordChunksRef = useRef<BlobPart[]>([]);
  const recordStartedAtRef = useRef(0);
  const recordTimerRef = useRef<number | null>(null);
  const recordMaxTimerRef = useRef<number | null>(null);
  const recordCancelRef = useRef(false);
  const openRef = useRef(open);
  const tabRef = useRef(tab);
  const peerRef = useRef(activePeerChannel);
  openRef.current = open;
  tabRef.current = tab;
  peerRef.current = activePeerChannel;

  const activeChannel = tab === 'global' ? 'global' : activePeerChannel;
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
    setPeers(res.peers);
    setActivePeerChannel((prev) => {
      if (prev && res.peers!.some((p) => p.channel === prev)) return prev;
      return res.peers![0]?.channel ?? null;
    });
  }, []);

  const stopTracks = useCallback(() => {
    const stream = mediaStreamRef.current;
    mediaStreamRef.current = null;
    if (stream) {
      for (const t of stream.getTracks()) {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      }
    }
  }, []);

  const clearRecordTimers = useCallback(() => {
    if (recordTimerRef.current != null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (recordMaxTimerRef.current != null) {
      window.clearTimeout(recordMaxTimerRef.current);
      recordMaxTimerRef.current = null;
    }
  }, []);

  const cancelRecording = useCallback(() => {
    recordCancelRef.current = true;
    clearRecordTimers();
    const rec = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    try {
      if (rec && rec.state !== 'inactive') rec.stop();
    } catch {
      /* ignore */
    }
    stopTracks();
    recordChunksRef.current = [];
    setRecording(false);
    setRecordElapsedMs(0);
  }, [clearRecordTimers, stopTracks]);

  useEffect(() => {
    void refreshPeers();
  }, [refreshPeers, realUserId, isManagingAccount]);

  useEffect(() => {
    return () => {
      cancelRecording();
    };
  }, [cancelRecording]);

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
      setter(pruneExpiredMessages(res.messages!));
    });
    return () => {
      cancelled = true;
    };
  }, [open, activeChannel, tab]);

  useEffect(() => {
    if (open) scrollToBottom();
  }, [messages, open, scrollToBottom]);

  /** Limpeza local a cada minuto (mesmo sem evento do servidor). */
  useEffect(() => {
    const tick = () => {
      setGlobalMessages((prev) => pruneExpiredMessages(prev));
      setAmMessages((prev) => pruneExpiredMessages(prev));
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!emojiOpen) return;
    const onDoc = (ev: MouseEvent) => {
      const t = ev.target as Node | null;
      if (!t) return;
      if (emojiPanelRef.current?.contains(t)) return;
      setEmojiOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [emojiOpen]);

  const insertEmoji = (emoji: string) => {
    if (editingId) {
      setEditDraft((prev) => {
        if (prev.length + emoji.length > 280) return prev;
        return prev + emoji;
      });
      return;
    }
    setDraft((prev) => {
      if (prev.length + emoji.length > 280) return prev;
      return prev + emoji;
    });
    draftInputRef.current?.focus();
  };

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
      !editingId &&
      !recording
    );
  }, [connected, activeChannel, draft, sending, editingId, recording]);

  const send = () => {
    const body = sanitizeClientChatText(draft);
    if (!body || sending || !activeChannel || recording) return;
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

  const finishRecordingAndSend = useCallback(
    async (blob: Blob, durationMs: number) => {
      if (!activeChannel) {
        setError('Sem canal activo.');
        return;
      }
      if (durationMs < 400) {
        setError('Áudio demasiado curto.');
        return;
      }
      setSending(true);
      setError(null);
      const res = await uploadChatAudio(blob, { channel: activeChannel, durationMs });
      setSending(false);
      if (!res.ok) {
        setError(res.error || 'Falha ao enviar áudio.');
        return;
      }
      if (res.message) {
        const msg = normalizeIncomingChatMessage(res.message);
        if (msg) {
          const ch = String(msg.channel || 'global');
          if (ch === 'global') setGlobalMessages((prev) => upsertMessage(prev, msg));
          else if (peerRef.current === ch) setAmMessages((prev) => upsertMessage(prev, msg));
        }
      }
    },
    [activeChannel]
  );

  const stopRecording = useCallback(
    (opts?: { cancel?: boolean }) => {
      if (opts?.cancel) {
        cancelRecording();
        return;
      }
      clearRecordTimers();
      const rec = mediaRecorderRef.current;
      if (!rec || rec.state === 'inactive') {
        setRecording(false);
        stopTracks();
        return;
      }
      try {
        rec.stop();
      } catch {
        setRecording(false);
        stopTracks();
      }
    },
    [cancelRecording, clearRecordTimers, stopTracks]
  );

  const startRecording = useCallback(async () => {
    if (recording || sending || editingId || !activeChannel) return;
    if (tab === 'am' && !activePeerChannel) {
      setError('Sem gerente/dono activo para conversar.');
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('O teu browser não permite gravar áudio.');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setError('Gravação de áudio não suportada neste browser.');
      return;
    }
    setEmojiOpen(false);
    setError(null);
    recordCancelRef.current = false;
    recordChunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      mediaStreamRef.current = stream;
      const mime = pickRecorderMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = rec;
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recordChunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        clearRecordTimers();
        setRecording(false);
        stopTracks();
        mediaRecorderRef.current = null;
        const cancelled = recordCancelRef.current;
        const chunks = recordChunksRef.current;
        recordChunksRef.current = [];
        const elapsed = Math.min(CHAT_AUDIO_MAX_MS, Date.now() - recordStartedAtRef.current);
        setRecordElapsedMs(0);
        if (cancelled) return;
        const type = rec.mimeType || mime || 'audio/webm';
        const blob = new Blob(chunks, { type });
        if (!blob.size) {
          setError('Não foi possível gravar o áudio.');
          return;
        }
        void finishRecordingAndSend(blob, elapsed);
      };
      recordStartedAtRef.current = Date.now();
      setRecordElapsedMs(0);
      setRecording(true);
      rec.start(250);
      recordTimerRef.current = window.setInterval(() => {
        setRecordElapsedMs(Math.min(CHAT_AUDIO_MAX_MS, Date.now() - recordStartedAtRef.current));
      }, 200);
      recordMaxTimerRef.current = window.setTimeout(() => {
        stopRecording();
      }, CHAT_AUDIO_MAX_MS);
    } catch (err) {
      stopTracks();
      setRecording(false);
      const name = err && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name) : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setError(
          'Microfone bloqueado. Se a permissão do site já está ligada, recarrega a página (Ctrl+F5) — o servidor precisa permitir microfone.'
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setError('Nenhum microfone encontrado neste dispositivo.');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        setError('Microfone ocupado por outra aplicação. Fecha Zoom/Discord/etc. e tenta de novo.');
      } else if (name === 'SecurityError') {
        setError('Microfone bloqueado pela política de segurança do site.');
      } else {
        setError('Não foi possível aceder ao microfone.');
      }
    }
  }, [
    recording,
    sending,
    editingId,
    activeChannel,
    tab,
    activePeerChannel,
    clearRecordTimers,
    stopTracks,
    finishRecordingAndSend,
    stopRecording
  ]);

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

  if (typeof document === 'undefined') return null;

  const hasAmTab = peers.length > 0;
  const amLabel = activePeer?.role === 'owner' ? 'Gerente' : activePeer?.role === 'manager' ? 'Dono' : 'Gerente';
  const composerDisabled = (tab === 'am' && !activePeerChannel) || !!editingId || recording;

  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[220] flex flex-col items-end gap-2">
      {open && (
        <div
          className="pointer-events-auto flex h-[min(460px,72vh)] w-[min(380px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-slate-600/80 bg-slate-900 shadow-2xl dark:bg-slate-950"
          role="dialog"
          aria-label="Bate-papo"
        >
          <div className="flex items-center gap-2 border-b border-slate-700/80 bg-slate-950/80 px-3 py-2.5">
            <MessageCircle size={16} className="shrink-0 text-amber-400" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-black uppercase tracking-widest text-white">Bate-papo</div>
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
                      {activePeer
                        ? `${amLabel}: ${activePeer.peerUsername}`
                        : 'Precisas de gerente activo'}
                    </span>
                  </>
                )}
              </div>
            </div>
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
          </div>

          <div className="flex gap-1 border-b border-amber-500/25 bg-slate-950 p-1.5">
            <button
              type="button"
              onClick={() => {
                setTab('global');
                cancelEdit();
                if (recording) cancelRecording();
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
                if (recording) cancelRecording();
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

          {tab === 'am' && peers.length > 1 && (
            <div className="border-b border-slate-800 px-2 py-1.5">
              <select
                value={activePeerChannel || ''}
                onChange={(e) => {
                  setActivePeerChannel(e.target.value || null);
                  setAmMessages([]);
                  cancelEdit();
                  if (recording) cancelRecording();
                }}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-[11px] text-white outline-none"
              >
                {peers.map((p) => (
                  <option key={p.channel} value={p.channel}>
                    {p.role === 'owner' ? 'Gerente' : 'Dono'}: {p.peerUsername}
                  </option>
                ))}
              </select>
            </div>
          )}

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
                const isAudio = m.kind === 'audio' && !!m.audioUrl;
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
                        <div className="space-y-1">
                          <audio
                            controls
                            preload="metadata"
                            src={m.audioUrl!}
                            className="h-8 max-w-full"
                            style={{ width: '220px' }}
                          />
                          {m.durationMs != null && m.durationMs > 0 && (
                            <div className={`text-[10px] ${mine ? 'text-white/70' : 'text-slate-400'}`}>
                              {formatAudioSecs(m.durationMs)}
                            </div>
                          )}
                        </div>
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
            {mentionOpen && mentionUsers.length > 0 && !recording && (
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

            {emojiOpen && !recording && (
              <div
                ref={emojiPanelRef}
                className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-48 overflow-y-auto rounded-xl border border-slate-600 bg-slate-900 p-2 shadow-2xl custom-scrollbar"
              >
                {CHAT_EMOJI_GROUPS.map((g) => (
                  <div key={g.label} className="mb-2 last:mb-0">
                    <div className="mb-1 px-1 text-[9px] font-bold uppercase tracking-wide text-slate-500">
                      {g.label}
                    </div>
                    <div className="grid grid-cols-8 gap-0.5">
                      {g.emojis.map((em) => (
                        <button
                          key={`${g.label}-${em}`}
                          type="button"
                          onClick={() => insertEmoji(em)}
                          className="flex h-8 items-center justify-center rounded-lg text-base transition hover:bg-slate-800"
                          aria-label={`Emoji ${em}`}
                        >
                          {em}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {recording ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => stopRecording({ cancel: true })}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-300 transition hover:border-red-500/50 hover:text-red-300"
                  aria-label="Cancelar gravação"
                  title="Cancelar"
                >
                  <X size={16} />
                </button>
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-red-500/40 bg-red-950/30 px-3 py-2">
                  <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
                  <span className="text-xs font-semibold text-red-200">
                    A gravar… {formatAudioSecs(recordElapsedMs)} / 0:30
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => stopRecording()}
                  disabled={sending}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-600 text-white transition hover:bg-orange-500 disabled:opacity-40"
                  aria-label="Parar e enviar áudio"
                  title="Enviar áudio"
                >
                  <Square size={14} fill="currentColor" />
                </button>
              </div>
            ) : (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                <button
                  type="button"
                  onClick={() => setEmojiOpen((v) => !v)}
                  disabled={composerDisabled && !editingId}
                  className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition ${
                    emojiOpen
                      ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
                      : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500 hover:text-amber-300'
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                  aria-label="Abrir emojis"
                  aria-expanded={emojiOpen}
                  title="Emojis"
                >
                  <Smile size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => void startRecording()}
                  disabled={composerDisabled || sending || !connected}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-300 transition hover:border-amber-500/50 hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="Gravar áudio (máx. 30s)"
                  title="Áudio (máx. 30s)"
                >
                  <Mic size={16} />
                </button>
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
                  onFocus={() => setEmojiOpen(false)}
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
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="pointer-events-auto relative inline-flex h-14 w-14 items-center justify-center rounded-full border-2 border-amber-500/70 bg-slate-900 text-amber-400 shadow-[0_8px_30px_rgba(0,0,0,0.55)] transition hover:bg-slate-800 hover:text-amber-300 dark:bg-slate-950"
        aria-label={open ? 'Fechar bate-papo' : 'Abrir bate-papo'}
        aria-expanded={open}
      >
        <MessageCircle size={26} />
        {unreadTotal > 0 && !open && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-orange-600 px-1 text-[10px] font-black text-white">
            {unreadTotal > 99 ? '99+' : unreadTotal}
          </span>
        )}
      </button>
    </div>,
    document.body
  );
};
