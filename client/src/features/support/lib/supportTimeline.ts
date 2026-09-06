/**
 * Builds a chronological conversation timeline from ticket detail payloads.
 */
import type { MySupportTicketDetail, SupportTicketAttachment } from '../../../shared/api/support';

export type SupportTimelineEntry =
  | { kind: 'open'; at: number; message: string; attachments: SupportTicketAttachment[] }
  | { kind: 'player'; at: number; message: string; attachments: SupportTicketAttachment[] }
  | {
      kind: 'admin';
      at: number;
      adminUsername: string;
      message: string;
      attachments: SupportTicketAttachment[];
    };

function toTime(ts: unknown): number {
  if (ts == null) return 0;
  const n = typeof ts === 'string' ? Number(ts) : typeof ts === 'number' ? ts : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function buildSupportTimeline(d: MySupportTicketDetail): SupportTimelineEntry[] {
  const out: SupportTimelineEntry[] = [
    {
      kind: 'open',
      at: toTime(d.ticket.createdAt),
      message: d.ticket.message,
      attachments: d.ticket.attachments
    }
  ];
  for (const p of d.playerReplies) {
    out.push({
      kind: 'player',
      at: toTime(p.createdAt),
      message: p.message,
      attachments: p.attachments
    });
  }
  for (const a of d.adminReplies) {
    out.push({
      kind: 'admin',
      at: toTime(a.createdAt),
      adminUsername: a.adminUsername,
      message: a.message,
      attachments: a.attachments
    });
  }
  out.sort((x, y) => x.at - y.at);
  return out;
}
