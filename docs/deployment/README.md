# Deploy

Ver detalhes técnicos em
[../architecture/infrastructure/README.md](../architecture/infrastructure/README.md).

## Teste (VM Contabo / `dev.genesisdao.tech`)

Cutover `current/` (parar legado, restaurar dump+imagens, Docker):
[../operations/TEST-VPS-CUTOVER.md](../operations/TEST-VPS-CUTOVER.md).

Filesystem de imagens/backups (contrato, K8s, symlinks):
[../operations/STORAGE.md](../operations/STORAGE.md).

Compose de teste: `deploy/docker-compose.yml` (reusa Postgres/Redis/nginx da stack `app_production`; a app `current/` não usa Mongo).

## Produção (VM)
- Compose legado: `legacy/app_production/docker-compose.yml` (ainda o que corre até o cutover).
- Após cutover: mesmo runbook de teste, com DNS/`FRONTEND_URL` de produção e dumps da BD live.
- Scripts: `legacy/app_production/*.sh` (`init-ssl.sh`, `stack-up.sh`, `migrate-db.sh`).
- Nginx + Certbot: `legacy/app_production/nginx/`, `legacy/app_production/certbot/`.
- Variáveis: `legacy/app_production/.env` (não commitado).

## Dev local
- Compose: `legacy/docker-compose.yml` / `legacy/docker-compose.local.yml`.
- `docker compose up --build` na raiz do legado; `current/` corre `npm run dev:server` + `npm run dev:client`.

## Fluxo de build (Dockerfile `current/`)
1. `npm ci` + Vite → `client/dist`.
2. `prisma generate` + `tsc` → `dist/`.
3. Runtime: `node dist/bootstrap/server.js` (**sem** `prisma migrate deploy`).
