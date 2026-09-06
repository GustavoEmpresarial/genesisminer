/** Payload mínimo para invalidar / refrescar o strip da navbar. */
export type PlayerHeaderEventReason =
  | 'mining_progress'
  | 'exchange_liquidate'
  | 'deposit_credited'
  | 'header_invalidate';

export type PlayerHeaderEvent = {
  userId: number;
  reason: PlayerHeaderEventReason;
  at: number;
  totalHash?: number;
  usdc?: number;
};

export function parsePlayerHeaderEvent(raw: unknown): PlayerHeaderEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const userId = typeof o.userId === 'number' ? o.userId : parseInt(String(o.userId ?? ''), 10);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  const reason = String(o.reason || 'header_invalidate') as PlayerHeaderEventReason;
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : Date.now();
  const ev: PlayerHeaderEvent = { userId, reason, at };
  if (typeof o.totalHash === 'number' && Number.isFinite(o.totalHash)) ev.totalHash = o.totalHash;
  if (typeof o.usdc === 'number' && Number.isFinite(o.usdc)) ev.usdc = o.usdc;
  return ev;
}
