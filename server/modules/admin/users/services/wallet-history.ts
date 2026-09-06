/**
 * Leitura admin do histórico de carteira Polygon.
 * Reutiliza `getProfileWalletWithHistory` (mesma query); só muda o envelope
 * (`wallet` → `currentWallet`) e exige que o userId exista.
 */
import { prisma } from '../../../../core/database/prisma.js';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import { getProfileWalletWithHistory } from '../../../profile/services/wallet-history.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;

export type AdminUserWalletCurrent = {
  address: string;
  network: string;
  connectedAt: string | null;
  status: 'connected';
};

export type AdminUserWalletHistoryEntry = {
  id: string;
  action: string;
  network: string;
  walletAddress: string | null;
  previousWalletAddress: string | null;
  newWalletAddress: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  actorType: string;
  actorUserId: number | null;
  source: string | null;
  notes: string | null;
  createdAt: string;
  metadata?: unknown;
};

export type AdminUserWalletHistoryPayload = {
  currentWallet: AdminUserWalletCurrent | null;
  history: AdminUserWalletHistoryEntry[];
};

/** Inteiro positivo em string decimal (rejeita 0, negativos, decimais, lixo). */
export function parseAdminWalletHistoryUserId(raw: unknown): number | null {
  const s = String(raw ?? '').trim();
  if (!/^[1-9]\d*$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

export async function loadAdminUserWalletHistory(userIdRaw: unknown): Promise<AdminUserWalletHistoryPayload> {
  const userId = parseAdminWalletHistoryUserId(userIdRaw);
  if (userId == null) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Invalid user id.', code: 'VALIDATION' });
  }

  const exists = await prisma.users.findUnique({ where: { id: userId }, select: { id: true } });
  if (!exists) {
    throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'User not found.', code: 'NOT_FOUND' });
  }

  const raw = await getProfileWalletWithHistory({ userId });
  const wallet =
    raw.wallet && typeof raw.wallet === 'object' ? (raw.wallet as Record<string, unknown>) : null;
  const address = wallet && typeof wallet.address === 'string' ? wallet.address.trim() : '';
  const currentWallet: AdminUserWalletCurrent | null = address
    ? {
        address,
        network: typeof wallet?.network === 'string' && wallet.network.trim() ? wallet.network : 'polygon',
        connectedAt: typeof wallet?.connectedAt === 'string' ? wallet.connectedAt : null,
        status: 'connected'
      }
    : null;

  const history = Array.isArray(raw.history) ? (raw.history as AdminUserWalletHistoryEntry[]) : [];
  return { currentWallet, history };
}
