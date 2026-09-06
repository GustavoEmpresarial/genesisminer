/**
 * Sincronização path ↔ página (camada pura de `app/pathRouting`).
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_AFTER_STOP_IMPERSONATE_PATH,
  adminPathFromLocation,
  classifyLocation,
  gameViewFromPath,
  normalizePathname,
  partnerGameSlugFromPath,
  pathForAuthMode,
  pathForGameView,
  pathForPartnerGamePlayer,
  pathForPublicView,
  resolveSessionBoot
} from '../../../client/src/app/pathRouting.js';

describe('pathRouting — página → URL', () => {
  it('mapeia GameView para path', () => {
    expect(pathForGameView('servers')).toBe('/servers');
    expect(pathForGameView('wallet')).toBe('/wallet');
    expect(pathForGameView('black_market')).toBe('/black_market');
    expect(pathForGameView('hardware_store')).toBe('/hardware_store');
    expect(pathForGameView('deposit_history')).toBe('/deposit_history');
  });

  it('mapeia páginas públicas', () => {
    expect(pathForPublicView('docs')).toBe('/docs');
    expect(pathForPublicView('web3_risk')).toBe('/web3_risk');
    expect(pathForPublicView('home')).toBe('/');
    expect(pathForPublicView('public_support')).toBe('/support');
    expect(pathForPublicView('auth')).toBeNull();
  });

  it('mapeia auth modes', () => {
    expect(pathForAuthMode('login')).toBe('/login');
    expect(pathForAuthMode('register')).toBe('/registro');
    expect(pathForAuthMode('recovery')).toBe('/redefinir-senha');
  });
});

describe('pathRouting — URL → página', () => {
  it('resolve game views a partir do pathname', () => {
    expect(gameViewFromPath('/wallet')).toBe('wallet');
    expect(gameViewFromPath('/black_market')).toBe('black_market');
    expect(gameViewFromPath('/BLACK_MARKET/')).toBe('black_market');
    expect(gameViewFromPath('/servers')).toBe('servers');
    expect(gameViewFromPath('/docs')).toBeNull();
  });

  it('resolve páginas públicas', () => {
    expect(classifyLocation('/docs')).toEqual({ kind: 'public', view: 'docs' });
    expect(classifyLocation('/web3_risk')).toEqual({ kind: 'public', view: 'web3_risk' });
    expect(classifyLocation('/support')).toEqual({ kind: 'public', view: 'public_support' });
  });

  it('auth mode só em rotas de auth (`/register` continua alias de `/registro`)', () => {
    expect(classifyLocation('/login')).toEqual({ kind: 'auth', mode: 'login' });
    expect(classifyLocation('/registro')).toEqual({ kind: 'auth', mode: 'register' });
    expect(classifyLocation('/register')).toEqual({ kind: 'auth', mode: 'register' });
    expect(classifyLocation('/wallet')).toEqual({ kind: 'game' });
  });

  it('admin paths', () => {
    expect(classifyLocation('/admin')).toEqual({ kind: 'admin' });
    expect(classifyLocation('/admin/dashboard')).toEqual({ kind: 'admin' });
    expect(adminPathFromLocation('/admin')).toBe('/admin/dashboard');
    expect(adminPathFromLocation('/admin/users')).toBe('/admin/users');
  });
});

describe('pathRouting — classifyLocation (refresh / deep link)', () => {
  it('home', () => {
    expect(classifyLocation('/')).toEqual({ kind: 'home' });
  });

  it('game (sem `view`: o GameShell resolve a aba a partir do path)', () => {
    expect(classifyLocation('/inventory')).toEqual({ kind: 'game' });
  });

  it('partner game player', () => {
    expect(classifyLocation('/partner_games/blockminer')).toEqual({ kind: 'game' });
    expect(partnerGameSlugFromPath('/partner_games/master-legends')).toBe('master-legends');
    expect(pathForPartnerGamePlayer('blockminer')).toBe('/partner_games/blockminer');
  });

  it('admin', () => {
    expect(classifyLocation('/admin/settings')).toEqual({ kind: 'admin' });
  });

  it('unknown → unknown', () => {
    expect(classifyLocation('/nao-existe')).toEqual({ kind: 'unknown' });
    expect(classifyLocation('/foo/bar')).toEqual({ kind: 'unknown' });
  });
});

describe('pathRouting — guards de rota', () => {
  it('rotas privadas = game + admin; públicas/auth ficam de fora', () => {
    expect(classifyLocation('/wallet').kind).toBe('game');
    expect(classifyLocation('/admin/dashboard').kind).toBe('admin');
    expect(classifyLocation('/docs').kind).toBe('public');
    expect(classifyLocation('/login').kind).toBe('auth');
  });

  it('normalizePathname remove query/hash/trailing slash', () => {
    expect(normalizePathname('/Wallet/?x=1#y')).toBe('/wallet');
    expect(normalizePathname('/')).toBe('/');
  });
});

describe('pathRouting — round-trip game views', () => {
  const samples = [
    'servers',
    'wallet',
    'black_market',
    'mini_blog',
    'partner_games',
    'withdrawal_history',
    'profile',
    'dashboard',
    'calculator',
    'merge',
    'management',
    'deposit_history'
  ] as const;

  for (const view of samples) {
    it(`${view} ↔ path`, () => {
      const path = pathForGameView(view);
      expect(gameViewFromPath(path)).toBe(view);
    });
  }
});

describe('pathRouting — auth / admin guards (SessionBoot)', () => {
  it('rota protegida sem auth → login', () => {
    expect(resolveSessionBoot('/wallet', null)).toEqual({
      action: 'auth',
      mode: 'login',
      replacePath: '/login'
    });
    expect(resolveSessionBoot('/admin/dashboard', null)).toEqual({
      action: 'auth',
      mode: 'login',
      replacePath: '/login'
    });
  });

  it('rota admin sem permissão (user normal) → game /servers', () => {
    expect(resolveSessionBoot('/admin/users', { isAdmin: false })).toEqual({
      action: 'game',
      replacePath: '/servers'
    });
  });

  it('admin em path de jogo → game (deep link preservado)', () => {
    expect(resolveSessionBoot('/wallet', { isAdmin: true })).toEqual({ action: 'game' });
  });

  it('após stop impersonate: path admin abre painel; /servers continua game', () => {
    expect(ADMIN_AFTER_STOP_IMPERSONATE_PATH).toBe('/admin/dashboard');
    expect(classifyLocation(ADMIN_AFTER_STOP_IMPERSONATE_PATH)).toEqual({ kind: 'admin' });
    expect(resolveSessionBoot(ADMIN_AFTER_STOP_IMPERSONATE_PATH, { isAdmin: true })).toEqual({
      action: 'admin',
      replacePath: '/admin/dashboard'
    });
    expect(resolveSessionBoot('/servers', { isAdmin: true })).toEqual({ action: 'game' });
  });

  it('admin na home → jogo (painel só em /admin/*)', () => {
    expect(resolveSessionBoot('/', { isAdmin: true })).toEqual({
      action: 'game',
      replacePath: '/servers'
    });
  });

  it('player deep link /inventory → game sem rewrite', () => {
    expect(resolveSessionBoot('/inventory', { isAdmin: false })).toEqual({ action: 'game' });
  });

  it('partner game player deep link → game', () => {
    expect(resolveSessionBoot('/partner_games/blockminer', { isAdmin: false })).toEqual({
      action: 'game'
    });
    expect(resolveSessionBoot('/partner_games/blockminer', null)).toEqual({
      action: 'auth',
      mode: 'login',
      replacePath: '/login'
    });
  });

  it('unknown path sem auth → home', () => {
    expect(resolveSessionBoot('/nao-existe', null)).toEqual({
      action: 'home',
      replacePath: '/'
    });
  });
});

/** Back/Forward: popstate reclassifica pathname (App + GameShell). */
describe('pathRouting — back/forward semantics', () => {
  it('histórico simulado: game → docs → game', () => {
    const stack = ['/servers', '/docs', '/wallet'];
    expect(classifyLocation(stack[0]!)).toEqual({ kind: 'game' });
    expect(classifyLocation(stack[1]!)).toEqual({ kind: 'public', view: 'docs' });
    expect(classifyLocation(stack[2]!)).toEqual({ kind: 'game' });
    // "back" from wallet → docs
    expect(classifyLocation(stack[1]!)).toEqual({ kind: 'public', view: 'docs' });
    // "forward" docs → wallet
    expect(classifyLocation(stack[2]!)).toEqual({ kind: 'game' });
  });
});
