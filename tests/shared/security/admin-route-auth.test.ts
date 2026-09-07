import { describe, expect, it } from 'vitest';
import {
  adminTabAllows,
  allowsAdminRouteAccess,
  permissionTabSetFromDbJson,
  resolveAdminRouteRequirement
} from '../../../server/shared/security/admin-route-auth.js';

describe('permissionTabSetFromDbJson', () => {
  it('null/vazio devolve conjunto vazio', () => {
    expect(permissionTabSetFromDbJson(null).size).toBe(0);
    expect(permissionTabSetFromDbJson('').size).toBe(0);
    expect(permissionTabSetFromDbJson('   ').size).toBe(0);
  });

  it('JSON string inválido devolve conjunto vazio (não lança)', () => {
    expect(permissionTabSetFromDbJson('{not json')).toEqual(new Set());
  });

  it('array de strings', () => {
    expect(permissionTabSetFromDbJson(['users', 'reports', '  '])).toEqual(new Set(['users', 'reports']));
  });

  it('objeto com valores true/1 vira chave incluída, outros excluídos', () => {
    expect(permissionTabSetFromDbJson({ users: true, reports: 1, games: false, backup: 0 })).toEqual(new Set(['users', 'reports']));
  });

  it('string JSON de array é parseada', () => {
    expect(permissionTabSetFromDbJson('["users","games"]')).toEqual(new Set(['users', 'games']));
  });
});

describe('adminTabAllows', () => {
  it('permissão exata', () => {
    expect(adminTabAllows(new Set(['users']), 'users')).toBe(true);
  });

  it('aba-pai cobre sub-permissão pedida (shops cobre shops:hardware)', () => {
    expect(adminTabAllows(new Set(['shops']), 'shops:hardware')).toBe(true);
  });

  it('sub-permissão específica não cobre a aba-pai pedida', () => {
    expect(adminTabAllows(new Set(['shops:hardware']), 'shops')).toBe(true); // shops:hardware startsWith 'shops:'
  });

  it('sem relação: nega', () => {
    expect(adminTabAllows(new Set(['games']), 'users')).toBe(false);
  });
});

describe('allowsAdminRouteAccess', () => {
  it('super-admin sempre passa, mesmo em rota super', () => {
    expect(allowsAdminRouteAccess(true, new Set(), { kind: 'super' })).toBe(true);
  });

  it('não-super em rota super: negado', () => {
    expect(allowsAdminRouteAccess(false, new Set(['users']), { kind: 'super' })).toBe(false);
  });

  it('rota anyOf: basta uma das abas', () => {
    expect(allowsAdminRouteAccess(false, new Set(['settings:news']), { kind: 'anyOf', tabs: ['partners', 'settings:news'] })).toBe(true);
  });

  it('rota tab: precisa da aba certa', () => {
    expect(allowsAdminRouteAccess(false, new Set(['users']), { kind: 'tab', tab: 'reports' })).toBe(false);
  });
});

describe('resolveAdminRouteRequirement', () => {
  it('rotas de máximo risco são sempre super', () => {
    expect(resolveAdminRouteRequirement('POST', '/api/admin/restore')).toEqual({ kind: 'super' });
    expect(resolveAdminRouteRequirement('POST', '/api/admin/bulk-delete')).toEqual({ kind: 'super' });
    expect(resolveAdminRouteRequirement('POST', '/api/admin/update-permissions')).toEqual({ kind: 'super' });
  });

  it('POST /api/web3-settings é super; GET público não passa por este mapa no controller', () => {
    expect(resolveAdminRouteRequirement('POST', '/api/web3-settings')).toEqual({ kind: 'super' });
    expect(allowsAdminRouteAccess(false, new Set(['web3']), { kind: 'super' })).toBe(false);
    expect(allowsAdminRouteAccess(true, new Set(), { kind: 'super' })).toBe(true);
  });

  it('GET/POST /api/admin/withdrawals* exigem super (não tab)', () => {
    expect(resolveAdminRouteRequirement('GET', '/api/admin/withdrawals')).toEqual({ kind: 'super' });
    expect(resolveAdminRouteRequirement('POST', '/api/admin/withdrawals/status')).toEqual({ kind: 'super' });
    expect(allowsAdminRouteAccess(false, new Set(['users', 'reports', 'web3']), { kind: 'super' })).toBe(false);
    expect(allowsAdminRouteAccess(true, new Set(), { kind: 'super' })).toBe(true);
  });

  it('POST coin-balance admin é tab users (não super)', () => {
    expect(resolveAdminRouteRequirement('POST', '/api/admin/update-coin-balance')).toEqual({ kind: 'tab', tab: 'users' });
    expect(resolveAdminRouteRequirement('POST', '/api/admin/bulk-update-coin-balance')).toEqual({
      kind: 'tab',
      tab: 'users'
    });
    expect(allowsAdminRouteAccess(false, new Set(['users']), { kind: 'tab', tab: 'users' })).toBe(true);
    expect(allowsAdminRouteAccess(false, new Set(['reports']), { kind: 'tab', tab: 'users' })).toBe(false);
    expect(allowsAdminRouteAccess(true, new Set(), { kind: 'tab', tab: 'users' })).toBe(true);
  });

  it('POST /api/economy-settings é tab reports; POST /api/admin/economy-settings é super', () => {
    expect(resolveAdminRouteRequirement('POST', '/api/economy-settings')).toEqual({ kind: 'tab', tab: 'reports' });
    expect(resolveAdminRouteRequirement('POST', '/api/admin/economy-settings')).toEqual({ kind: 'super' });
    expect(allowsAdminRouteAccess(false, new Set(['reports']), { kind: 'tab', tab: 'reports' })).toBe(true);
    expect(allowsAdminRouteAccess(false, new Set(['users']), { kind: 'tab', tab: 'reports' })).toBe(false);
    expect(allowsAdminRouteAccess(true, new Set(), { kind: 'tab', tab: 'reports' })).toBe(true);
  });

  it('POST /api/exchange-settings é super (GET público não usa este mapa no controller)', () => {
    expect(resolveAdminRouteRequirement('POST', '/api/exchange-settings')).toEqual({ kind: 'super' });
    expect(allowsAdminRouteAccess(false, new Set(['reports', 'users', 'web3']), { kind: 'super' })).toBe(false);
    expect(allowsAdminRouteAccess(true, new Set(), { kind: 'super' })).toBe(true);
  });

  it('GET/POST/DELETE /api/admin/security/* é tab security', () => {
    expect(resolveAdminRouteRequirement('GET', '/api/admin/security/stats')).toEqual({ kind: 'tab', tab: 'security' });
    expect(resolveAdminRouteRequirement('POST', '/api/admin/security/blacklist')).toEqual({ kind: 'tab', tab: 'security' });
    expect(resolveAdminRouteRequirement('DELETE', '/api/admin/security/blacklist/1.2.3.4')).toEqual({
      kind: 'tab',
      tab: 'security'
    });
    expect(allowsAdminRouteAccess(false, new Set(['security']), { kind: 'tab', tab: 'security' })).toBe(true);
    expect(allowsAdminRouteAccess(false, new Set(['users']), { kind: 'tab', tab: 'security' })).toBe(false);
  });

  it('GET /api/admin/{economy-stats,mining-runtime-summary} são 100% Rust → unmapped → super', () => {
    expect(resolveAdminRouteRequirement('GET', '/api/admin/economy-stats')).toEqual({ kind: 'super' });
    expect(resolveAdminRouteRequirement('GET', '/api/admin/mining-runtime-summary')).toEqual({ kind: 'super' });
    expect(allowsAdminRouteAccess(false, new Set(['reports']), { kind: 'tab', tab: 'reports' })).toBe(true);
    expect(allowsAdminRouteAccess(false, new Set(['users']), { kind: 'tab', tab: 'reports' })).toBe(false);
    expect(allowsAdminRouteAccess(true, new Set(), { kind: 'tab', tab: 'reports' })).toBe(true);
  });

  it('POST /api/monetization-settings é tab settings:monetization; bulk-delete promo é super', () => {
    // GET /api/admin/monetization-settings is 100% Rust now → unmapped → super.
    expect(resolveAdminRouteRequirement('GET', '/api/admin/monetization-settings')).toEqual({ kind: 'super' });
    expect(resolveAdminRouteRequirement('POST', '/api/monetization-settings')).toEqual({
      kind: 'tab',
      tab: 'settings:monetization'
    });
    expect(resolveAdminRouteRequirement('GET', '/api/admin/promo-codes')).toEqual({
      kind: 'anyOf',
      tabs: ['settings:monetization', 'lootboxes']
    });
    expect(resolveAdminRouteRequirement('POST', '/api/admin/promo-codes/bulk-delete')).toEqual({ kind: 'super' });
    expect(
      allowsAdminRouteAccess(false, new Set(['lootboxes']), {
        kind: 'anyOf',
        tabs: ['settings:monetization', 'lootboxes']
      })
    ).toBe(true);
    expect(allowsAdminRouteAccess(false, new Set(['settings:monetization']), { kind: 'tab', tab: 'settings:monetization' })).toBe(
      true
    );
    expect(allowsAdminRouteAccess(false, new Set(['settings:monetization']), { kind: 'super' })).toBe(false);
  });

  it('POST/PUT/DELETE /api/admin/transparency* são tab transparency', () => {
    expect(resolveAdminRouteRequirement('POST', '/api/admin/transparency')).toEqual({
      kind: 'tab',
      tab: 'transparency'
    });
    expect(resolveAdminRouteRequirement('PUT', '/api/admin/transparency/12')).toEqual({
      kind: 'tab',
      tab: 'transparency'
    });
    expect(resolveAdminRouteRequirement('DELETE', '/api/admin/transparency/12')).toEqual({
      kind: 'tab',
      tab: 'transparency'
    });
    expect(allowsAdminRouteAccess(false, new Set(['transparency']), { kind: 'tab', tab: 'transparency' })).toBe(true);
    expect(allowsAdminRouteAccess(false, new Set(['reports']), { kind: 'tab', tab: 'transparency' })).toBe(false);
  });

  it('GET /api/wallet-labels é tab reports; POST é super', () => {
    expect(resolveAdminRouteRequirement('GET', '/api/wallet-labels')).toEqual({ kind: 'tab', tab: 'reports' });
    expect(resolveAdminRouteRequirement('POST', '/api/wallet-labels')).toEqual({ kind: 'super' });
    expect(allowsAdminRouteAccess(false, new Set(['reports']), { kind: 'tab', tab: 'reports' })).toBe(true);
    expect(allowsAdminRouteAccess(false, new Set(['reports']), { kind: 'super' })).toBe(false);
    expect(allowsAdminRouteAccess(true, new Set(), { kind: 'super' })).toBe(true);
  });

  it('GET /api/admin/etherscan/* é 100% Rust → unmapped → super', () => {
    expect(resolveAdminRouteRequirement('GET', '/api/admin/etherscan/treasury-token-txs')).toEqual({ kind: 'super' });
  });

  it('GET /api/admin/recall-scan é tab backup; POST recall-all é super', () => {
    expect(resolveAdminRouteRequirement('GET', '/api/admin/recall-scan')).toEqual({ kind: 'tab', tab: 'backup' });
    expect(resolveAdminRouteRequirement('POST', '/api/admin/recall-all-players-items')).toEqual({ kind: 'super' });
    expect(allowsAdminRouteAccess(true, new Set(), { kind: 'super' })).toBe(true);
    expect(allowsAdminRouteAccess(false, new Set(['backup', 'users']), { kind: 'super' })).toBe(false);
  });

  it('rotas 100% migradas para Rust não têm regra aqui (caem no catch-all super)', () => {
    // Partners/Streamer, Support, lucky/loot-box admin e market/listings são
    // servidos e autorizados pelo genesis-api (Rust); os handlers Express foram
    // removidos. Sem regra → `super` (nega por omissão).
    expect(resolveAdminRouteRequirement('GET', '/api/admin/market/listings')).toEqual({ kind: 'super' });
    expect(resolveAdminRouteRequirement('GET', '/api/admin/partner-youtube-partners')).toEqual({ kind: 'super' });
    expect(resolveAdminRouteRequirement('GET', '/api/admin/partner-videos')).toEqual({ kind: 'super' });
    expect(resolveAdminRouteRequirement('GET', '/api/admin/streamer-room-users')).toEqual({ kind: 'super' });
    expect(resolveAdminRouteRequirement('GET', '/api/admin/support-tickets')).toEqual({ kind: 'super' });
    expect(resolveAdminRouteRequirement('POST', '/api/admin/loot-boxes')).toEqual({ kind: 'super' });
    expect(resolveAdminRouteRequirement('GET', '/api/admin/user-boxes')).toEqual({ kind: 'super' });
  });

    it('PUT /api/user é tab users, não super', () => {
      expect(resolveAdminRouteRequirement('PUT', '/api/user')).toEqual({ kind: 'tab', tab: 'users' });
      expect(allowsAdminRouteAccess(false, new Set(['users']), { kind: 'tab', tab: 'users' })).toBe(true);
      expect(allowsAdminRouteAccess(false, new Set(['reports']), { kind: 'tab', tab: 'users' })).toBe(false);
      expect(allowsAdminRouteAccess(true, new Set(), { kind: 'tab', tab: 'users' })).toBe(true);
    });

    it('DELETE /api/user/:email é tab users, não super', () => {
      expect(resolveAdminRouteRequirement('DELETE', '/api/user/a@b.com')).toEqual({ kind: 'tab', tab: 'users' });
      expect(allowsAdminRouteAccess(false, new Set(['users']), { kind: 'tab', tab: 'users' })).toBe(true);
      expect(allowsAdminRouteAccess(false, new Set(['reports']), { kind: 'tab', tab: 'users' })).toBe(false);
      expect(allowsAdminRouteAccess(true, new Set(), { kind: 'tab', tab: 'users' })).toBe(true);
    });

    it('GET /api/admin/users/:userId/wallet-history é tab users, não super', () => {
      expect(resolveAdminRouteRequirement('GET', '/api/admin/users/42/wallet-history')).toEqual({
        kind: 'tab',
        tab: 'users'
      });
      expect(allowsAdminRouteAccess(false, new Set(['users']), { kind: 'tab', tab: 'users' })).toBe(true);
      expect(allowsAdminRouteAccess(false, new Set(['reports']), { kind: 'tab', tab: 'users' })).toBe(false);
      expect(allowsAdminRouteAccess(true, new Set(), { kind: 'tab', tab: 'users' })).toBe(true);
    });

  it('impersonate é tab users, não super', () => {
    expect(resolveAdminRouteRequirement('POST', '/api/admin/impersonate')).toEqual({ kind: 'tab', tab: 'users' });
  });

  it('device-fingerprints é tab security', () => {
    expect(resolveAdminRouteRequirement('GET', '/api/admin/device-fingerprints')).toEqual({ kind: 'tab', tab: 'security' });
  });

  it('upload-ad aceita partners OU settings:news', () => {
    expect(resolveAdminRouteRequirement('POST', '/api/admin/upload-ad')).toEqual({ kind: 'anyOf', tabs: ['partners', 'settings:news'] });
  });

  it('dashboard / wheel admin routes are 100% Rust → unmapped → super', () => {
    for (const path of [
      '/api/admin/wheel/config',
      '/api/admin/dashboard-stats',
      '/api/admin/metrics',
      '/api/admin/ranking-exclusion',
      '/api/admin/users/map'
    ]) {
      expect(resolveAdminRouteRequirement('GET', path)).toEqual({ kind: 'super' });
    }
  });

  it('ignora query string ao resolver o path', () => {
    expect(resolveAdminRouteRequirement('GET', '/api/admin/device-fingerprints?limit=10')).toEqual({ kind: 'tab', tab: 'security' });
  });

  it('rotas /api/admin/users/:id/*-audit exigem GET + regex exata', () => {
    expect(resolveAdminRouteRequirement('GET', '/api/admin/users/42/inventory-audit')).toEqual({ kind: 'tab', tab: 'users' });
    expect(resolveAdminRouteRequirement('POST', '/api/admin/users/42/inventory-audit')).toEqual({ kind: 'super' });
  });

  it('save-game-override exige POST + regex exata', () => {
    expect(resolveAdminRouteRequirement('POST', '/api/admin/users/42/save-game-override')).toEqual({ kind: 'tab', tab: 'users' });
    expect(resolveAdminRouteRequirement('GET', '/api/admin/users/42/save-game-override')).toEqual({ kind: 'super' });
  });

  it('PUT /api/admin/users/:id/rooms é tab users, não super', () => {
    expect(resolveAdminRouteRequirement('PUT', '/api/admin/users/42/rooms')).toEqual({
      kind: 'tab',
      tab: 'users'
    });
    expect(resolveAdminRouteRequirement('GET', '/api/admin/users/42/rooms')).toEqual({ kind: 'super' });
    expect(allowsAdminRouteAccess(false, new Set(['users']), { kind: 'tab', tab: 'users' })).toBe(true);
    expect(allowsAdminRouteAccess(false, new Set(['reports']), { kind: 'tab', tab: 'users' })).toBe(false);
  });

  it('GET /api/game-state/:email (não-me) → aba users; /me não é tab users', () => {
    expect(resolveAdminRouteRequirement('GET', '/api/game-state/player@x.com')).toEqual({
      kind: 'tab',
      tab: 'users'
    });
    expect(resolveAdminRouteRequirement('GET', '/api/game-state/me')).toEqual({ kind: 'super' });
  });

  it('rota admin desconhecida cai no catch-all super', () => {
    expect(resolveAdminRouteRequirement('GET', '/api/admin/nunca-visto')).toEqual({ kind: 'super' });
  });

  it('rota totalmente fora do namespace admin também cai em super (default)', () => {
    expect(resolveAdminRouteRequirement('GET', '/api/nao-mapeada')).toEqual({ kind: 'super' });
  });
});
