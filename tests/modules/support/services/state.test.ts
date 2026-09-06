import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SUMMARY_ROW = { id: 't1', subject: 'Ajuda', status: 'open', created_at: 1000n, admin_reply_count: 0, last_admin_at: 0n, last_player_at: 1000n };

describe('support services/state', () => {
  let ticketModelMock: Record<string, any>;
  let workerMock: { callMiningWorkerSupportState: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetModules();
    ticketModelMock = { listMySupportTicketSummaries: vi.fn().mockResolvedValue([SUMMARY_ROW]) };
    workerMock = {
      callMiningWorkerSupportState: vi.fn().mockResolvedValue({
        ok: true,
        email: 'jogador@x.com',
        username: 'jogador',
        summaries: [
          {
            id: 't1',
            subject: 'Ajuda',
            status: 'open',
            createdAt: 1000,
            adminReplyCount: 0,
            lastAdminAt: 0,
            lastPlayerAt: 1000
          }
        ]
      })
    };
    vi.doMock('../../../../server/modules/support/services/ticket-model.js', () => ticketModelMock);
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => workerMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/support/services/ticket-model.js');
    vi.doUnmock('../../../../server/modules/mining-engine/services/mining-worker-client.js');
  });

  describe('mapSupportSummariesToPlayerTickets', () => {
    it('marca unreadStaffReply quando o admin respondeu depois do jogador', async () => {
      const { mapSupportSummariesToPlayerTickets } = await import('../../../../server/modules/support/services/state.js');
      const out = mapSupportSummariesToPlayerTickets([{ ...SUMMARY_ROW, admin_reply_count: 1, last_admin_at: 2000n, last_player_at: 1000n }], 20);
      expect(out.tickets[0]!.unreadStaffReply).toBe(true);
    });

    it('não marca unread quando o jogador respondeu por último', async () => {
      const { mapSupportSummariesToPlayerTickets } = await import('../../../../server/modules/support/services/state.js');
      const out = mapSupportSummariesToPlayerTickets([{ ...SUMMARY_ROW, admin_reply_count: 1, last_admin_at: 1000n, last_player_at: 2000n }], 20);
      expect(out.tickets[0]!.unreadStaffReply).toBe(false);
    });

    it('nextCursor só quando a página está cheia', async () => {
      const { mapSupportSummariesToPlayerTickets } = await import('../../../../server/modules/support/services/state.js');
      expect(mapSupportSummariesToPlayerTickets([SUMMARY_ROW], 1).pagination.nextCursor).toBe('1000');
      expect(mapSupportSummariesToPlayerTickets([SUMMARY_ROW], 20).pagination.nextCursor).toBeNull();
    });
  });

  describe('buildSupportStatePayload', () => {
    it('mascara o email e devolve limites/tickets/notice', async () => {
      const { buildSupportStatePayload } = await import('../../../../server/modules/support/services/state.js');
      const out = await buildSupportStatePayload(1, {});
      expect(out).toMatchObject({ ok: true, account: { emailHint: 'j…r@x.com', username: 'jogador' } });
      expect((out.tickets as any[])[0]).toMatchObject({ publicId: 't1' });
    });
  });
});
