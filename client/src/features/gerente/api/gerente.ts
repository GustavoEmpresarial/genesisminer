import { apiFetch } from '../../../shared/api/http';

const base = '/api';

export type AccountManagerContractDto = {
  id: number;
  ownerUserId: number;
  managerUserId: number;
  status: string;
  hiredAt: number | null;
  endsAt: number | null;
  fireLockedUntil: number | null;
  canFire: boolean;
  createdAt: number;
  updatedAt: number;
  ownerUsername?: string;
  ownerEmail?: string;
  managerUsername?: string;
  managerEmail?: string;
};

export type AccountManagerEarningsCoin = {
  coinId: string;
  symbol: string;
  name: string;
  totalShare: number;
  paidShare: number;
  pendingShare: number;
};

export type AccountManagerEarningsSummary = {
  activeContracts: number;
  endedContracts: number;
  managedContracts: number;
  byCoin: AccountManagerEarningsCoin[];
};

export type AccountManagerMeResponse = {
  ok: boolean;
  error?: string;
  code?: string;
  sharePercent?: number;
  fireLockDays?: number;
  /** Quantas contas ativas estás a gerir agora. */
  activeManagedCount?: number;
  weekStart?: number;
  asOwner?: AccountManagerContractDto[];
  asManager?: AccountManagerContractDto[];
  managerEarnings?: AccountManagerEarningsSummary;
  weekAccruals?: Array<{
    contractId: number;
    coinId: string;
    weekStart: number;
    ownerMinedAmount: number;
    managerShareAmount: number;
    paidAt: number | null;
  }>;
};

async function amJson(
  res: Response
): Promise<AccountManagerMeResponse & { ok: boolean; error?: string; code?: string }> {
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
      code: typeof body.code === 'string' ? body.code : undefined
    };
  }
  return { ok: true, ...(body as Omit<AccountManagerMeResponse, 'ok'>) };
}

/** GET /api/account-manager/me */
export async function getAccountManagerMe(): Promise<AccountManagerMeResponse> {
  try {
    const res = await apiFetch(`${base}/account-manager/me`);
    return amJson(res);
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** POST /api/account-manager/hire */
export async function postAccountManagerHire(target: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/account-manager/hire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target })
    });
    return amJson(res);
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** POST /api/account-manager/apply */
export async function postAccountManagerApply(target: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/account-manager/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target })
    });
    return amJson(res);
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** POST /api/account-manager/accept */
export async function postAccountManagerAccept(contractId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/account-manager/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractId })
    });
    return amJson(res);
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** POST /api/account-manager/decline */
export async function postAccountManagerDecline(contractId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/account-manager/decline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractId })
    });
    return amJson(res);
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** POST /api/account-manager/fire */
export async function postAccountManagerFire(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/account-manager/fire`, { method: 'POST' });
    return amJson(res);
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** POST /api/account-manager/resign */
export async function postAccountManagerResign(contractId?: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/account-manager/resign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contractId != null ? { contractId } : {})
    });
    return amJson(res);
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** POST /api/account-manager/enter */
export async function postAccountManagerEnter(ownerUserId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/account-manager/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerUserId })
    });
    return amJson(res);
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** POST /api/account-manager/leave */
export async function postAccountManagerLeave(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/account-manager/leave`, { method: 'POST' });
    return amJson(res);
  } catch {
    return { ok: false, error: 'Network error' };
  }
}
