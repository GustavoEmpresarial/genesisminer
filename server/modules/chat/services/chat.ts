/**
 * Chat global + DM dono↔gerente (account manager).
 *
 * Migrado de legacy/backend/modules/chat/chat.service.ts. `ensureChatSchema`
 * deixou de fazer `CREATE TABLE IF NOT EXISTS` — a tabela `chat_messages` já
 * existe via migration Prisma (mesmo padrão de `modules/quests`) — mantida
 * como no-op assíncrono só para preservar a assinatura chamada pelo controller
 * e pelos handlers de socket.
 */
import {
  callMiningWorkerChatCanAccess,
  callMiningWorkerChatDelete,
  callMiningWorkerChatEdit,
  callMiningWorkerChatGet,
  callMiningWorkerChatHistory,
  callMiningWorkerChatInsert,
  callMiningWorkerChatMentionsResolve,
  callMiningWorkerChatMentionsSearch,
  callMiningWorkerChatPeers,
  callMiningWorkerChatPresence,
  callMiningWorkerChatPurge,
  callMiningWorkerChatRateLimit,
  callMiningWorkerChatSender,
  type MiningWorkerChatRow
} from '../../mining-engine/services/mining-worker-client.js';

export const CHAT_CHANNEL_GLOBAL = 'global';
export const CHAT_MAX_BODY_LEN = 280;
export const CHAT_HISTORY_DEFAULT = 60;
export const CHAT_HISTORY_MAX = 100;
/** Intervalo mínimo entre mensagens por utilizador (ms). */
export const CHAT_RATE_LIMIT_MS = 1200;
export const CHAT_KIND_TEXT = 'text';
export const CHAT_KIND_AUDIO = 'audio';
/** Duração máxima de mensagem de áudio (ms). */
export const CHAT_AUDIO_MAX_DURATION_MS = 30_000;
/** Tamanho máximo do ficheiro de áudio (bytes). */
export const CHAT_AUDIO_MAX_BYTES = 1_500_000;
/** Path público relativo sob /img/ para áudios do chat. */
export const CHAT_AUDIO_PUBLIC_PREFIX = '/img/chat-audio/';
/** Mensagens expiram e são apagadas após 1 hora (histórico + limpeza). */
const CHAT_MESSAGE_TTL_HOURS = 1;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
export const CHAT_MESSAGE_TTL_MS = CHAT_MESSAGE_TTL_HOURS * MINUTES_PER_HOUR * MS_PER_MINUTE;

const MENTION_SEARCH_DEFAULT_LIMIT = 8;
const MENTION_SEARCH_MAX_LIMIT = 10;
const MENTION_TOKEN_MAX_LENGTH = 32;
const MENTION_MAX_TOKENS = 10;
const USERNAME_MAX_LENGTH = 64;
const MENTION_TOKEN_SUFFIX_MAX_LENGTH = 50;

export type ChatMessageKind = 'text' | 'audio';

export type ChatMessageDto = {
  id: string;
  userId: number;
  username: string;
  body: string;
  kind: ChatMessageKind;
  audioUrl: string | null;
  durationMs: number | null;
  createdAt: number;
  channel: string;
  editedAt: number | null;
  deletedAt: number | null;
  /** Resolvido no envio (não persistido). */
  mentions?: ChatMentionDto[];
};

export type ChatMentionDto = { userId: number; username: string };

export type ChatAmPeerDto = {
  channel: string;
  ownerUserId: number;
  managerUserId: number;
  peerUserId: number;
  peerUsername: string;
  role: 'owner' | 'manager';
};

export async function ensureChatSchema(): Promise<void> {
  /* Tabela já existe via migration Prisma — mantido como no-op p/ compat de assinatura. */
}

// eslint-disable-next-line no-control-regex -- uso deliberado: remove bytes de controlo do nome exibido.
const USERNAME_CONTROL_CHARS_RE = /[\u0001-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

/** Via `fromCharCode` pra evitar corrupção de escape \uXXXX em regex literal (mesmo achado de safe-text.ts). */
const NUL_BYTE_RE = new RegExp(String.fromCharCode(0), 'g');

export function sanitizeChatUsername(raw: unknown): string {
  if (raw == null || (typeof raw === 'object' && raw !== null)) return 'Jogador';
  const s = String(raw)
    .normalize('NFKC')
    .replace(NUL_BYTE_RE, '')
    .replace(USERNAME_CONTROL_CHARS_RE, '')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, USERNAME_MAX_LENGTH);
  return s || 'Jogador';
}

// eslint-disable-next-line no-control-regex -- uso deliberado: remove bytes de controlo + overrides bidi do corpo da mensagem.
const BODY_CONTROL_CHARS_RE = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
const HTML_TAG_RE = /<[^>]*>/g;
const DANGEROUS_SCHEME_RE = /(?:javascript|vbscript|data)\s*:/gi;
const EVENT_HANDLER_ATTR_RE = /\bon[a-z]+\s*=/gi;
const DANGEROUS_HTML_ENTITY_RE = /&(?:#x?0*3[ceCE]|lt|gt|quot|apos);/gi;

/**
 * Sanitiza texto de chat (global + DM gerente) contra XSS.
 * SQL injection é mitigado por queries parametrizadas; aqui só limpamos o payload.
 */
export function sanitizeChatBody(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return null;
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return null;

  let s = String(raw).normalize('NFKC').replace(NUL_BYTE_RE, '').replace(BODY_CONTROL_CHARS_RE, '').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  s = s.replace(HTML_TAG_RE, '');
  s = s.replace(/[<>]/g, '');
  s = s.replace(DANGEROUS_SCHEME_RE, '');
  s = s.replace(EVENT_HANDLER_ATTR_RE, '');
  s = s.replace(DANGEROUS_HTML_ENTITY_RE, '');

  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length > CHAT_MAX_BODY_LEN) s = s.slice(0, CHAT_MAX_BODY_LEN);
  if (!s.trim()) return null;
  return s;
}

/** Limpa texto já guardado antes de enviar ao cliente (histórico/socket). */
export function sanitizeChatOutboundText(raw: unknown, maxLen = CHAT_MAX_BODY_LEN): string {
  const cleaned = sanitizeChatBody(raw);
  if (cleaned) return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
  return '';
}

/** Query de menção: só caracteres de username. */
export function sanitizeChatMentionQuery(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/^@+/, '')
    .replace(/[^a-zA-Z0-9_ -]/g, '')
    .trim()
    .slice(0, MENTION_TOKEN_MAX_LENGTH);
}

/** Redis `chat:ratelimit:<userId>` no mining-worker — fail-closed se Redis/worker down. */
export async function checkChatRateLimit(userId: number, nowMs = Date.now()): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  return callMiningWorkerChatRateLimit({ userId, nowMs });
}

export async function applyChatPresence(args: {
  action: 'join' | 'leave' | 'count';
  channel: string;
  socketId?: string;
}): Promise<{ online: number }> {
  return callMiningWorkerChatPresence(args);
}

export function buildAmChannel(ownerUserId: number, managerUserId: number): string {
  return `am:${ownerUserId}:${managerUserId}`;
}

export function parseAmChannel(channelRaw: unknown): { ownerUserId: number; managerUserId: number } | null {
  const channel = String(channelRaw || '').trim();
  const m = /^am:(\d+):(\d+)$/.exec(channel);
  if (!m) return null;
  const ownerUserId = parseInt(m[1]!, 10);
  const managerUserId = parseInt(m[2]!, 10);
  if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) return null;
  if (!Number.isFinite(managerUserId) || managerUserId <= 0) return null;
  if (ownerUserId === managerUserId) return null;
  return { ownerUserId, managerUserId };
}

export function normalizeChatChannel(raw: unknown): string {
  const s = String(raw ?? CHAT_CHANNEL_GLOBAL).trim() || CHAT_CHANNEL_GLOBAL;
  if (s === CHAT_CHANNEL_GLOBAL) return CHAT_CHANNEL_GLOBAL;
  const am = parseAmChannel(s);
  if (am) return buildAmChannel(am.ownerUserId, am.managerUserId);
  return CHAT_CHANNEL_GLOBAL;
}

export function chatRoomName(channel: string): string {
  return `chat:${normalizeChatChannel(channel)}`;
}

function normalizeKind(raw: unknown): ChatMessageKind {
  return String(raw || '').trim().toLowerCase() === CHAT_KIND_AUDIO ? CHAT_KIND_AUDIO : CHAT_KIND_TEXT;
}

export function isSafeChatAudioUrl(raw: unknown): boolean {
  const s = String(raw || '').trim();
  if (!s.startsWith(CHAT_AUDIO_PUBLIC_PREFIX)) return false;
  if (s.includes('..') || s.includes('\\') || s.includes('://') || s.includes('?') || s.includes('#')) {
    return false;
  }
  const name = s.slice(CHAT_AUDIO_PUBLIC_PREFIX.length);
  return /^[a-zA-Z0-9._-]+\.(webm|ogg|mp3|m4a|mp4|aac|wav)$/i.test(name);
}

type ChatRow = {
  id: string | number | bigint;
  user_id: number;
  username_snapshot: string;
  body: string;
  created_at: string | number | bigint;
  channel: string;
  kind: string | null;
  audio_url: string | null;
  duration_ms: number | null;
  edited_at: string | number | bigint | null;
  deleted_at: string | number | bigint | null;
};

function workerRowToChatRow(r: MiningWorkerChatRow): ChatRow {
  return {
    id: r.id,
    user_id: r.userId,
    username_snapshot: r.usernameSnapshot,
    body: r.body,
    created_at: r.createdAt,
    channel: r.channel,
    kind: r.kind,
    audio_url: r.audioUrl,
    duration_ms: r.durationMs,
    edited_at: r.editedAt,
    deleted_at: r.deletedAt
  };
}

function rowToDto(r: ChatRow): ChatMessageDto {
  const deletedAt = r.deleted_at != null ? Number(r.deleted_at) || null : null;
  const kind = normalizeKind(r.kind);
  const audioUrl = !deletedAt && kind === CHAT_KIND_AUDIO && isSafeChatAudioUrl(r.audio_url) ? String(r.audio_url).trim() : null;
  const durationRaw = r.duration_ms != null ? Number(r.duration_ms) : NaN;
  const durationMs = kind === CHAT_KIND_AUDIO && Number.isFinite(durationRaw) && durationRaw > 0 ? Math.min(CHAT_AUDIO_MAX_DURATION_MS, Math.floor(durationRaw)) : null;
  return {
    id: String(r.id),
    userId: Number(r.user_id),
    username: sanitizeChatUsername(r.username_snapshot),
    body: deletedAt ? '' : sanitizeChatOutboundText(r.body),
    kind: deletedAt ? CHAT_KIND_TEXT : kind,
    audioUrl: deletedAt ? null : audioUrl,
    durationMs: deletedAt ? null : durationMs,
    createdAt: Number(r.created_at) || 0,
    channel: normalizeChatChannel(r.channel || CHAT_CHANNEL_GLOBAL),
    editedAt: r.edited_at != null ? Number(r.edited_at) || null : null,
    deletedAt
  };
}

export function chatMessageCutoffMs(nowMs = Date.now()): number {
  return nowMs - CHAT_MESSAGE_TTL_MS;
}

export function isChatMessageExpired(createdAt: number, nowMs = Date.now()): boolean {
  const t = Number(createdAt) || 0;
  return t > 0 && t < chatMessageCutoffMs(nowMs);
}

export async function listChatHistory(opts?: { channel?: string; limit?: number }): Promise<ChatMessageDto[]> {
  const channel = normalizeChatChannel(opts?.channel);
  const limit = Math.min(CHAT_HISTORY_MAX, Math.max(1, Math.floor(Number(opts?.limit) || CHAT_HISTORY_DEFAULT)));
  const out = await callMiningWorkerChatHistory({ channel, limit, nowMs: Date.now() });
  return out.rows.map((r) => rowToDto(workerRowToChatRow(r))).reverse();
}

const PURGE_DEFAULT_LIMIT = 2000;
const PURGE_MAX_LIMIT = 5000;

/**
 * Apaga fisicamente mensagens com mais de 1h via `genesis-mining-worker`
 * (`POST /v1/chat/purge-expired`). Fail-closed — sem DELETE local.
 * Devolve ids/canais/áudios para limpeza em disco + socket (Node).
 */
export async function purgeExpiredChatMessages(opts?: { nowMs?: number; limit?: number }): Promise<{ deleted: number; ids: string[]; channels: string[]; audioUrls: string[]; beforeMs: number }> {
  const limit = Math.min(PURGE_MAX_LIMIT, Math.max(1, Math.floor(Number(opts?.limit) || PURGE_DEFAULT_LIMIT)));
  const out = await callMiningWorkerChatPurge({
    ...(opts?.nowMs != null ? { nowMs: opts.nowMs } : {}),
    limit
  });
  return {
    deleted: out.deleted,
    ids: out.ids,
    channels: out.channels,
    audioUrls: out.audioUrls,
    beforeMs: out.beforeMs
  };
}

export async function insertChatMessage(args: { userId: number; username: string; body: string; channel?: string; createdAt?: number; kind?: ChatMessageKind; audioUrl?: string | null; durationMs?: number | null }): Promise<ChatMessageDto> {
  const channel = normalizeChatChannel(args.channel);
  const createdAt = args.createdAt ?? Date.now();
  const username = sanitizeChatUsername(args.username);
  const kind = args.kind === CHAT_KIND_AUDIO ? CHAT_KIND_AUDIO : CHAT_KIND_TEXT;
  const audioUrl = kind === CHAT_KIND_AUDIO && isSafeChatAudioUrl(args.audioUrl) ? String(args.audioUrl).trim() : null;
  const durationRaw = args.durationMs != null ? Number(args.durationMs) : NaN;
  const durationMs = kind === CHAT_KIND_AUDIO && Number.isFinite(durationRaw) && durationRaw > 0 ? Math.min(CHAT_AUDIO_MAX_DURATION_MS, Math.max(1, Math.floor(durationRaw))) : null;
  const body = kind === CHAT_KIND_AUDIO ? '' : sanitizeChatOutboundText(args.body);
  const out = await callMiningWorkerChatInsert({
    userId: args.userId,
    username,
    body,
    channel,
    createdAt,
    kind,
    audioUrl,
    durationMs
  });
  if (!out.ok) {
    throw new Error(out.error);
  }
  return rowToDto(workerRowToChatRow(out.row));
}

export async function getChatMessageById(messageId: string | number): Promise<{ id: string; userId: number; channel: string; kind: ChatMessageKind; deletedAt: number | null } | null> {
  const id = String(messageId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const out = await callMiningWorkerChatGet(id);
  if (!out.row) return null;
  return {
    id: out.row.id,
    userId: out.row.userId,
    channel: String(out.row.channel || CHAT_CHANNEL_GLOBAL),
    kind: normalizeKind(out.row.kind),
    deletedAt: out.row.deletedAt
  };
}

/** Autor: user_id da mensagem ∈ {realUserId, sessionUserId}. */
export function canMutateChatMessage(messageUserId: number, actor: { realUserId: number; sessionUserId: number }): boolean {
  return messageUserId === actor.realUserId || messageUserId === actor.sessionUserId;
}

export async function editChatMessage(args: { messageId: string | number; body: string; actor: { realUserId: number; sessionUserId: number } }): Promise<{ ok: true; message: ChatMessageDto } | { ok: false; code: string; error: string }> {
  const existing = await getChatMessageById(args.messageId);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'Message not found.' };
  if (existing.deletedAt) return { ok: false, code: 'DELETED', error: 'Message was already deleted.' };
  if (existing.kind === CHAT_KIND_AUDIO) {
    return { ok: false, code: 'AUDIO', error: 'Audio messages cannot be edited.' };
  }
  if (!canMutateChatMessage(existing.userId, args.actor)) {
    return { ok: false, code: 'FORBIDDEN', error: 'You can only edit your own messages.' };
  }
  const allowed = await userCanAccessChatChannel(args.actor.realUserId, existing.channel);
  if (!allowed) return { ok: false, code: 'FORBIDDEN', error: 'No access to this channel.' };

  const body = sanitizeChatBody(args.body);
  if (!body) return { ok: false, code: 'EMPTY', error: 'Empty message.' };

  const editedAt = Date.now();
  const out = await callMiningWorkerChatEdit({ messageId: existing.id, body, editedAt });
  if (!out.ok) {
    return { ok: false, code: out.code ?? 'NOT_FOUND', error: out.error };
  }
  return { ok: true, message: rowToDto(workerRowToChatRow(out.row)) };
}

export async function deleteChatMessage(args: { messageId: string | number; actor: { realUserId: number; sessionUserId: number } }): Promise<{ ok: true; id: string; channel: string; deletedAt: number } | { ok: false; code: string; error: string }> {
  const existing = await getChatMessageById(args.messageId);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'Message not found.' };
  if (existing.deletedAt) return { ok: false, code: 'DELETED', error: 'Message was already deleted.' };
  if (!canMutateChatMessage(existing.userId, args.actor)) {
    return { ok: false, code: 'FORBIDDEN', error: 'You can only delete your own messages.' };
  }
  const allowed = await userCanAccessChatChannel(args.actor.realUserId, existing.channel);
  if (!allowed) return { ok: false, code: 'FORBIDDEN', error: 'No access to this channel.' };

  const deletedAt = Date.now();
  const out = await callMiningWorkerChatDelete({ messageId: existing.id, deletedAt });
  if (!out.ok) {
    return { ok: false, code: out.code ?? 'NOT_FOUND', error: out.error };
  }
  return { ok: true, id: out.id, channel: out.channel, deletedAt: out.deletedAt };
}

export async function loadChatSender(userId: number): Promise<{ username: string; isBlocked: boolean } | null> {
  const out = await callMiningWorkerChatSender(userId);
  if (out.username == null) return null;
  return { username: String(out.username || 'Jogador'), isBlocked: out.isBlocked === true };
}

export async function hasActiveAmContract(ownerUserId: number, managerUserId: number): Promise<boolean> {
  const out = await callMiningWorkerChatCanAccess({
    userId: ownerUserId,
    channel: buildAmChannel(ownerUserId, managerUserId)
  });
  return out.allowed;
}

/** realUserId = humano autenticado (gerente se em manager_mode). */
export async function userCanAccessChatChannel(realUserId: number, channelRaw: unknown): Promise<boolean> {
  const channel = normalizeChatChannel(channelRaw);
  if (channel === CHAT_CHANNEL_GLOBAL) return true;
  const out = await callMiningWorkerChatCanAccess({ userId: realUserId, channel });
  return out.allowed;
}

export async function listAmPeersForUser(realUserId: number): Promise<ChatAmPeerDto[]> {
  const out = await callMiningWorkerChatPeers(realUserId);
  return out.rows.map((r) => {
    const ownerUserId = Number(r.ownerUserId);
    const managerUserId = Number(r.managerUserId);
    const isOwner = realUserId === ownerUserId;
    return {
      channel: buildAmChannel(ownerUserId, managerUserId),
      ownerUserId,
      managerUserId,
      peerUserId: isOwner ? managerUserId : ownerUserId,
      peerUsername: isOwner ? String(r.managerUsername || 'Gerente') : String(r.ownerUsername || 'Dono'),
      role: isOwner ? ('owner' as const) : ('manager' as const)
    };
  });
}

export function chatUserRoom(userId: number): string {
  return `chat:user:${Math.floor(Number(userId) || 0)}`;
}

/** Tokens @nome no texto (sem espaços no token). */
export function extractMentionTokens(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(^|[\s([{])@([a-zA-Z0-9_][a-zA-Z0-9_-]{0,49})/g;
  let m: RegExpExecArray | null;
  const s = String(body || '');
  while ((m = re.exec(s)) != null) {
    const token = String(m[2] || '');
    const key = token.toLowerCase();
    if (!token || seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    if (out.length >= MENTION_MAX_TOKENS) break;
  }
  return out;
}

export async function searchChatMentionUsers(queryRaw: unknown, opts?: { limit?: number; excludeUserId?: number }): Promise<ChatMentionDto[]> {
  const q = sanitizeChatMentionQuery(queryRaw);
  if (q.length < 1) return [];
  const limit = Math.min(MENTION_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(Number(opts?.limit) || MENTION_SEARCH_DEFAULT_LIMIT)));
  const exclude = Number(opts?.excludeUserId);
  const hasExclude = Number.isFinite(exclude) && exclude > 0;
  const out = await callMiningWorkerChatMentionsSearch({
    query: q,
    limit,
    ...(hasExclude ? { excludeUserId: exclude } : {})
  });
  return out.users.map((r) => ({ userId: Number(r.userId), username: sanitizeChatUsername(r.username) })).filter((r) => r.userId > 0 && !!r.username);
}

export async function resolveMentionsInBody(body: string): Promise<ChatMentionDto[]> {
  const tokens = extractMentionTokens(body);
  if (!tokens.length) return [];
  const keys = [...new Set(tokens.map((t) => t.toLowerCase()))];
  const resolved = await callMiningWorkerChatMentionsResolve(keys);
  const byKey = new Map<string, ChatMentionDto>();
  for (const r of resolved.users) {
    const username = sanitizeChatUsername(r.username);
    const userId = Number(r.userId);
    if (!username || !(userId > 0)) continue;
    const dto = { userId, username };
    byKey.set(username.toLowerCase(), dto);
    byKey.set(username.replace(/\s+/g, '').toLowerCase(), dto);
    byKey.set(username.replace(/\s+/g, '_').toLowerCase(), dto);
  }
  const out: ChatMentionDto[] = [];
  const seenIds = new Set<number>();
  for (const token of tokens) {
    const hit = byKey.get(token.toLowerCase());
    if (!hit || seenIds.has(hit.userId)) continue;
    seenIds.add(hit.userId);
    out.push(hit);
  }
  return out;
}

/** Token a inserir no texto ao escolher um user (sem espaços). */
export function mentionTokenForUsername(username: string): string {
  const s = sanitizeChatUsername(username);
  const safeTokenRe = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,49}$/;
  if (!s || s === 'Jogador') {
    const raw = String(username || '').trim();
    if (safeTokenRe.test(raw)) return raw;
  }
  if (safeTokenRe.test(s)) return s;
  return s
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, MENTION_TOKEN_SUFFIX_MAX_LENGTH);
}
