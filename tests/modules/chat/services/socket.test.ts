import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeSocket() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  return {
    id: 'sock-1',
    data: {} as Record<string, any>,
    handshake: { headers: { cookie: 'gm_access=x' } },
    on: (evt: string, fn: any) => {
      handlers[evt] = fn;
    },
    emit: vi.fn(),
    join: vi.fn().mockResolvedValue(undefined),
    _handlers: handlers
  };
}

function fakeIo() {
  const connectionHandlers: Array<(socket: any) => void> = [];
  return {
    on: (evt: string, fn: any) => {
      if (evt === 'connection') connectionHandlers.push(fn);
    },
    to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    in: vi.fn().mockReturnValue({ fetchSockets: vi.fn().mockResolvedValue([]) }),
    _trigger: (socket: any) => connectionHandlers.forEach((fn) => fn(socket))
  };
}

describe('chat services/socket', () => {
  let authMock: Record<string, any>;
  let chatMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    authMock = { resolveChatActorFromHandshakeLike: vi.fn().mockResolvedValue({ sessionUserId: 1, realUserId: 1, managerMode: false, managerUserId: null, actingAsOwnerId: null, sid: 's1' }) };
    chatMock = {
      CHAT_CHANNEL_GLOBAL: 'global',
      chatRoomName: (c: string) => `chat:${c}`,
      chatUserRoom: (u: number) => `chat:user:${u}`,
      checkChatRateLimit: vi.fn().mockResolvedValue({ ok: true }),
      applyChatPresence: vi.fn().mockResolvedValue({ online: 1 }),
      deleteChatMessage: vi.fn(),
      editChatMessage: vi.fn(),
      ensureChatSchema: vi.fn().mockResolvedValue(undefined),
      insertChatMessage: vi.fn().mockResolvedValue({ id: '1', body: 'oi', channel: 'global' }),
      loadChatSender: vi.fn().mockResolvedValue({ username: 'jogador', isBlocked: false }),
      normalizeChatChannel: (c: unknown) => (c ? String(c) : 'global'),
      resolveMentionsInBody: vi.fn().mockResolvedValue([]),
      sanitizeChatBody: (b: unknown) => (typeof b === 'string' && b.trim() ? b.trim() : null),
      userCanAccessChatChannel: vi.fn().mockResolvedValue(true)
    };
    vi.doMock('../../../../server/modules/chat/services/auth.js', () => authMock);
    vi.doMock('../../../../server/modules/chat/services/chat.js', () => chatMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/chat/services/auth.js');
    vi.doUnmock('../../../../server/modules/chat/services/chat.js');
  });

  async function loadHandlers() {
    const { registerChatSocketHandlers } = await import('../../../../server/modules/chat/services/socket.js');
    const io = fakeIo();
    registerChatSocketHandlers(io as any);
    const socket = fakeSocket();
    io._trigger(socket);
    return { io, socket };
  }

  it('chat:subscribe sem ator autenticado emite chat:error AUTH', async () => {
    authMock.resolveChatActorFromHandshakeLike.mockResolvedValue(null);
    const { socket } = await loadHandlers();
    await socket._handlers['chat:subscribe']();
    expect(socket.emit).toHaveBeenCalledWith('chat:error', expect.objectContaining({ code: 'AUTH' }));
  });

  it('chat:subscribe sem acesso ao canal emite FORBIDDEN', async () => {
    chatMock.userCanAccessChatChannel.mockResolvedValue(false);
    const { socket } = await loadHandlers();
    await socket._handlers['chat:subscribe']();
    expect(socket.emit).toHaveBeenCalledWith('chat:error', expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('chat:subscribe caminho feliz entra na sala e confirma', async () => {
    const { socket } = await loadHandlers();
    await socket._handlers['chat:subscribe']();
    expect(socket.join).toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('chat:subscribed', expect.objectContaining({ ok: true }));
  });

  it('chat:send com corpo vazio emite EMPTY', async () => {
    const { socket } = await loadHandlers();
    await socket._handlers['chat:send']({ body: '   ' });
    expect(socket.emit).toHaveBeenCalledWith('chat:error', expect.objectContaining({ code: 'EMPTY' }));
  });

  it('chat:send respeita rate limit', async () => {
    chatMock.checkChatRateLimit.mockResolvedValue({ ok: false, retryAfterMs: 500 });
    const { socket } = await loadHandlers();
    await socket._handlers['chat:send']({ body: 'oi' });
    expect(socket.emit).toHaveBeenCalledWith('chat:error', expect.objectContaining({ code: 'RATE' }));
    expect(chatMock.insertChatMessage).not.toHaveBeenCalled();
  });

  it('chat:send caminho feliz insere e transmite pra sala', async () => {
    const { io, socket } = await loadHandlers();
    await socket._handlers['chat:send']({ body: 'oi pessoal' });
    expect(chatMock.insertChatMessage).toHaveBeenCalled();
    expect(io.to).toHaveBeenCalledWith('chat:global');
  });
});
