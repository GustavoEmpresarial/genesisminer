# Getting Started

## Pré-requisitos
- Node.js >= 20
- Docker + Docker Compose (Postgres, Redis, Mongo)

## Setup local
```bash
# na raiz deste repo (current/)
docker compose -f deploy/docker-compose.yml up -d   # Postgres + Redis (+ deps)
npm install && npm --prefix client install
npx prisma migrate deploy
npm run dev                                         # ou o fluxo documentado em deploy/
```

Frontend em `http://localhost:5173` (padrão Vite), backend na porta de `PORT`
(`.env`).

## Onde mexer
- Fonte de verdade: este repositório (`current/` no layout antigo da monorepo).
- Dúvida sobre módulos → [../architecture/README.md](../architecture/README.md)
  e [../architecture/modules/README.md](../architecture/modules/README.md).
