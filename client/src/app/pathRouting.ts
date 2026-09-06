/**
 * URL path helpers for public / auth / admin / in-game views.
 * Game tabs use `/{view}` (e.g. `/servers`, `/checkin`). Partner play: `/partner_games/:slug`.
 */
import { VALID_GAME_VIEWS, type GameView } from '../features/game/nav/buildGameNavItems';

export type AuthMode = 'login' | 'register' | 'recovery';

export type AppShellView =
  | 'home'
  | 'auth'
  | 'game'
  | 'admin'
  | 'docs'
  | 'roadmap'
  | 'terms'
  | 'privacy'
  | 'cookies'
  | 'aml'
  | 'web3_risk'
  | 'refunds'
  | 'community'
  | 'public_support';

export const ADMIN_AFTER_STOP_IMPERSONATE_PATH = '/admin/dashboard';

const PUBLIC_PATHS: Record<string, Exclude<AppShellView, 'home' | 'auth' | 'game' | 'admin'>> = {
  docs: 'docs',
  roadmap: 'roadmap',
  terms: 'terms',
  privacy: 'privacy',
  cookies: 'cookies',
  aml: 'aml',
  web3_risk: 'web3_risk',
  refunds: 'refunds',
  community: 'community',
  support: 'public_support'
};

export function pushPath(path: string): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
}

export function replacePath(path: string): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === path) return;
  window.history.replaceState({}, '', path);
}

/**
 * Forma canónica para classificar: sem query/hash, sem barra final, minúsculas.
 * Links de e-mail chegam como `/redefinir-senha?token=…`; slugs de parceiro
 * continuam a sair de `partnerGameSlugFromPath` (case-sensitive).
 */
export function normalizePathname(pathname: string): string {
  const path = pathname.split('#')[0]!.split('?')[0]!.replace(/\/+$/, '').toLowerCase();
  return path || '/';
}

export function pathForGameView(view: GameView): string {
  return `/${view}`;
}

export function gameViewFromPath(pathname: string): GameView | null {
  const seg = normalizePathname(pathname).split('/').filter(Boolean)[0];
  if (!seg) return null;
  if ((VALID_GAME_VIEWS as readonly string[]).includes(seg)) return seg as GameView;
  return null;
}

export function pathForPartnerGamePlayer(slug: string): string {
  return `/partner_games/${encodeURIComponent(slug.trim())}`;
}

export function partnerGameSlugFromPath(pathname: string): string | null {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'partner_games' || !parts[1]) return null;
  try {
    return decodeURIComponent(parts[1]);
  } catch {
    return parts[1];
  }
}

export function pathForAuthMode(mode: AuthMode): string {
  // Mesmo path do `shared/auth/navigate.ts`; `/register` continua alias na leitura.
  if (mode === 'register') return '/registro';
  // Alinhado com o link do e-mail (`/redefinir-senha`); `/recovery` continua alias.
  if (mode === 'recovery') return '/redefinir-senha';
  return '/login';
}

export function pathForPublicView(view: string): string | null {
  if (view === 'home') return '/';
  if (view === 'public_support') return '/support';
  if (view in PUBLIC_PATHS) return `/${view}`;
  return null;
}

export function adminPathFromLocation(pathname: string): string {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts[0] === 'admin' && parts.length > 1) return pathname.startsWith('/') ? pathname : `/${pathname}`;
  return '/admin/dashboard';
}

export type ClassifyLocation =
  | { kind: 'home' }
  | { kind: 'auth'; mode: AuthMode }
  | { kind: 'public'; view: Exclude<AppShellView, 'home' | 'auth' | 'game' | 'admin'> }
  | { kind: 'game' }
  | { kind: 'admin' }
  | { kind: 'unknown' };

function authModeFromPathHead(head: string): AuthMode | null {
  const h = head.toLowerCase();
  if (h === 'login') return 'login';
  if (h === 'register' || h === 'registro') return 'register';
  if (h === 'recovery' || h === 'redefinir-senha' || h === 'reset-password') return 'recovery';
  // Verificação de e-mail usa o mesmo shell de auth (PasswordResetPage / verify).
  if (h === 'verificar-email' || h === 'verify-email') return 'recovery';
  return null;
}

export function classifyLocation(pathname: string): ClassifyLocation {
  const parts = normalizePathname(pathname).split('/').filter(Boolean);
  if (parts.length === 0) return { kind: 'home' };
  const head = parts[0];
  const authMode = authModeFromPathHead(head);
  if (authMode) return { kind: 'auth', mode: authMode };
  if (head === 'admin') return { kind: 'admin' };
  if (head in PUBLIC_PATHS) return { kind: 'public', view: PUBLIC_PATHS[head] };
  if (partnerGameSlugFromPath(pathname) || gameViewFromPath(pathname)) return { kind: 'game' };
  return { kind: 'unknown' };
}

export type SessionBootDecision =
  | { action: 'auth'; mode: AuthMode; replacePath?: string }
  | { action: 'public'; view: Exclude<AppShellView, 'home' | 'auth' | 'game' | 'admin'> }
  | { action: 'game'; replacePath?: string }
  | { action: 'admin'; replacePath: string }
  | { action: 'home'; replacePath?: string };

export function resolveSessionBoot(
  pathname: string,
  sess: { isAdmin: boolean } | null
): SessionBootDecision {
  const loc = classifyLocation(pathname);
  if (!sess) {
    if (loc.kind === 'auth') return { action: 'auth', mode: loc.mode };
    if (loc.kind === 'public') return { action: 'public', view: loc.view };
    if (loc.kind === 'home') return { action: 'home' };
    if (loc.kind === 'game' || loc.kind === 'admin') {
      return { action: 'auth', mode: 'login', replacePath: pathForAuthMode('login') };
    }
    return { action: 'home', replacePath: '/' };
  }
  if (sess.isAdmin && loc.kind === 'admin') {
    return { action: 'admin', replacePath: adminPathFromLocation(pathname) };
  }
  if (loc.kind === 'public') return { action: 'public', view: loc.view };
  if (loc.kind === 'auth' && (loc.mode === 'recovery' || loc.mode === 'register')) {
    return { action: 'auth', mode: loc.mode };
  }
  if (loc.kind === 'game') return { action: 'game' };
  if (loc.kind === 'home') return { action: 'game', replacePath: pathForGameView('servers') };
  return { action: 'game', replacePath: pathForGameView('servers') };
}
