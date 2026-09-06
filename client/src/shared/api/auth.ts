import type { DeviceFingerprintPayload, User } from '../types/auth';
import { apiFetch, setSessionHint } from './http';
import { clearPendingPaidSpin } from './wheel';

const base = '/api';

function withSiteMaintenanceFlag<T extends { siteMaintenance?: boolean }>(user: T): T {
  return { ...user, siteMaintenance: user.siteMaintenance === true };
}

export type LoginOk = { ok: true; user: User };
export type LoginErr = {
  ok: false;
  error: string;
  code?: string;
  emailVerificationRequired?: boolean;
};
export type LoginResult = LoginOk | LoginErr;

export async function login(
  email: string,
  password: string,
  deviceFingerprint?: DeviceFingerprintPayload,
  turnstileToken?: string
): Promise<LoginResult> {
  try {
    const body: Record<string, unknown> = { email, password };
    if (deviceFingerprint) body.deviceFingerprint = deviceFingerprint;
    if (turnstileToken) body.turnstileToken = turnstileToken;
    const res = await apiFetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const rawText = await res.text();
    const data: Record<string, unknown> = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
    if (!res.ok) {
      return {
        ok: false,
        error: (typeof data.error === 'string' ? data.error : null) || 'Unknown error',
        code: typeof data.code === 'string' ? data.code : undefined,
        emailVerificationRequired: data.emailVerificationRequired === true
      };
    }
    setSessionHint(true);
    const user = withSiteMaintenanceFlag(data as unknown as User);
    return { ok: true, user };
  } catch (err: unknown) {
    return {
      ok: false,
      error: 'Network Error: ' + (err instanceof Error ? err.message : String(err))
    };
  }
}

/** Cadastro público — `POST /api/register` (o backend não expõe mais `PUT /api/user` para signup). */
export async function registerPublicUser(
  user: User & { newReferralFor?: string; turnstileToken?: string; deviceFingerprint?: DeviceFingerprintPayload }
): Promise<{ ok: boolean; error?: string; code?: string; requiresEmailVerification?: boolean; message?: string }> {
  try {
    const res = await apiFetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(user)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: (data as { error?: string }).error || `Error ${res.status}`,
        code: (data as { code?: string }).code
      };
    }
    const payload = (typeof data === 'object' && data ? data : {}) as {
      ok?: boolean;
      error?: string;
      code?: string;
      requiresEmailVerification?: boolean;
      emailVerificationRequired?: boolean;
      message?: string;
    };
    return {
      ok: true,
      ...payload,
      requiresEmailVerification: payload.requiresEmailVerification ?? payload.emailVerificationRequired
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** Edição admin/legado — `PUT /api/user` (ainda não migrado no backend). */
export async function updateUser(
  user: User & { newReferralFor?: string; turnstileToken?: string; deviceFingerprint?: DeviceFingerprintPayload }
): Promise<{ ok: boolean; error?: string; code?: string; requiresEmailVerification?: boolean; message?: string }> {
  try {
    const res = await apiFetch(`${base}/user`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(user)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: (data as { error?: string }).error || `Error ${res.status}`,
        code: (data as { code?: string }).code
      };
    }
    return { ok: true, ...(typeof data === 'object' && data ? data : {}) } as {
      ok: boolean;
      error?: string;
      code?: string;
      requiresEmailVerification?: boolean;
      message?: string;
    };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function requestEmailVerification(email: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const res = await apiFetch(`${base}/request-email-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() })
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: !!data.ok, message: data.message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
  }
}

export async function verifyEmailToken(
  token: string
): Promise<{ ok: boolean; message?: string; error?: string; alreadyVerified?: boolean }> {
  try {
    const res = await apiFetch(`${base}/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      error?: string;
      alreadyVerified?: boolean;
    };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return {
      ok: !!data.ok,
      message: data.message,
      alreadyVerified: data.alreadyVerified,
      error: data.error
    };
  } catch {
    return { ok: false, error: 'Network Error' };
  }
}

export async function requestPasswordReset(email: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const res = await apiFetch(`${base}/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() })
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: !!data.ok, message: data.message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
  }
}

export async function resetPasswordSecure(
  resetToken: string,
  newPassword: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/reset-password-secure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetToken, newPassword })
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: !!data.ok, error: data.error };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

export async function getSession(): Promise<User | null> {
  try {
    const res = await apiFetch(`${base}/session`);
    if (!res.ok) {
      if (res.status === 401 || res.status === 404) setSessionHint(false);
      return null;
    }
    setSessionHint(true);
    try {
      return withSiteMaintenanceFlag((await res.json()) as User);
    } catch {
      return null;
    }
  } catch {
    // Transient network (server rebuild mid-flight) — keep hint, do not force logout.
    return null;
  }
}

export async function logout(): Promise<void> {
  setSessionHint(false);
  // A chave de giro pago pendente é da sessão, não da aba: sem isto ficaria a aguardar
  // reutilização por quem entrasse a seguir no mesmo separador.
  clearPendingPaidSpin();
  await apiFetch(`${base}/logout`, { method: 'POST' }, false);
}
