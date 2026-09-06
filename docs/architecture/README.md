# Arquitetura — MineStation / Genesis Miner (estado atual, legado)

## Visão geral

Monólito Node.js/Express (backend) + React/Vite (frontend), com Postgres como
fonte de verdade (via Prisma), MongoDB para logs de atividade de jogo, e
Redis/BullMQ para locks distribuídos e workers assíncronos.

```
minestation/
├── legacy/            ← snapshot do código atual (não mexer, é referência)
│   ├── backend/        Express + Prisma + BullMQ, TypeScript compilado p/ dist/
│   ├── frontend/        React + Vite (App.tsx)
│   ├── app_production/  compose + nginx + certbot de PRODUÇÃO (VM)
│   └── uploads/         uploads de usuário (runtime)
└── current/            ← projeto novo (em construção, esta reestruturação)
    └── docs/            documentação (esta pasta)
```

## Backend legado — camadas hoje

O backend **não segue um padrão único**. Coexistem três estilos no mesmo diretório
`backend/`:

1. **Estilo antigo (flat)** — `controllers/`, `models/`, `lib/`, `services/`,
   `utils/`, `validation/`, `config/`, `cron/`, `workers/`. Arquivos soltos,
   nomeados livremente (`adminMiningDistribution.controller.ts`,
   `authModel.ts`, `mongoLogs.ts`...). Sem agrupamento por domínio.
2. **Estilo "módulo por domínio"** — `modules/<dominio>/` (ex.: `wallet`,
   `shop`, `batteries`, `chat`, `checkin`, `quests`...), cada um com seus
   próprios `*.controller.ts`, `*.service.ts`, `*.types.ts`. Mais organizado,
   mas inconsistente entre módulos (alguns têm `index.ts`, outros não; alguns
   têm repository, outros acessam Prisma direto no service).
3. **Estilo "feature isolada em src/"** — `src/auth/` é o único caso: auth
   (JWT, cookies, refresh token) vive fora de `modules/` e fora do padrão
   flat, sozinho em `backend/src/auth/`.

Ponto de entrada: `backend/server.ts` (compilado para `server.js`) — monta rotas,
middlewares, Prisma, Mongo, Redis/BullMQ, Socket.IO.

Ver detalhes completos em [modules/README.md](modules/README.md).

## Frontend legado

React + Vite, SPA única (`frontend/App.tsx` como shell), sem roteador de
arquivos — tudo em `frontend/components/*.tsx` (achatado, ~90 componentes),
mais `services/api.ts` como client HTTP central, `stores/` (um store
Zustand-like), `controllers/` e `models/` client-side para lógica de sala de
servidores (server room / mining rigs).

## Dados

- **Postgres** (via Prisma) — fonte única de verdade. 107 `model`s em
  `backend/prisma/schema.prisma`. Sem `@relation` entre models (decisão de
  design: reduz conflito com tabelas legadas; joins feitos via SQL explícito
  em `server.ts` / models).
  Ver [database/README.md](database/README.md).
- **MongoDB** — só para `game_activity_logs` (trilha de atividade para o
  admin: caixas, roleta, depósitos...). Não deve virar tabela Postgres.
- **Redis** — locks distribuídos (`lib/redisDistributedLock.ts`) + fila
  BullMQ (`workers/bullGenesisWorker.ts`).

## Infra / deploy

Dois docker-compose distintos, não rodar juntos no mesmo host:
- `docker-compose.yml` (raiz) — dev local (`app-postgres`, `app-redis`,
  `app-mongo`, `app`, `app-bull-worker`).
- `app_production/docker-compose.yml` — produção na VM (`app`,
  `app_scheduler`, `app_worker`, `postgres_app`, `redis_app`, `mongodb_app`,
  `app_nginx`, `app_certbot`).

Ver [infrastructure/README.md](infrastructure/README.md) e
[../deployment/README.md](../deployment/README.md).

## O que muda na reestruturação (`current/`)

Alvo (mesmo padrão adotado no BlockMiner 2.1): backend organizado em
`src/modules/<dominio>/` consistente (controller + service + routes +
index por módulo), `src/app/` para bootstrap/mount de rotas, `src/shared/`
para Prisma client, error handling, http utils — eliminando a mistura atual
de `controllers/models/lib` soltos com `modules/` e `src/auth` isolado.
Essa migração é incremental e documentada módulo a módulo conforme acontece.
