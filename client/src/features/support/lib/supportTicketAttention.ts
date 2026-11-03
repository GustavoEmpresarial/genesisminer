/** Derived admin-list state. Not a stored ticket status. */
export type SupportTicketAttention = 'open' | 'answered' | 'player_followup';

type TimedReply = { createdAt: number };

/**
 * History `messageCount` includes the opening post
 * (`1 + player replies + staff replies` in the worker SQL).
 */
const HISTORY_OPENING_MESSAGE_COUNT = 1;

function latestReplyAt(rows: ReadonlyArray<TimedReply> | undefined): number {
  let latest = 0;
  if (!rows) return latest;
  for (const row of rows) {
    const at = row.createdAt;
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return latest;
}

export function supportTicketAttention(input: {
  status: string;
  replies: ReadonlyArray<TimedReply>;
  playerReplies?: ReadonlyArray<TimedReply>;
}): SupportTicketAttention | 'archived' {
  if (input.status === 'archived') return 'archived';
  const lastPlayer = latestReplyAt(input.playerReplies);
  const lastStaff = latestReplyAt(input.replies);
  if (lastPlayer > lastStaff) return 'player_followup';
  if (lastStaff > 0) return 'answered';
  return 'open';
}

/** History rows have no reply timestamps — `assignedTo` is the last staff username. */
export function supportHistoryAttention(input: {
  status: string;
  assignedTo: string | null;
  messageCount: number;
}): SupportTicketAttention | 'archived' {
  if (input.status === 'archived') return 'archived';
  if (typeof input.assignedTo === 'string' && input.assignedTo.trim().length > 0) return 'answered';
  if (input.messageCount > HISTORY_OPENING_MESSAGE_COUNT) return 'player_followup';
  return 'open';
}
