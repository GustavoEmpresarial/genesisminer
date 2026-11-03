import { describe, expect, it } from 'vitest';
import {
  supportHistoryAttention,
  supportTicketAttention
} from '../../../../../client/src/features/support/lib/supportTicketAttention.js';

describe('supportTicketAttention', () => {
  it('stays open when nobody has replied', () => {
    expect(
      supportTicketAttention({ status: 'open', replies: [], playerReplies: [] })
    ).toBe('open');
  });

  it('is answered when staff replied last', () => {
    expect(
      supportTicketAttention({
        status: 'open',
        replies: [{ createdAt: 200 }],
        playerReplies: [{ createdAt: 100 }]
      })
    ).toBe('answered');
  });

  it('treats equal timestamps as answered', () => {
    expect(
      supportTicketAttention({
        status: 'open',
        replies: [{ createdAt: 100 }],
        playerReplies: [{ createdAt: 100 }]
      })
    ).toBe('answered');
  });

  it('is a player follow-up when the player wrote after staff', () => {
    expect(
      supportTicketAttention({
        status: 'open',
        replies: [{ createdAt: 100 }],
        playerReplies: [{ createdAt: 250 }]
      })
    ).toBe('player_followup');
  });

  it('is a player follow-up when the player wrote again before any staff reply', () => {
    expect(
      supportTicketAttention({
        status: 'open',
        replies: [],
        playerReplies: [{ createdAt: 50 }]
      })
    ).toBe('player_followup');
  });

  it('stays archived even when replies exist', () => {
    expect(
      supportTicketAttention({
        status: 'archived',
        replies: [{ createdAt: 10 }],
        playerReplies: [{ createdAt: 20 }]
      })
    ).toBe('archived');
  });

  it('ignores non-finite timestamps', () => {
    expect(
      supportTicketAttention({
        status: 'open',
        replies: [{ createdAt: Number.NaN }],
        playerReplies: [{ createdAt: 0 }]
      })
    ).toBe('open');
  });
});

describe('supportHistoryAttention', () => {
  it('uses the last staff username as answered', () => {
    expect(
      supportHistoryAttention({ status: 'open', assignedTo: 'zmin', messageCount: 2 })
    ).toBe('answered');
  });

  it('marks extra messages without staff as a player follow-up', () => {
    expect(
      supportHistoryAttention({ status: 'open', assignedTo: null, messageCount: 2 })
    ).toBe('player_followup');
  });

  it('stays open for the opening message only', () => {
    expect(
      supportHistoryAttention({ status: 'open', assignedTo: '  ', messageCount: 1 })
    ).toBe('open');
  });
});
