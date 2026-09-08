/**
 * Mapeamento de rotas admin → aba do painel (ou `super`, acesso restrito ao
 * dono/operador com privilégio total). Isto é a política de autorização
 * granular do painel admin: um operador não-super só acessa uma rota se tem
 * a aba correspondente liberada em `users.admin_permissions`.
 *
 * `isSuperAdmin = true` ignora toda essa lista (ver
 * {@link allowsAdminRouteAccess}) — a lista abaixo só importa pra operadores
 * comuns com permissões granulares.
 *
 * `resolveAdminRouteRequirement` é essencialmente uma tabela de roteamento
 * (method + path → requisito), mantida como sequência de `if`s em vez de
 * mapa/objeto porque a maioria das regras depende de `path.startsWith(...)`
 * ou de checar o `method` — um `Record<string, ...>` de match exato não
 * cobriria isso sem reintroduzir lógica equivalente por cima. A ordem
 * importa: regras mais específicas (path exato + method) vêm antes de
 * prefixos genéricos; o fallback final (`/api/admin/*` não mapeado → `super`)
 * é a postura padrão "nega por omissão" — uma rota admin nova só fica
 * acessível a operador comum se alguém explicitamente adicionar a regra aqui.
 *
 * Migrado de legacy/backend/utils/adminRouteAuth.ts, verbatim.
 */

/** Requisito de acesso resolvido para uma rota: `super` (só dono/operador
 *  com privilégio total), `tab` (uma aba específica), ou `anyOf` (qualquer
 *  uma de várias abas serve, ex.: uma rota usada por dois painéis diferentes). */
export type AdminRouteRequirement = { kind: 'super' } | { kind: 'tab'; tab: string } | { kind: 'anyOf'; tabs: string[] };

/**
 * Constrói o conjunto de abas permitidas a partir do JSON bruto em
 * `users.admin_permissions`. Aceita dois formatos (compat com dados antigos):
 * array de strings (`["users", "reports"]`) ou objeto de flags
 * (`{ users: true, reports: 1 }`, só chaves com valor `true`/`1` entram).
 * Entrada nula/vazia/JSON inválido devolve conjunto vazio (nunca lança).
 */
export function permissionTabSetFromDbJson(raw: unknown): Set<string> {
  const s = new Set<string>();
  if (raw == null) return s;
  let p: unknown = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return s;
    try {
      p = JSON.parse(t);
    } catch {
      return s;
    }
  }
  if (Array.isArray(p)) {
    for (const x of p) {
      if (typeof x === 'string' && x.trim()) s.add(x.trim());
    }
    return s;
  }
  if (typeof p === 'object' && p !== null) {
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (v === true || v === 1) s.add(k);
    }
  }
  return s;
}

/**
 * Utilizador tem acesso à aba `required` se tem a permissão exata, a aba-pai (ex.: shops → shops:hardware),
 * ou qualquer sub-permissão shops:* quando tem só "shops".
 */
export function adminTabAllows(tabs: Set<string>, required: string): boolean {
  if (tabs.has(required)) return true;
  const colon = required.indexOf(':');
  if (colon > 0) {
    const parent = required.slice(0, colon);
    if (tabs.has(parent)) return true;
  }
  if (!required.includes(':')) {
    for (const t of tabs) {
      if (t.startsWith(`${required}:`)) return true;
    }
  }
  return false;
}

/**
 * Decisão final de acesso: `isSuperAdmin` sempre passa; caso contrário,
 * `rule.kind === 'super'` sempre bloqueia (não existe permissão granular
 * equivalente a super), e `'tab'`/`'anyOf'` delegam para {@link adminTabAllows}.
 */
export function allowsAdminRouteAccess(isSuperAdmin: boolean, tabs: Set<string>, rule: AdminRouteRequirement): boolean {
  if (isSuperAdmin) return true;
  if (rule.kind === 'super') return false;
  if (rule.kind === 'tab') return adminTabAllows(tabs, rule.tab);
  return rule.tabs.some((t) => adminTabAllows(tabs, t));
}

/** Resolve o requisito de permissão para um pedido autenticado como admin. */
export function resolveAdminRouteRequirement(method: string, rawPath: string): AdminRouteRequirement {
  const p = String(rawPath || '').split('?')[0];

  if (p === '/api/admin/update-permissions') return { kind: 'super' };
  /** Personificar jogador (Acessar Conta) — alinhado com Gestão de Utilizadores. */
  if (p === '/api/admin/impersonate' && method.toUpperCase() === 'POST') return { kind: 'tab', tab: 'users' };
  if (p === '/api/admin/bulk-delete') return { kind: 'super' };
  if (p === '/api/admin/recall-all-players-items') return { kind: 'super' };
  if (p === '/api/admin/promo-codes/bulk-delete') return { kind: 'super' };

  // /api/admin/wheel/* is 100% Rust (genesis-api admin_wheel.rs, tab games).
  if (p === '/api/admin/reset-daily-boost') return { kind: 'tab', tab: 'games' };
  /** Calculadora / moedas mineradas no painel: só super (operador admin fica só em Transações USDC nos Relatórios). */
  if (p === '/api/mining-coins' && method.toUpperCase() === 'POST') return { kind: 'super' };
  if (p.startsWith('/api/mining/coins') && method.toUpperCase() !== 'GET') return { kind: 'super' };

  // Partners/Streamer YouTube admin, Support admin, Lucky/loot-box admin and the
  // P2P market listing are 100% Rust (genesis-api gates them via its own
  // resolve_admin_route_requirement); their Express handlers are deleted, so no
  // rule is needed here — an unmapped /api/admin/* path falls to the `super`
  // catch-all below.
  if (p === '/api/admin/upload-ad') return { kind: 'anyOf', tabs: ['partners', 'settings:news'] };

  if (p === '/api/admin/device-fingerprints') return { kind: 'tab', tab: 'security' };
  if (p.startsWith('/api/admin/security/')) return { kind: 'tab', tab: 'security' };

  // /api/admin/backup(s)* and /api/admin/restore are 100% Rust
  // (genesis-api admin_backup.rs, tab backup). Express handlers deleted.
  if (p === '/api/admin/recall-scan') return { kind: 'tab', tab: 'backup' };

  if (p.startsWith('/api/admin/transparency')) return { kind: 'tab', tab: 'transparency' };

  if (p === '/api/admin/display-labels') return { kind: 'tab', tab: 'settings:labels' };
  if (p.startsWith('/api/admin/ui-accent')) return { kind: 'tab', tab: 'settings:pages' };

  if (p.startsWith('/api/player-news/')) return { kind: 'tab', tab: 'settings:news' };
  if (p.startsWith('/api/admin/checkin-premium-policy')) return { kind: 'tab', tab: 'settings:monetization' };
  if (p.startsWith('/api/admin/checkin-reward-policy')) return { kind: 'tab', tab: 'settings:monetization' };
  // /api/admin/announcements* and /api/admin/quests are 100% Rust (genesis-api
  // gates them); no rule here — unmapped /api/admin/* falls to `super`.
  if (p === '/api/news' || p.startsWith('/api/news/')) return { kind: 'tab', tab: 'settings:news' };
  if (p === '/api/news-fee' || p === '/api/news-expire-days') return { kind: 'tab', tab: 'settings:news' };

  if (p.startsWith('/api/season-passes') || p === '/api/season-pass/grant') return { kind: 'tab', tab: 'settings:monetization' };
  // /api/admin/monetization-settings (GET) is 100% Rust (genesis-api admin_tabs.rs).
  if (p === '/api/monetization-settings' && method.toUpperCase() === 'POST') return { kind: 'tab', tab: 'settings:monetization' };
  if (p.startsWith('/api/admin/promo-codes')) return { kind: 'anyOf', tabs: ['settings:monetization', 'lootboxes'] };

  if (p === '/api/access-levels' && method.toUpperCase() === 'POST') return { kind: 'tab', tab: 'settings' };
  if (p === '/api/rig-rooms' && method.toUpperCase() === 'POST') return { kind: 'tab', tab: 'settings:rigrooms' };

  if (p === '/api/web3-settings' && method.toUpperCase() === 'POST') return { kind: 'super' };
  if (p === '/api/wallet-labels' && method.toUpperCase() === 'GET') return { kind: 'tab', tab: 'reports' };
  if (p === '/api/wallet-labels' && method.toUpperCase() === 'POST') return { kind: 'super' };
  if (p === '/api/nfts/receive' && method.toUpperCase() === 'POST') return { kind: 'super' };

  if (p === '/api/admin-upgrades' || p.startsWith('/api/admin-upgrades/')) return { kind: 'tab', tab: 'shops:hardware' };
  if (p === '/api/upgrades' && method.toUpperCase() === 'POST') return { kind: 'tab', tab: 'shops:hardware' };

  if (p === '/api/exchange-settings' && method.toUpperCase() === 'POST') return { kind: 'super' };

  if (p === '/api/users' && method.toUpperCase() === 'GET') return { kind: 'tab', tab: 'users' };
  if (p === '/api/user' && method.toUpperCase() === 'PUT') return { kind: 'tab', tab: 'users' };
  if (p === '/api/users/block' && method.toUpperCase() === 'PUT') return { kind: 'tab', tab: 'users' };
  if (p.startsWith('/api/user/') && method.toUpperCase() === 'DELETE') return { kind: 'tab', tab: 'users' };
  if (p.startsWith('/api/admin/referral-models')) return { kind: 'tab', tab: 'users' };
  if (p.startsWith('/api/admin/access-level-referral-assignments')) return { kind: 'tab', tab: 'users' };
  if (p === '/api/admin/bulk-gift') return { kind: 'tab', tab: 'users' };
  if (p.startsWith('/api/admin/user-activity')) return { kind: 'tab', tab: 'users' };
  if (method.toUpperCase() === 'GET' && /^\/api\/admin\/users\/[^/]+\/inventory-audit$/.test(p)) {
    return { kind: 'tab', tab: 'users' };
  }
  if (method.toUpperCase() === 'GET' && /^\/api\/admin\/users\/[^/]+\/session-snapshots$/.test(p)) {
    return { kind: 'tab', tab: 'users' };
  }
  if (method.toUpperCase() === 'GET' && /^\/api\/admin\/users\/[^/]+\/account-trace$/.test(p)) {
    return { kind: 'tab', tab: 'users' };
  }
  if (p === '/api/admin/update-coin-balance' || p === '/api/admin/bulk-update-coin-balance') return { kind: 'tab', tab: 'users' };
  if (p === '/api/admin/ranking') return { kind: 'tab', tab: 'users' };
  if (p === '/api/admin/accounts-dormant-mining') return { kind: 'tab', tab: 'users' };
  /** Gravar estado do jogo a partir da Gestão de Utilizadores — antes caía no catch-all `/api/admin/*` → `super`. */
  if (method.toUpperCase() === 'POST' && /^\/api\/admin\/users\/[^/]+\/save-game-override$/.test(p)) {
    return { kind: 'tab', tab: 'users' };
  }
  if (method.toUpperCase() === 'PUT' && /^\/api\/admin\/users\/[^/]+\/rooms$/.test(p)) {
    return { kind: 'tab', tab: 'users' };
  }
  /** Ler estado de jogo por email (admin); `/api/game-state/me` não passa por este mapa. */
  if (method.toUpperCase() === 'GET' && /^\/api\/game-state\/.+/.test(p) && p !== '/api/game-state/me') {
    return { kind: 'tab', tab: 'users' };
  }
  if (method.toUpperCase() === 'GET' && /^\/api\/admin\/users\/[^/]+\/wallet-history$/.test(p)) {
    return { kind: 'tab', tab: 'users' };
  }
  if (
    method.toUpperCase() === 'GET' &&
    (p === '/api/admin/users/suspicious-emails' || p === '/api/admin/users/suspicious-emails/export.csv')
  ) {
    return { kind: 'tab', tab: 'users' };
  }
  if (method.toUpperCase() === 'POST' && p === '/api/admin/users/suspicious-emails/deactivate-filtered') {
    return { kind: 'tab', tab: 'users' };
  }
  // /api/admin/mining-distribution/* is 100% Rust (genesis-api admin_mining_dist.rs).
  // /api/admin/{economy-stats,mining-runtime-summary} are 100% Rust (genesis-api admin_economy.rs).
  // /api/admin/etherscan/* is 100% Rust (genesis-api admin_treasury.rs → genesis-wallet).
  if (p.startsWith('/api/admin/withdrawals')) return { kind: 'super' };
  // /api/admin/economy-settings + /api/admin/mining-coins/sync-live-prices are
  // 100% Rust (genesis-api admin_economy.rs); unmapped /api/admin/* → super anyway.
  if (p === '/api/economy-settings' && method.toUpperCase() === 'POST') return { kind: 'tab', tab: 'reports' };

  // /api/admin/{dashboard-stats,metrics,ranking-exclusion,users/map} are 100% Rust
  // (genesis-api admin_dashboard.rs; auth by tab dashboard / metrics / users).

  if (p.startsWith('/api/admin/guide')) return { kind: 'tab', tab: 'settings:pages' };
  if (p.startsWith('/api/admin/roadmap')) return { kind: 'tab', tab: 'settings:pages' };

  if (p.startsWith('/api/admin/')) return { kind: 'super' };

  return { kind: 'super' };
}
