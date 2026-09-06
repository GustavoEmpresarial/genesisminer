import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('chat services/chat', () => {
  let dbMock: Record<string, any>;
  let workerMock: {
    callMiningWorkerChatPurge: ReturnType<typeof vi.fn>;
    callMiningWorkerChatInsert: ReturnType<typeof vi.fn>;
    callMiningWorkerChatEdit: ReturnType<typeof vi.fn>;
    callMiningWorkerChatDelete: ReturnType<typeof vi.fn>;
    callMiningWorkerChatHistory: ReturnType<typeof vi.fn>;
    callMiningWorkerChatGet: ReturnType<typeof vi.fn>;
    callMiningWorkerChatSender: ReturnType<typeof vi.fn>;
    callMiningWorkerChatPeers: ReturnType<typeof vi.fn>;
    callMiningWorkerChatMentionsSearch: ReturnType<typeof vi.fn>;
    callMiningWorkerChatMentionsResolve: ReturnType<typeof vi.fn>;
    callMiningWorkerChatCanAccess: ReturnType<typeof vi.fn>;
    callMiningWorkerChatRateLimit: ReturnType<typeof vi.fn>;
    callMiningWorkerChatPresence: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetModules();
    dbMock = { default: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) } };
    workerMock = {
      callMiningWorkerChatPurge: vi.fn(),
      callMiningWorkerChatInsert: vi.fn(),
      callMiningWorkerChatEdit: vi.fn(),
      callMiningWorkerChatDelete: vi.fn(),
      callMiningWorkerChatHistory: vi.fn(),
      callMiningWorkerChatGet: vi.fn(),
      callMiningWorkerChatSender: vi.fn(),
      callMiningWorkerChatPeers: vi.fn(),
      callMiningWorkerChatMentionsSearch: vi.fn(),
      callMiningWorkerChatMentionsResolve: vi.fn(),
      callMiningWorkerChatCanAccess: vi.fn().mockResolvedValue({ allowed: true }),
      callMiningWorkerChatRateLimit: vi.fn().mockResolvedValue({ ok: true }),
      callMiningWorkerChatPresence: vi.fn().mockResolvedValue({ online: 1 })
    };
    vi.doMock('../../../../server/core/database/pool.js', () => dbMock);
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => workerMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/pool.js');
    vi.doUnmock('../../../../server/modules/mining-engine/services/mining-worker-client.js');
  });

  describe('sanitizeChatUsername', () => {
    it('remove bytes de controlo e caracteres de tag HTML', async () => {
      const { sanitizeChatUsername } = await import('../../../../server/modules/chat/services/chat.js');
      expect(sanitizeChatUsername('<b>Nome</b>')).toBe('bNome/b');
    });

    it('objeto ou null cai em Jogador', async () => {
      const { sanitizeChatUsername } = await import('../../../../server/modules/chat/services/chat.js');
      expect(sanitizeChatUsername(null)).toBe('Jogador');
      expect(sanitizeChatUsername({})).toBe('Jogador');
    });
  });

  describe('sanitizeChatBody', () => {
    it('remove tags (mantém texto interno), esquemas perigosos e handlers de evento', async () => {
      const { sanitizeChatBody } = await import('../../../../server/modules/chat/services/chat.js');
      expect(sanitizeChatBody('<script>alert(1)</script>oi')).toBe('alert(1)oi');
      expect(sanitizeChatBody('javascript:alert(1)')).toBe('alert(1)');
      expect(sanitizeChatBody('onclick=alert(1)')).toBe('alert(1)');
    });

    it('objeto/array não é texto válido', async () => {
      const { sanitizeChatBody } = await import('../../../../server/modules/chat/services/chat.js');
      expect(sanitizeChatBody({})).toBeNull();
      expect(sanitizeChatBody([1, 2])).toBeNull();
    });

    it('trunca no tamanho máximo', async () => {
      const { sanitizeChatBody, CHAT_MAX_BODY_LEN } = await import('../../../../server/modules/chat/services/chat.js');
      const out = sanitizeChatBody('a'.repeat(500));
      expect(out!.length).toBe(CHAT_MAX_BODY_LEN);
    });
  });

  describe('normalizeChatChannel / buildAmChannel / parseAmChannel', () => {
    it('canal global permanece global', async () => {
      const { normalizeChatChannel, CHAT_CHANNEL_GLOBAL } = await import('../../../../server/modules/chat/services/chat.js');
      expect(normalizeChatChannel('global')).toBe(CHAT_CHANNEL_GLOBAL);
      expect(normalizeChatChannel(undefined)).toBe(CHAT_CHANNEL_GLOBAL);
    });

    it('canal am:owner:manager válido é preservado', async () => {
      const { normalizeChatChannel, buildAmChannel } = await import('../../../../server/modules/chat/services/chat.js');
      expect(normalizeChatChannel('am:1:2')).toBe(buildAmChannel(1, 2));
    });

    it('canal am com owner igual a manager é inválido: cai pro global', async () => {
      const { normalizeChatChannel, CHAT_CHANNEL_GLOBAL } = await import('../../../../server/modules/chat/services/chat.js');
      expect(normalizeChatChannel('am:5:5')).toBe(CHAT_CHANNEL_GLOBAL);
    });
  });

  describe('checkChatRateLimit', () => {
    it('delega ao worker Redis', async () => {
      workerMock.callMiningWorkerChatRateLimit.mockResolvedValueOnce({ ok: true });
      workerMock.callMiningWorkerChatRateLimit.mockResolvedValueOnce({ ok: false, retryAfterMs: 400 });
      const { checkChatRateLimit } = await import('../../../../server/modules/chat/services/chat.js');
      expect(await checkChatRateLimit(42, 10_000_000)).toEqual({ ok: true });
      expect(await checkChatRateLimit(42, 10_000_100)).toEqual({ ok: false, retryAfterMs: 400 });
      expect(workerMock.callMiningWorkerChatRateLimit).toHaveBeenCalled();
    });
  });

  describe('isSafeChatAudioUrl', () => {
    it('aceita só caminho sob o prefixo público com extensão permitida', async () => {
      const { isSafeChatAudioUrl } = await import('../../../../server/modules/chat/services/chat.js');
      expect(isSafeChatAudioUrl('/img/chat-audio/a.webm')).toBe(true);
      expect(isSafeChatAudioUrl('/img/chat-audio/../../etc/passwd')).toBe(false);
      expect(isSafeChatAudioUrl('https://evil.com/x.webm')).toBe(false);
    });
  });

  describe('extractMentionTokens / mentionTokenForUsername', () => {
    it('extrai tokens @username sem duplicados, até o limite', async () => {
      const { extractMentionTokens } = await import('../../../../server/modules/chat/services/chat.js');
      expect(extractMentionTokens('oi @joao e @maria, @joao de novo')).toEqual(['joao', 'maria']);
    });

    it('mentionTokenForUsername normaliza espaços em _', async () => {
      const { mentionTokenForUsername } = await import('../../../../server/modules/chat/services/chat.js');
      expect(mentionTokenForUsername('Nome Composto')).toBe('Nome_Composto');
    });
  });

  describe('canMutateChatMessage', () => {
    it('true quando o autor é o realUserId ou o sessionUserId', async () => {
      const { canMutateChatMessage } = await import('../../../../server/modules/chat/services/chat.js');
      expect(canMutateChatMessage(5, { realUserId: 5, sessionUserId: 9 })).toBe(true);
      expect(canMutateChatMessage(9, { realUserId: 5, sessionUserId: 9 })).toBe(true);
      expect(canMutateChatMessage(1, { realUserId: 5, sessionUserId: 9 })).toBe(false);
    });
  });

  describe('userCanAccessChatChannel', () => {
    it('global sempre permitido, sem consultar o worker', async () => {
      const { userCanAccessChatChannel } = await import('../../../../server/modules/chat/services/chat.js');
      expect(await userCanAccessChatChannel(1, 'global')).toBe(true);
      expect(workerMock.callMiningWorkerChatCanAccess).not.toHaveBeenCalled();
    });

    it('canal am: só dono/gerente do contrato ativo têm acesso', async () => {
      workerMock.callMiningWorkerChatCanAccess.mockResolvedValueOnce({ allowed: true });
      const { userCanAccessChatChannel } = await import('../../../../server/modules/chat/services/chat.js');
      expect(await userCanAccessChatChannel(1, 'am:1:2')).toBe(true);
      expect(workerMock.callMiningWorkerChatCanAccess).toHaveBeenCalledWith({ userId: 1, channel: 'am:1:2' });
      workerMock.callMiningWorkerChatCanAccess.mockResolvedValueOnce({ allowed: false });
      expect(await userCanAccessChatChannel(99, 'am:1:2')).toBe(false);
    });
  });

  describe('insertChatMessage / getChatMessageById / editChatMessage / deleteChatMessage', () => {
    it('insertChatMessage grava e devolve o DTO mapeado', async () => {
      workerMock.callMiningWorkerChatInsert.mockResolvedValue({
        ok: true,
        row: {
          id: '1',
          userId: 1,
          usernameSnapshot: 'jogador',
          body: 'oi',
          createdAt: 1000,
          channel: 'global',
          kind: 'text',
          audioUrl: null,
          durationMs: null,
          editedAt: null,
          deletedAt: null
        }
      });
      const { insertChatMessage } = await import('../../../../server/modules/chat/services/chat.js');
      const msg = await insertChatMessage({ userId: 1, username: 'jogador', body: 'oi' });
      expect(msg).toMatchObject({ id: '1', userId: 1, body: 'oi', channel: 'global' });
      expect(workerMock.callMiningWorkerChatInsert).toHaveBeenCalled();
    });

    it('editChatMessage: mensagem de outro utilizador é FORBIDDEN', async () => {
      workerMock.callMiningWorkerChatGet.mockResolvedValue({
        ok: true,
        row: { id: '1', userId: 99, channel: 'global', kind: 'text', deletedAt: null }
      });
      const { editChatMessage } = await import('../../../../server/modules/chat/services/chat.js');
      const out = await editChatMessage({ messageId: '1', body: 'novo texto', actor: { realUserId: 1, sessionUserId: 1 } });
      expect(out).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    });

    it('deleteChatMessage: mensagem já apagada devolve DELETED', async () => {
      workerMock.callMiningWorkerChatGet.mockResolvedValue({
        ok: true,
        row: { id: '1', userId: 1, channel: 'global', kind: 'text', deletedAt: 500 }
      });
      const { deleteChatMessage } = await import('../../../../server/modules/chat/services/chat.js');
      const out = await deleteChatMessage({ messageId: '1', actor: { realUserId: 1, sessionUserId: 1 } });
      expect(out).toMatchObject({ ok: false, code: 'DELETED' });
    });
  });
});
