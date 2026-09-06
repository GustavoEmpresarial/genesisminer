/**
 * Profile API — identity, password, referral, wallet (Polygon).
 * Mirrors legacy `services/api.ts` profile helpers; omits routes not yet on current server
 * (`GET /me/profile-bundle`, `GET /profile/badges`).
 */
import { apiFetch } from './http';

const base = '/api';

export type ProfilePageBundle = {
  seasonPasses: unknown[];
  seasonPurchases: unknown[];
  accessLevels: Array<{ id: string; name: string; isActive: boolean; newsPostingEnabled?: boolean }>;
  referrals: string[];
  lootBoxes: unknown[];
  newsFee: number;
  profileGame: { usdc: number; claimedReferrals: number };
};

/** Estado consolidado do perfil (`GET /api/profile/state`). */
export type ProfileApiState = {
  ok: true;
  identity: {
    email: string;
    username: string;
    displayName: string;
    accessLevelId: string;
    accessLevelLabel: string;
    status: string;
    emailReadOnly: boolean;
  };
  permissions: {
    canChangeUsername: boolean;
    canBindReferral: boolean;
    canConnectWallet: boolean;
    canRemoveWallet: boolean;
  };
  limits: { usernameMin: number; usernameMax: number; passwordMax: number; referralCodeMax: number };
  referral: {
    code: string | null;
    inviteUrl: string;
    invitedCount: number;
    commissionPercent: number;
    commissionRule: string;
    referredBy: string | null;
  };
  wallet: { network: string; chainId: number; address: string | null };
  /** Present on legacy server only — optional on current server. */
  badges?: Array<{
    passId: string;
    seasonId: string;
    name: string;
    imageUrl: string | null;
    purchasedAt: number;
  }>;
  /** Present on legacy server only — optional on current server. */
  bundle?: ProfilePageBundle;
  accessLevelsCatalog: Array<{ id: string; name: string; isActive: boolean; newsPostingEnabled: boolean }>;
  userAccessLevelIds: string[];
};

export type ProfileWalletHistoryDto = {
  id: string;
  action: string;
  walletAddress: string | null;
  network: string;
  previousWalletAddress: string | null;
  newWalletAddress: string | null;
  createdAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  actorType?: string | null;
  actorUserId?: number | null;
  source?: string | null;
  notes?: string | null;
  metadata?: unknown;
};

export type ReferralOverview = {
  ok: true;
  referralCode: string | null;
  inviteUrl: string | null;
  referredBy: string | null;
  stats: {
    invitedCount: number;
    totalReferredDepositsUsdc: number;
    totalCommissionUsdc: number;
    paidCommissionUsdc: number;
    pendingCommissionUsdc: number;
    commissionRate: number;
    commissionPercent: number;
    commissionsCount: number;
  };
  referredUsers: Array<{
    id: number;
    username: string | null;
    emailMasked: string | null;
    createdAt: number;
    linkId: number;
    totalDepositedUsdc: number;
    totalCommissionUsdc: number;
    commissionsCount: number;
  }>;
  commissions: Array<{
    id: string;
    createdAt: number;
    referredUser: { id: number; username: string | null; emailMasked: string | null };
    depositAmountUsdc: number;
    commissionRate: number;
    commissionAmountUsdc: number;
    sourceType: string;
    sourceTransactionId: string;
    status: 'paid';
  }>;
};

export async function getProfileState(): Promise<ProfileApiState | null> {
  try {
    const res = await apiFetch(`${base}/profile/state`);
    const raw = await res.json().catch(() => null);
    if (!res.ok || !raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
    return raw as ProfileApiState;
  } catch {
    return null;
  }
}

export async function patchProfileIdentity(
  username: string
): Promise<{ ok: boolean; error?: string; code?: string }> {
  try {
    const res = await apiFetch(`${base}/profile/identity`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!res.ok) return { ok: false, error: data.error || `Erro ${res.status}`, code: data.code };
    return { ok: true, ...(typeof data === 'object' ? data : {}) } as { ok: boolean; error?: string; code?: string };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function postProfilePasswordChange(payload: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<{ ok: boolean; error?: string; code?: string; message?: string }> {
  try {
    const res = await apiFetch(`${base}/profile/password/change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      message?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `Erro ${res.status}`, code: data.code };
    return { ok: true, message: data.message };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function getReferralOverview(): Promise<ReferralOverview | null> {
  try {
    const res = await apiFetch(`${base}/profile/referral/overview`);
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
    return raw as ReferralOverview;
  } catch {
    return null;
  }
}

export async function postProfileReferralBind(
  code: string
): Promise<{ ok: boolean; error?: string; code?: string }> {
  try {
    const res = await apiFetch(`${base}/profile/referral/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!res.ok) return { ok: false, error: data.error || `Erro ${res.status}`, code: data.code };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function getProfileWallet(limit = 100): Promise<{
  ok: boolean;
  wallet: { address: string; network: string; connectedAt: string | null } | null;
  history: ProfileWalletHistoryDto[];
  error?: string;
} | null> {
  try {
    const lim = Math.min(200, Math.max(1, limit));
    const res = await apiFetch(`${base}/profile/wallet?limit=${lim}`);
    const raw = await res.json().catch(() => null);
    if (!res.ok || !raw || typeof raw !== 'object') {
      const err =
        raw && typeof raw === 'object' && 'error' in raw
          ? String((raw as { error?: unknown }).error)
          : null;
      return { ok: false, wallet: null, history: [], error: err || `Erro ${res.status}` };
    }
    const d = raw as Record<string, unknown>;
    const hist = Array.isArray(d.history) ? (d.history as ProfileWalletHistoryDto[]) : [];
    const w =
      d.wallet && typeof d.wallet === 'object'
        ? (d.wallet as { address: string; network: string; connectedAt: string | null })
        : null;
    return { ok: true, wallet: w, history: hist };
  } catch {
    return null;
  }
}

export async function postProfileWalletRemove(): Promise<{
  ok: boolean;
  removed?: boolean;
  message?: string;
  error?: string;
  code?: string;
}> {
  try {
    const res = await apiFetch(`${base}/profile/wallet/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      message?: string;
      removed?: boolean;
    };
    if (!res.ok) {
      return { ok: false, error: data.error || `Erro ${res.status}`, code: data.code };
    }
    return {
      ok: true,
      removed: data.removed === true,
      message:
        typeof data.message === 'string'
          ? data.message
          : data.removed === true
            ? 'Carteira removida com sucesso.'
            : 'Nenhuma carteira conectada.'
    };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function postProfileWalletChallenge(): Promise<{
  ok: boolean;
  challengeId?: string;
  message?: string;
  expiresAt?: number;
  chainId?: number;
  error?: string;
  code?: string;
}> {
  try {
    const res = await apiFetch(`${base}/profile/wallet/connect/challenge`, { method: 'POST' });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: (data.error as string) || `Erro ${res.status}`,
        code: data.code as string | undefined
      };
    }
    return {
      ok: true,
      challengeId: typeof data.challengeId === 'string' ? data.challengeId : undefined,
      message: typeof data.message === 'string' ? data.message : undefined,
      expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : undefined,
      chainId: typeof data.chainId === 'number' ? data.chainId : undefined
    };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}

export async function postProfileWalletVerify(payload: {
  challengeId: string;
  address: string;
  signature: string;
  chainId: number;
}): Promise<{ ok: boolean; error?: string; code?: string; address?: string }> {
  try {
    const res = await apiFetch(`${base}/profile/wallet/connect/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      address?: string;
    };
    if (!res.ok) return { ok: false, error: data.error || `Erro ${res.status}`, code: data.code };
    return { ok: true, address: data.address };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}
