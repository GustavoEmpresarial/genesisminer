import type { AuthMode } from '../../../shared/auth';

export type AuthScreen = AuthMode | 'verify';

export type AuthLocationState = {
  screen: AuthScreen;
  recoveryToken: string | null;
  verifyToken: string | null;
};

function decodeTokenSegment(raw: string): string {
  let token = raw;
  try {
    token = decodeURIComponent(raw);
  } catch {
    /* keep */
  }
  return token;
}

/**
 * Token no path (`/redefinir-senha/<token>`) ou na query (`?token=`).
 * Se o base64 do token tiver `/` e o servidor tiver descodificado `%2F`,
 * juntamos todos os segmentos após o prefixo.
 */
function tokenFromAuthPath(pathname: string, prefixes: string[]): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const head = parts[0]!.toLowerCase();
  if (!prefixes.some((p) => head === p.toLowerCase())) return null;
  const joined = parts.slice(1).join('/');
  return joined ? decodeTokenSegment(joined) : null;
}

/** Resolve ecrã auth a partir do pathname/query (+ initialMode do App). */
export function screenFromLocation(initialMode: AuthMode): AuthLocationState {
  const params = new URLSearchParams(window.location.search);
  const pathname = window.location.pathname || '';
  const path = pathname.toLowerCase();
  const queryToken = params.get('token');

  const verifyPathToken = tokenFromAuthPath(pathname, ['verificar-email', 'verify-email']);
  const resetPathToken = tokenFromAuthPath(pathname, ['redefinir-senha', 'reset-password']);

  if (verifyPathToken || (queryToken && path.includes('verificar-email'))) {
    const verifyToken = verifyPathToken || decodeTokenSegment(queryToken!);
    if (verifyPathToken) {
      try {
        window.history.replaceState({}, '', '/verificar-email');
      } catch {
        /* ignore */
      }
    }
    return { screen: 'verify', recoveryToken: null, verifyToken };
  }

  if (resetPathToken || (queryToken && (path.includes('redefinir-senha') || path.includes('reset-password')))) {
    const recoveryToken = resetPathToken || decodeTokenSegment(queryToken!);
    if (resetPathToken) {
      try {
        // Mantém query se existir; só tira o token do path (evita URL gigante / leaks em referrer).
        const q = window.location.search || '';
        window.history.replaceState({}, '', `/redefinir-senha${q}`);
      } catch {
        /* ignore */
      }
    }
    return { screen: 'recovery', recoveryToken, verifyToken: null };
  }

  if (path.includes('verificar-email')) {
    return { screen: 'verify', recoveryToken: null, verifyToken: queryToken ? decodeTokenSegment(queryToken) : null };
  }

  if (path.includes('redefinir-senha') || path.includes('reset-password') || path.includes('/recovery') || initialMode === 'recovery') {
    return {
      screen: 'recovery',
      recoveryToken: queryToken ? decodeTokenSegment(queryToken) : null,
      verifyToken: null
    };
  }

  if (
    params.get('ref') ||
    path.includes('/registro') ||
    path.includes('/register') ||
    params.get('auth') === 'register' ||
    initialMode === 'register'
  ) {
    return { screen: 'register', recoveryToken: null, verifyToken: null };
  }

  if (path.includes('/login') || initialMode === 'login') {
    return { screen: 'login', recoveryToken: null, verifyToken: null };
  }

  return { screen: 'login', recoveryToken: null, verifyToken: null };
}
