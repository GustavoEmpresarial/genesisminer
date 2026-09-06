export type AuthMode = 'login' | 'register' | 'recovery';

export const AUTH_MODE_EVENT = 'genesis-auth-mode';

export function pathForAuthMode(mode: AuthMode): string {
  if (mode === 'register') return '/registro';
  if (mode === 'recovery') return '/redefinir-senha';
  return '/login';
}

export function navigateAuthMode(mode: AuthMode): void {
  const path = pathForAuthMode(mode);
  try {
    window.history.replaceState({}, '', path);
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent(AUTH_MODE_EVENT, { detail: { mode } }));
  } catch {
    /* ignore */
  }
}
