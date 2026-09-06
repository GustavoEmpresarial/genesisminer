# Infraestrutura (legado)

## Dois ambientes, dois compose — não rodar juntos no mesmo host

### Dev local — `legacy/docker-compose.yml`
`name: minestation-dev`. Containers: `app-postgres`, `app-redis`, `app-mongo`,
`app`, `app-bull-worker`. Mesmo `Dockerfile` (raiz) para app e worker.

### Produção (VM) — `legacy/app_production/docker-compose.yml`
Containers: `app`, `app_scheduler`, `app_worker`, `postgres_app`, `redis_app`,
`mongodb_app`, `app_nginx`, `app_certbot`. Build com `context: ..` — usa
`backend/` e `frontend/` da raiz do repo (não tem cópia própria).

⚠️ Nomes de container `app*` colidem entre os dois composes — nunca subir os
dois no mesmo host.

## Nginx / SSL (produção)
`app_production/nginx/conf.d/`: vhosts reais — `dev.genesisdao.tech.conf`,
`masterlegends.online.conf`, `minestation.conf`, `spot.genesisdao.tech.conf`,
mais `00-rate-limit.conf`, `00-gzip.conf` e includes `.inc`.
Certificados: `app_production/certbot/conf/` (runtime, gitignored).

## Scripts de operação (produção)
`app_production/*.sh`: `init-ssl.sh`, `stack-up.sh`, `migrate-db.sh`, etc.
Ver [../../reference/scripts/README.md](../../reference/scripts/README.md).

## Dockerfile (raiz)
Build oficial único. Context = raiz do repo: builda `frontend/` (Vite) e
`backend/` (`tsc`), roda `prisma migrate deploy` e sobe `node server.js`.

## Uploads
`legacy/uploads/` — diretório de upload de usuário em runtime (fora do
container versionado, deve ser volume em produção — confirmar mapeamento no
compose de produção).
