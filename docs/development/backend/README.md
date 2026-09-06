# Backend — desenvolvimento (legado)

```bash
cd backend
npm install
npx prisma generate
npm run dev            # prisma generate + build:server + node server.js
```

## Scripts (`backend/package.json`)
| Script | Faz |
|---|---|
| `dev` | prisma generate + build:server + `node server.js` |
| `build:ts` | `tsc -p tsconfig.json` |
| `build:server` | build:ts + `tsc -p tsconfig.server.json` |
| `build:cron` | `tsc -p tsconfig.cron.json` |
| `build:app` | generate + limpa `dist/cron` + build:cron + build:server + copia `lib/miningLivePrices.js` |
| `test` / `test:watch` / `test:cov` | vitest |
| `db:pull` | `prisma db pull` |
| `schema:validate` | `prisma validate` |
| `migrate:deploy` / `migrate:dev` / `migrate:status` | prisma migrate |

Três `tsconfig` (`tsconfig.json`, `tsconfig.server.json`, `tsconfig.cron.json`)
— sem bundler, build em etapas. Ver motivo em
[../../architecture/dependencies/README.md](../../architecture/dependencies/README.md).

## Estrutura hoje
Ver inventário completo em
[../../architecture/modules/README.md](../../architecture/modules/README.md) —
mistura de `controllers/models/lib/services` (flat) com `modules/<dominio>/`
e `src/auth/` isolado. **Este é o principal alvo da reestruturação.**
