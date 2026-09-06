/**
 * Histórico de troca de carteira Polygon (`user_wallet_history`) + leitura pro jogador.
 *
 * Migrado de legacy/backend/modules/profile/profileWalletHistory.service.ts — só a
 * parte usada pelo jogador (`appendUserWalletHistory`, normalização, `getProfileWalletWithHistory`).
 * `fetchAdminWalletHistoryReport` (relatório admin, com backfill automático) fica
 * pendente pra `modules/admin/`.
 */
import type { Prisma } from '@prisma/client';
import { getAddress } from 'ethers';
import { prisma } from '../../../core/database/prisma.js';

export type WalletHistoryAction = 'connected' | 'changed' | 'removed' | 'admin_changed';
export type WalletActorType = 'user' | 'admin' | 'system';

const IP_ADDRESS_MAX_CHARS = 80;
const USER_AGENT_MAX_CHARS = 500;
const SIGNATURE_ADDRESS_MAX_CHARS = 80;
const NETWORK_MAX_CHARS = 32;
const ACTOR_TYPE_MAX_CHARS = 24;
const SOURCE_MAX_CHARS = 80;
const NOTES_MAX_CHARS = 4000;
const WALLET_RAW_TRUNCATE_CHARS = 200;

function truncateStr(raw: unknown, max: number): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.length <= max ? s : s.slice(0, max);
}

export async function appendUserWalletHistory(
  db: Prisma.TransactionClient | typeof prisma,
  input: {
    userId: number;
    action: WalletHistoryAction;
    network?: string;
    walletAddress: string | null;
    previousWalletAddress?: string | null;
    newWalletAddress?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    signatureAddress?: string | null;
    metadata?: Prisma.InputJsonValue;
    actorType?: WalletActorType;
    actorUserId?: number | null;
    source?: string | null;
    notes?: string | null;
  }
): Promise<void> {
  const now = BigInt(Date.now());
  await db.user_wallet_history.create({
    data: {
      user_id: input.userId,
      action: input.action,
      network: (input.network || 'polygon').slice(0, NETWORK_MAX_CHARS),
      wallet_address: input.walletAddress,
      previous_wallet_address: input.previousWalletAddress ?? null,
      new_wallet_address: input.newWalletAddress ?? null,
      ip_address: truncateStr(input.ipAddress, IP_ADDRESS_MAX_CHARS),
      user_agent: truncateStr(input.userAgent, USER_AGENT_MAX_CHARS),
      signature_address: truncateStr(input.signatureAddress, SIGNATURE_ADDRESS_MAX_CHARS),
      signature_message: null,
      created_at: now,
      metadata: input.metadata === undefined ? undefined : input.metadata,
      actor_type: (input.actorType ?? 'user').slice(0, ACTOR_TYPE_MAX_CHARS),
      actor_user_id: input.actorUserId == null || !Number.isFinite(input.actorUserId) ? null : Math.floor(input.actorUserId),
      source: truncateStr(input.source, SOURCE_MAX_CHARS),
      notes: truncateStr(input.notes, NOTES_MAX_CHARS)
    }
  });
}

export function tryNormalizeWallet(raw: string | null | undefined): string | null {
  const t = raw != null ? String(raw).trim() : '';
  if (!t || ['0x', 'null'].includes(t.toLowerCase())) return null;
  try {
    return getAddress(t);
  } catch {
    return t.length > WALLET_RAW_TRUNCATE_CHARS ? t.slice(0, WALLET_RAW_TRUNCATE_CHARS) : t;
  }
}

/** Comparação estável pra detectar mudança real antes de append. */
export function normalizeWalletCompareKey(raw: string | null | undefined): string {
  const n = tryNormalizeWallet(raw);
  return n ? n.toLowerCase() : '';
}

const WALLET_HISTORY_LIMIT_MIN = 1;
const WALLET_HISTORY_LIMIT_MAX = 200;
const WALLET_HISTORY_LIMIT_DEFAULT = 100;

export async function getProfileWalletWithHistory(input: {
  userId: number;
  historyLimit?: number;
}): Promise<Record<string, unknown>> {
  const uid = Number(input.userId);
  const lim = Math.min(WALLET_HISTORY_LIMIT_MAX, Math.max(WALLET_HISTORY_LIMIT_MIN, input.historyLimit ?? WALLET_HISTORY_LIMIT_DEFAULT));

  const userRow = await prisma.users.findUnique({ where: { id: uid }, select: { polygon_wallet: true } });
  const addrNorm = tryNormalizeWallet(userRow?.polygon_wallet ?? null);

  let connectedAt: string | null = null;
  if (addrNorm) {
    const lastLink = await prisma.user_wallet_history.findFirst({
      where: {
        user_id: uid,
        action: { in: ['connected', 'changed', 'admin_changed'] },
        OR: [{ new_wallet_address: addrNorm }, { wallet_address: addrNorm }]
      },
      orderBy: { created_at: 'desc' },
      select: { created_at: true }
    });
    if (lastLink) connectedAt = new Date(Number(lastLink.created_at)).toISOString();
  }

  const histRows = await prisma.user_wallet_history.findMany({
    where: { user_id: uid },
    orderBy: { created_at: 'desc' },
    take: lim,
    select: {
      id: true,
      action: true,
      wallet_address: true,
      network: true,
      previous_wallet_address: true,
      new_wallet_address: true,
      ip_address: true,
      user_agent: true,
      created_at: true,
      actor_type: true,
      actor_user_id: true,
      source: true,
      notes: true,
      metadata: true
    }
  });

  const history = histRows.map((r) => ({
    id: r.id,
    action: r.action,
    walletAddress: r.wallet_address,
    network: r.network,
    previousWalletAddress: r.previous_wallet_address,
    newWalletAddress: r.new_wallet_address,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
    createdAt: new Date(Number(r.created_at)).toISOString(),
    actorType: r.actor_type,
    actorUserId: r.actor_user_id,
    source: r.source,
    notes: r.notes,
    metadata: r.metadata
  }));

  return {
    ok: true,
    wallet: addrNorm ? { address: addrNorm, network: 'polygon', connectedAt } : null,
    history
  };
}
