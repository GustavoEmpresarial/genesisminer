# Frontend (current/client)

SPA React + Vite + Tailwind. Portagem a partir de `legacy/frontend`
(referência só — não editar).

```bash
cd current/client
npm install
npm run dev      # http://localhost:5173 — proxy /api e /img → backend :3000
npm run build
npm run typecheck
```

## Estrutura activa

| Path | Papel |
|------|--------|
| `src/app/App.tsx` | Roteamento por estado: home / auth / game / stub |
| `src/features/landing/` | Home pública + `LandingHeader` |
| `src/features/auth/` | `AuthPage` (login/registo/recovery/verify) |
| `src/features/game/` | **Chrome pós-login** — ver abaixo |
| `src/features/shell/` | Footer público |
| `src/shared/api/auth.ts` | Client HTTP fino de auth |
| `src/shared/constants/` | `authLimits`, `gameNavLabels`, community links |

## Chrome pós-login (`features/game/`)

Extraído do monólito legado (`App.tsx`), **não** reescrito do zero.
Documentação completa:

- [`docs/development/frontend/GAME_SHELL.md`](../docs/development/frontend/GAME_SHELL.md)
- Decisão: [`docs/architecture/DECISIONS.md`](../docs/architecture/DECISIONS.md) **#80**

Resumo:

```
login OK → App monta GameShell
  ├─ GameTopNav
  ├─ GameSidebar (desktop) / GameMobileDrawer (mobile)
  └─ main = stub até portar cada ecrã (servers, inventory, …)
```

Abrir o shell **não** envia dados à API por si; só UI + preferência de
sidebar expandida em `localStorage`.

## Comunicação (fase actual)

| Superfície | Pedidos sem acção do user |
|------------|---------------------------|
| Home | nenhum |
| Auth | `GET /api/security/turnstile-config` (+ Turnstile/iframe anúncio se ligados) |
| GameShell | nenhum |

Login/registo/fingerprint só no submit.
