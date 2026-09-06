# Frontend — chrome pós-login (navbar + sidebar)

Mapa da portagem do shell do jogo a partir do monólito
`legacy/frontend/App.tsx`. Decisão de arquitetura: **DECISIONS.md #80**;
estrutura do client portado: **#98**.

## Problema no legado

Não havia componentes `Navbar` / `Sidebar` / `AppShell`. Depois do login, o
chrome vivia **inline** em `App.tsx` (~milhares de linhas).

Admin tem **outra** sidebar — ver **ADMIN_SHELL.md**.

## Como foi tratado em `current/client`

```
App.tsx
  ├─ view pública → LandingHeader + Home/Auth/Footer
  └─ view === 'game' && user → GameShell
        ├─ GameTopNav
        ├─ GameMobileDrawer
        ├─ GameSidebar
        └─ <main> → GameViewOutlet (mapa view → página)
```

### Ficheiros do chrome

| Ficheiro | Responsabilidade |
|----------|------------------|
| `features/game/GameShell.tsx` | Orquestra chrome + `currentView`; LS expand sidebar + Mini Blog rail |
| `features/game/GameViewOutlet.tsx` | Switch de conteúdo por `GameView` (escalável) |
| `features/game/GameTopNav.tsx` | Header (logo, stats strip Tokens/USDC/Hash/Ranking, user, logout) |
| `features/game/GameSidebar.tsx` | Aside `lg+` Hub/Operação/Economia |
| `features/game/GameMobileDrawer.tsx` | Drawer `< lg` |
| `features/game/nav/buildGameNavItems.ts` | Tipos, tabs, allowlist |
| `shared/constants/gameNavLabels.ts` | Labels / páginas default |

### Views portadas (jogador)

| `GameView` | Feature | Notas |
|------------|---------|--------|
| `servers` | `features/servers` + banner `checkin` (`lg+`) | Banner sticky só desktop; USDC seed no shell (#106) + `onUsdcChange` |
| `checkin` | `features/checkin` | View dedicada **só drawer mobile** (`mobileOnly`); path `/checkin` |
| `transparency` | `features/transparency` | Self-padded; links só `https:` |
| `mini_blog` | `features/mini-blog` | Hub page + rail `xl+` (encolher); hide: dashboard/partners/mini_blog |
| `quests` | `features/quests` | Layout legado; grid 3 cols `lg+`; `max-w-6xl`; self-padded |
| `support` | `features/support` | `HubPageFrame compact` + `HubPanel` sky; list/new/detail |
| `partners` | `features/partners` | Vitrine + studio (candidatura / canal); self-padded |
| `offerwall` | `features/offerwall` | Catálogo providers + ZERads PTC |
| `arcade` | `features/arcade` | Placeholder (legado: “em preparação”) |
| `roleta` | `features/roleta` | Código + giro pago; prizes via `wheel/state` (não `/wheel/config`) |
| `inventory` | `features/inventory` | Self-fetch; infinitas filtradas server+client (#105/#106) |
| `management` | `features/gerente` | Só se `accountManagerEnabled` na session (#106); API em `features/gerente/api` |
| `upgrade` | `features/upgrades` | Packages / passes; CTA wallet/lucky |
| `merge` | `features/merge` | Forge; gated por `mergeEnabled` |
| `hardware_store` | `features/shop` | Carrinho + checkout |
| `profile` | `features/profile` | Identidade / referral / wallet Polygon; sem badges bundle |
| `black_market` | `features/black-market` | P2P — state/sell/buy/claim (#107) |
| `lucky_store` | `features/lucky-boxes` | Compra/abre/descarta/promo (#107) |
| `wallet` | `features/wallet` | Layout legado Exchange+WalletActions; históricos deposit/withdrawal (#109) |
| `withdrawal_history` | `features/wallet` | `GET /api/withdrawals/history` |
| `deposit_history` | `features/wallet` | `GET /api/deposits/history` |
| `ranking` | `features/ranking` | Leaderboard público (#107) |
| `calculator` | `features/calculator` | Projeções `calculator/me` (#107) |
| resto | stub | `shell.pageNotPorted` (ex.: dashboard) |

### Utilitários partilhados (DECISIONS #98)

| Path | Uso |
|------|-----|
| `shared/api/http.ts` | `apiFetch` + refresh-on-401 |
| `shared/api/client-errors.ts` | Códigos `SESSION`/`NETWORK`/`CLAIM_FAILED`/… → i18n |
| `shared/utils/locale-format.ts` | `dateLocaleFor`, `formatUsdcAmount`, `formatInstantMs`, `formatTokenAmount`, `formatHashTotal` |
| `shared/utils/safe-https-link.ts` | Guard de `href` / imagens in-app |
| `shared/ui/HubPageFrame.tsx` | Padding: `mini_blog`, `support` |
| `shared/ui/HubPanel.tsx` | Chrome de painel (hoje: support) |
| `shared/ui/UiNoticeModal.tsx` | Modais info/success/error (roleta, etc.) |
| `shared/api/wheel.ts` | Roleta / wheel player API |
| `shared/api/inventory.ts` | Inventário |
| `features/gerente/api` | Gestão de contas (`/api/account-manager/*`) |
| `features/checkin/api` | Check-in player (`GET/POST /api/checkin`) |
| `shared/api/upgrades.ts` | Eventos e passes |
| `shared/api/merge.ts` | Merge Station |
| `shared/api/shop.ts` | Loja de miners |
| `shared/api/profile.ts` | Perfil jogador |
| `shared/api/player-game.ts` | Header strip (`GET /api/player-game/header`, #110) |

### Preferências localStorage (chrome)

| Key | Valores | Default |
|-----|---------|---------|
| `minestation.gameNavExpanded` | `1` / `0` | expandido |
| `minestation.miniBlogExpanded` | `1` / `0` | expandido |

Labels da nav (sidebar + drawer): CSS `uppercase` (DECISIONS #103).

### Convenção de pastas por feature

```
features/<name>/
  <Name>Page.tsx          # orquestrador (estado + fetch)
  index.ts                # re-exports públicos (outlet importa daqui)
  components/             # UI pura / cartões / tabs
  lib/                    # helpers sem React (ou quase)
```

APIs HTTP em `shared/api/<name>.ts` (não dentro da feature), **exceto** check-in:
`features/checkin/api/checkin.ts`.

Erros de API: preferir `mapApiErrorToMessage(code, t, 'prefix')` em vez de
switches manuais por feature.

**Quests:** CSS alinhado ao legado; grid `lg:grid-cols-3` (pedido de UX).
**Support:** `SupportPage` + list/detail/form/attachments + `lib/`.
**Check-in:** feature `features/checkin` (API em `features/checkin/api`). Desktop: sticky
banner em `servers` (`lg+`). Mobile: `GameView` `checkin` só no drawer (`mobileOnly`).

### O que ainda falta (stubs / parcial)

- WebSocket `/ws/player-game` — **fora de escopo**; strip = fetch sob pedido (`GET /api/player-game/header`, #110/#112)
- Path sync URL (`/servers`, `/quests`, …) — hoje: `sessionStorage.lastView` (legado)
- Depósito / saque on-chain na carteira (mutações player ainda não no server)
- Admin UI / AdminEconomy no calculator
- i18n total das UIs Operação / Economia / Roleta (copy PT legado)
- Allowlist completa via `accessLevels` da API
- Script limpeza stock infinito residual (#105 VM)
- Split maior de páginas grandes (BlackMarket, Shop, Merge, …)

## Mineração (`servers`) — DECISIONS #81 + check-in #97

| Peça | Path |
|------|------|
| Página | `features/servers/MiningPage.tsx` |
| Check-in banner (desktop) | `features/checkin/ui/DailyCheckinBanner.tsx` |
| Check-in page (mobile) | `features/checkin/ui/CheckinPage.tsx` |
| UI sala | `features/servers/components/ServerRoom.tsx` |
| API servers | `features/servers/api/servers.ts` |
| API check-in | `features/checkin/api/checkin.ts` |

**Ainda parcial:** bulk battery, calculadora, hash strip.
