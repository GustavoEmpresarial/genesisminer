# Frontend — chrome admin (AdminShell + AdminPanel)

Mapa da portagem do painel admin a partir do monólito legado
(`legacy/frontend/AdminPanel.tsx` + header admin em `App.tsx`).
Decisão: **DECISIONS.md #111**; hardening poll/cache/SQL: **#112**;
usuários: **#113**; resto das abas (template 1:1): **#114**.
Shell do jogador: **GAME_SHELL.md**.

## Problema no legado

Admin partilhava o mesmo `App.tsx` monstro; a sidebar admin vivia em
`AdminPanel.tsx` com dezenas de abas e SQL/WS misturados no backend.

## Como foi tratado em `current/client`

```
App.tsx
  └─ view admin && user.isAdmin → AdminShell
        ├─ header (logo, docs, idioma, voltar ao jogo, logout)
        ├─ AdminPanel (sidebar + outlet por tab)
        │     └─ tab dashboard → AdminDashboard (fetch sob pedido)
        │     └─ tab users → AdminUsers (template legado; lista `GET /api/users`)
        │     └─ demais tabs → JSX legado (shops/settings/sub-abas iguais)
        └─ PublicFooter
```

### Ficheiros

| Ficheiro | Responsabilidade |
|----------|------------------|
| `features/admin/AdminShell.tsx` | Chrome fixo (header + footer); coluna direita scrollável |
| `features/admin/AdminPanel.tsx` | Sidebar + URL `/admin/:tab`; outlet 1:1 com o legado |
| `features/admin/AdminDashboard.tsx` | KPIs / tops / ranking-exclusion (layout legado) |
| `features/admin/AdminUsers.tsx` | Template legado (lista, editor, sub-abas) |
| `features/admin/Admin*.tsx` | Restantes páginas admin (markup legado) |
| `shared/api/admin-legacy.ts` | Cliente HTTP copiado do `services/api.ts` legado |

### API (server)

| Rota | Notas |
|------|-------|
| `GET /api/admin/dashboard-stats` | Agregados + cache 10s; top saques 1 query window (#112) |
| `POST /api/admin/ranking-exclusion` | `{ email, excluded }` + invalida cache + audit Mongo |
| `GET /api/admin/users/map` | Mapa leve carteira↔user (depósitos on-chain futuros) |
| `GET /api/users` | Lista paginada (search/sort/filtros); tab `users` |
| `PUT /api/users/block` | `{ email, blocked }` |

Poll HTTP do dashboard: **só sob pedido** (mount + botão Atualizar). Sem timer / WS.

### Ainda aberto

- Depósitos on-chain (Etherscan treasury)
- Endpoints server que ainda 404 — a UI mostra; gravar pode falhar com alerta legado
- Sem poll de 5s das news (explícito)

### Fora de escopo

- WebSocket `/ws/admin-dashboard` — não portar
