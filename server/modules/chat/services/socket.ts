/**
 * Handlers de Socket.IO do chat (subscribe/send/edit/delete/presença).
 *
 * Migrado de legacy/backend/modules/chat/chat.socket.ts (verbatim). Registado
 * via `onConnect` de `attachSocketIo` (`core/socket/attach.ts`) — não importa
 * mais `core/` diretamente, cada módulo é dono do seu namespace de eventos.
 * 100% independente de upload (áudio entra por `POST /api/chat/audio`, servido
 * por genesis-api).
 */
import type { Server, Socket } from 'socket.io';
import { resolveChatActorFromHandshakeLike, type ChatActor } from './auth.js';
import { applyChatPresence, CHAT_CHANNEL_GLOBAL, chatRoomName, chatUserRoom, checkChatRateLimit, deleteChatMessage, editChatMessage, ensureChatSchema, insertChatMessage, loadChatSender, normalizeChatChannel, resolveMentionsInBody, sanitizeChatBody, userCanAccessChatChannel } from './chat.js';

type ChatSocketData = {
  actor?: ChatActor | null;
  joinedRooms?: Set<string>;
};

async function resolveAndCacheActor(socket: Socket): Promise<ChatActor | null> {
  const data = socket.data as ChatSocketData;
  const actor = await resolveChatActorFromHandshakeLike(socket.handshake);
  data.actor = actor;
  return actor;
}

function payloadChannel(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'channel' in (payload as object)) {
    return normalizeChatChannel((payload as { channel?: unknown }).channel);
  }
  return CHAT_CHANNEL_GLOBAL;
}

function payloadBody(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'body' in (payload as object)) {
    return (payload as { body?: unknown }).body;
  }
  return payload;
}

export function registerChatSocketHandlers(io: Server): void {
  void ensureChatSchema().catch((e) => {
    console.warn('[chat] ensureChatSchema:', e instanceof Error ? e.message : e);
  });

  io.on('connection', (socket: Socket) => {
    const data = socket.data as ChatSocketData;
    data.actor = null;
    data.joinedRooms = new Set();

    socket.on('chat:subscribe', async (payload?: unknown) => {
      try {
        const actor = await resolveAndCacheActor(socket);
        if (!actor) {
          socket.emit('chat:error', { code: 'AUTH', error: 'Sign in to use chat.' });
          return;
        }
        const channel = payloadChannel(payload);
        const allowed = await userCanAccessChatChannel(actor.realUserId, channel);
        if (!allowed) {
          socket.emit('chat:error', { code: 'FORBIDDEN', error: 'No access to this channel.' });
          return;
        }

        const sender = await loadChatSender(actor.realUserId);
        if (!sender) {
          socket.emit('chat:error', { code: 'AUTH', error: 'Invalid user.' });
          return;
        }
        if (sender.isBlocked) {
          socket.emit('chat:error', { code: 'BLOCKED', error: 'Account blocked.' });
          return;
        }

        const room = chatRoomName(channel);
        await socket.join(room);
        data.joinedRooms!.add(room);
        // Sala pessoal para menções @user
        await socket.join(chatUserRoom(actor.realUserId));
        const presence = await applyChatPresence({ action: 'join', channel, socketId: socket.id });
        const online = presence.online;
        socket.emit('chat:subscribed', { ok: true, channel, username: sender.username, online, realUserId: actor.realUserId });
        if (channel === CHAT_CHANNEL_GLOBAL) {
          io.to(room).emit('chat:presence', { channel, online });
        }
      } catch (e) {
        console.warn('[chat:subscribe]', e instanceof Error ? e.message : e);
        socket.emit('chat:error', { code: 'INTERNAL', error: 'Could not join chat.' });
      }
    });

    socket.on('chat:send', async (payload: unknown) => {
      try {
        let actor = (socket.data as ChatSocketData).actor ?? null;
        if (!actor) actor = await resolveAndCacheActor(socket);
        if (!actor) {
          socket.emit('chat:error', { code: 'AUTH', error: 'Sign in to send messages.' });
          return;
        }

        const channel = payloadChannel(payload);
        const body = sanitizeChatBody(payloadBody(payload));
        if (!body) {
          socket.emit('chat:error', { code: 'EMPTY', error: 'Empty message.' });
          return;
        }

        const allowed = await userCanAccessChatChannel(actor.realUserId, channel);
        if (!allowed) {
          socket.emit('chat:error', { code: 'FORBIDDEN', error: 'No access to this channel.' });
          return;
        }

        // Global: enquanto gerencia, fala como dono (conta operada). DM AM: sempre o humano real.
        const senderUserId = channel === CHAT_CHANNEL_GLOBAL ? actor.sessionUserId : actor.realUserId;

        const rate = await checkChatRateLimit(actor.realUserId);
        if (!rate.ok) {
          socket.emit('chat:error', { code: 'RATE', error: 'Wait a moment before sending another message.', retryAfterMs: rate.retryAfterMs });
          return;
        }

        const sender = await loadChatSender(senderUserId);
        if (!sender) {
          socket.emit('chat:error', { code: 'AUTH', error: 'Invalid user.' });
          return;
        }
        if (sender.isBlocked) {
          socket.emit('chat:error', { code: 'BLOCKED', error: 'Account blocked.' });
          return;
        }

        const room = chatRoomName(channel);
        if (!data.joinedRooms?.has(room)) {
          await socket.join(room);
          data.joinedRooms!.add(room);
        }

        const msg = await insertChatMessage({ userId: senderUserId, username: sender.username, body, channel });
        const mentions = await resolveMentionsInBody(body);
        const messagePayload = mentions.length ? { ...msg, mentions } : msg;
        io.to(room).emit('chat:message', messagePayload);
        for (const mention of mentions) {
          if (mention.userId === senderUserId || mention.userId === actor.realUserId) continue;
          io.to(chatUserRoom(mention.userId)).emit('chat:mention', { message: messagePayload, channel });
        }
      } catch (e) {
        console.warn('[chat:send]', e instanceof Error ? e.message : e);
        socket.emit('chat:error', { code: 'INTERNAL', error: 'Failed to send message.' });
      }
    });

    socket.on('chat:edit', async (payload: unknown) => {
      try {
        let actor = (socket.data as ChatSocketData).actor ?? null;
        if (!actor) actor = await resolveAndCacheActor(socket);
        if (!actor) {
          socket.emit('chat:error', { code: 'AUTH', error: 'Sign in to edit messages.' });
          return;
        }
        const id = payload && typeof payload === 'object' && 'id' in (payload as object) ? String((payload as { id?: unknown }).id ?? '') : '';
        const body = payload && typeof payload === 'object' && 'body' in (payload as object) ? (payload as { body?: unknown }).body : '';
        const out = await editChatMessage({ messageId: id, body: String(body ?? ''), actor: { realUserId: actor.realUserId, sessionUserId: actor.sessionUserId } });
        if (!out.ok) {
          socket.emit('chat:error', { code: out.code, error: out.error });
          return;
        }
        const mentions = await resolveMentionsInBody(out.message.body);
        const messagePayload = mentions.length ? { ...out.message, mentions } : out.message;
        io.to(chatRoomName(out.message.channel)).emit('chat:message_updated', messagePayload);
        for (const mention of mentions) {
          if (mention.userId === actor.realUserId || mention.userId === actor.sessionUserId) continue;
          io.to(chatUserRoom(mention.userId)).emit('chat:mention', { message: messagePayload, channel: out.message.channel });
        }
      } catch (e) {
        console.warn('[chat:edit]', e instanceof Error ? e.message : e);
        socket.emit('chat:error', { code: 'INTERNAL', error: 'Failed to edit message.' });
      }
    });

    socket.on('chat:delete', async (payload: unknown) => {
      try {
        let actor = (socket.data as ChatSocketData).actor ?? null;
        if (!actor) actor = await resolveAndCacheActor(socket);
        if (!actor) {
          socket.emit('chat:error', { code: 'AUTH', error: 'Sign in to delete messages.' });
          return;
        }
        const id = payload && typeof payload === 'object' && 'id' in (payload as object) ? String((payload as { id?: unknown }).id ?? '') : String(payload ?? '');
        const out = await deleteChatMessage({ messageId: id, actor: { realUserId: actor.realUserId, sessionUserId: actor.sessionUserId } });
        if (!out.ok) {
          socket.emit('chat:error', { code: out.code, error: out.error });
          return;
        }
        io.to(chatRoomName(out.channel)).emit('chat:message_deleted', { id: out.id, channel: out.channel, deletedAt: out.deletedAt });
      } catch (e) {
        console.warn('[chat:delete]', e instanceof Error ? e.message : e);
        socket.emit('chat:error', { code: 'INTERNAL', error: 'Failed to delete message.' });
      }
    });

    socket.on('disconnect', () => {
      void (async () => {
        try {
          for (const room of data.joinedRooms ?? []) {
            if (room.startsWith('chat:user:')) continue;
            const channel = room.startsWith('chat:') ? room.slice('chat:'.length) : '';
            if (!channel) continue;
            const presence = await applyChatPresence({ action: 'leave', channel, socketId: socket.id });
            if (channel === CHAT_CHANNEL_GLOBAL) {
              io.to(room).emit('chat:presence', { channel: CHAT_CHANNEL_GLOBAL, online: presence.online });
            }
          }
        } catch {
          /* ignore */
        }
      })();
    });
  });
}
