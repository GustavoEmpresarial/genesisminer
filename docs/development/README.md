# Desenvolvimento

- [backend/README.md](backend/README.md)
- [frontend/README.md](frontend/README.md)
- [testing/README.md](testing/README.md)

## Rodando tudo (raiz, `legacy/`)
```bash
npm run install-all   # backend + frontend
npm run dev            # concurrently: backend dev + frontend dev
npm test                # backend + frontend
```

Subir dependências (Postgres/Redis/Mongo) via `docker compose up -d` na raiz
antes de rodar `npm run dev` fora de container.
