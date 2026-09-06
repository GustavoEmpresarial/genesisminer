# Dependências principais (legado)

## Backend (`legacy/backend/package.json`)

| Pacote | Uso |
|---|---|
| `express` | HTTP server |
| `@prisma/client` / `prisma` `^6.19` | ORM Postgres |
| `mongodb` `^6.21` | driver nativo, só `game_activity_logs` |
| `ioredis` `^5.8` | Redis (locks + BullMQ) |
| `bullmq` `^5.63` | fila/worker assíncrono |
| `socket.io` + `@socket.io/redis-adapter` | tempo real (chat) multi-instância |
| `jsonwebtoken` / `bcryptjs` | auth |
| `helmet`, `cors`, `express-rate-limit` | segurança HTTP básica |
| `multer`, `sharp` | upload e processamento de imagem |
| `nodemailer` | e-mail (verificação, campanhas) |
| `ethers` `^6.15` | interação com wallets/RPC EVM (Base/BNB/Polygon) |
| `@google/genai` | IA (usado por `frontend/services/geminiService.ts`? confirmar uso backend) |
| `pg` | client Postgres cru (complementa Prisma para SQL explícito) |
| `ws` | WebSocket cru (além de socket.io — checar se ainda em uso) |
| `vitest` (dev) | testes |
| `typescript` (dev) | build (`tsc`, sem bundler — 3 tsconfigs: app/server/cron) |

## Frontend (`legacy/frontend/package.json`)

Não detalhado ainda nesta fase — a fazer quando a reestruturação chegar no
frontend. Stack observada: React + Vite + Tailwind (`tailwind.config.js`,
`postcss.config.js`, `vite.config.ts`).

## Observação sobre build do backend

Sem bundler: `tsc` puro, 3 configs (`tsconfig.json`, `tsconfig.server.json`,
`tsconfig.cron.json`) compilando para `dist/` em passos separados
(`build:ts` → `build:server`, mais `build:cron`). `build:app` ainda copia
manualmente `lib/miningLivePrices.js` pro `dist/lib` — sinal de que esse
arquivo não é TS ou tem alguma dependência de runtime que não passa pelo tsc
normal. Investigar ao migrar `lib/`.
