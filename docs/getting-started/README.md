# Getting Started

## Pré-requisitos
- Node.js >= 20
- Docker + Docker Compose (Postgres, Redis, Mongo)

## Setup local (código legado, ainda fonte de verdade em runtime)
```bash
cd legacy
docker compose up -d           # Postgres + Redis + Mongo (dev)
npm run install-all             # backend + frontend
cd backend && npx prisma migrate deploy && cd ..
npm run dev                     # backend + frontend concorrentes
```

Frontend em `http://localhost:5173` (padrão Vite), backend na porta de `PORT`
(`.env`).

## Onde mexer
- Código ainda roda a partir de `legacy/`. **Não editar `legacy/` como se
  fosse o projeto ativo além de leitura/referência** — a reestruturação
  acontece em `current/`.
- Dúvida sobre onde fica uma fonte de verdade → ver
  [../architecture/README.md](../architecture/README.md) e o `ESTRUTURA.md`
  original em `legacy/ESTRUTURA.md`.
