/**
 * Módulo `chat`: chat global + DM dono↔gerente em tempo real (Socket.IO).
 * O HTTP de histórico/menções/áudio (`POST /api/chat/audio`) é de genesis-api;
 * aqui ficam os serviços partilhados pelo socket e pelo cron de TTL.
 *
 * Wiring no bootstrap: `attachSocketIo(httpServer, (io, socket) => { ... })` não chama
 * `registerChatSocketHandlers` por socket — é `registerChatSocketHandlers(io)` chamado
 * uma vez (regista `io.on('connection', ...)` internamente), não dentro do callback
 * `onConnect` de `attach.ts` (que dispara por conexão). Ver `core/socket/attach.ts`.
 */
export { resolveChatActorFromCookieHeader, resolveChatActorFromHandshakeLike, resolveUserIdFromCookieHeader, resolveUserIdFromHandshakeLike } from './services/auth.js';
export type { ChatActor } from './services/auth.js';

export { looksLikeAudioMagic, resolveAudioExt } from './services/audio-magic.js';

export {
  CHAT_AUDIO_MAX_BYTES,
  CHAT_AUDIO_MAX_DURATION_MS,
  CHAT_AUDIO_PUBLIC_PREFIX,
  CHAT_CHANNEL_GLOBAL,
  CHAT_HISTORY_DEFAULT,
  CHAT_HISTORY_MAX,
  CHAT_KIND_AUDIO,
  CHAT_KIND_TEXT,
  CHAT_MAX_BODY_LEN,
  CHAT_MESSAGE_TTL_MS,
  CHAT_RATE_LIMIT_MS,
  buildAmChannel,
  canMutateChatMessage,
  chatMessageCutoffMs,
  chatRoomName,
  chatUserRoom,
  applyChatPresence,
  checkChatRateLimit,
  deleteChatMessage,
  editChatMessage,
  ensureChatSchema,
  extractMentionTokens,
  getChatMessageById,
  hasActiveAmContract,
  insertChatMessage,
  isChatMessageExpired,
  isSafeChatAudioUrl,
  listAmPeersForUser,
  listChatHistory,
  loadChatSender,
  mentionTokenForUsername,
  normalizeChatChannel,
  parseAmChannel,
  purgeExpiredChatMessages,
  resolveMentionsInBody,
  sanitizeChatBody,
  sanitizeChatMentionQuery,
  sanitizeChatOutboundText,
  sanitizeChatUsername,
  searchChatMentionUsers,
  userCanAccessChatChannel
} from './services/chat.js';
export type { ChatAmPeerDto, ChatMentionDto, ChatMessageDto, ChatMessageKind } from './services/chat.js';

export { registerChatSocketHandlers } from './services/socket.js';
export { startChatTtlCron, type ChatTtlCronDeps } from './services/ttl-cron.js';
