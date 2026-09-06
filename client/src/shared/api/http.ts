/**
 * Shared authenticated fetch — single refresh-on-401 + session hint (DECISIONS #93).
 * Auth failure after failed refresh → one `AUTH_REQUIRED_EVENT` (App handles logout/redirect).
 * Admin/support clients must import from here — do not duplicate refreshInFlight.
 */
const base = '/api';
const SESSION_HINT_KEY = 'genesis_has_session';
export const AUTH_REQUIRED_EVENT = 'genesis:auth-required';
/** sessionStorage flash code consumed by AuthPage → login banner. */
export const AUTH_FLASH_KEY = 'genesis_auth_flash';
export const AUTH_FLASH_SESSION_EXPIRED = 'session_expired';

let refreshInFlight: Promise<boolean> | null = null;
/** First confirmed auth failure owns cleanup/redirect; later 401s no-op. */
let authFailureInProgress = false;

export function getSessionHint(): boolean {
  try {
    return window.localStorage.getItem(SESSION_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSessionHint(enabled: boolean): void {
  try {
    if (enabled) {
      window.localStorage.setItem(SESSION_HINT_KEY, '1');
      authFailureInProgress = false;
    } else {
      window.localStorage.removeItem(SESSION_HINT_KEY);
    }
  } catch {
    /* ignore */
  }
}

/** True while a session-expired logout/redirect is in flight (callers should skip error UX). */
export function isAuthFailureHandling(): boolean {
  return authFailureInProgress;
}

/** @internal vitest */
export function resetAuthFailureHandlingForTests(): void {
  authFailureInProgress = false;
  refreshInFlight = null;
}

function stashSessionExpiredFlash(): void {
  try {
    window.sessionStorage.setItem(AUTH_FLASH_KEY, AUTH_FLASH_SESSION_EXPIRED);
  } catch {
    /* ignore */
  }
}

/**
 * Consume one-shot flash for the login screen.
 * Returns the flash code (caller translates) or null.
 */
export function consumeAuthFlashCode(): string | null {
  try {
    const code = window.sessionStorage.getItem(AUTH_FLASH_KEY);
    if (!code) return null;
    window.sessionStorage.removeItem(AUTH_FLASH_KEY);
    return code;
  } catch {
    return null;
  }
}

/**
 * Notify App once that the session is dead. Returns true if this call owns the flow.
 */
export function notifyAuthRequired(url: string, status: number): boolean {
  if (typeof window === 'undefined') return false;
  if (shouldSkipAuthRefreshRetry(url)) return false;
  if (authFailureInProgress) return false;
  authFailureInProgress = true;
  stashSessionExpiredFlash();
  try {
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT, { detail: { url, status } }));
  } catch {
    /* ignore */
  }
  return true;
}

async function tryRefreshSessionOnce(): Promise<boolean> {
  if (!getSessionHint()) return false;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${base}/auth/refresh`, { method: 'POST', credentials: 'include' });
      if (!res.ok) setSessionHint(false);
      return res.ok;
    } catch {
      // Transient network (server rebuild) — keep hint.
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export function shouldSkipAuthRefreshRetry(url: string): boolean {
  const u = url.replace(/^https?:\/\/[^/]+/i, '');
  return (
    u.includes('/auth/refresh') ||
    u.includes('/login') ||
    u.includes('/logout') ||
    u.includes('/register') ||
    u.includes('/password-reset') ||
    u.includes('/request-password-reset') ||
    u.includes('/reset-password') ||
    u.includes('/request-email-verification') ||
    u.includes('/verify-email')
  );
}

export async function apiFetch(
  url: string,
  options: RequestInit = {},
  allowRefreshRetry = true
): Promise<Response> {
  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: { ...(options.headers || {}) }
  });

  if (res.status !== 401 || shouldSkipAuthRefreshRetry(url)) {
    return res;
  }

  // Only treat as session death if the client believed it was logged in.
  const hadSessionHint = getSessionHint();

  if (allowRefreshRetry && hadSessionHint) {
    const refreshed = await tryRefreshSessionOnce();
    if (refreshed) {
      return fetch(url, {
        ...options,
        credentials: 'include',
        headers: { ...(options.headers || {}) }
      });
    }
  }

  setSessionHint(false);
  if (hadSessionHint) {
    notifyAuthRequired(url, res.status);
  }
  return res;
}
