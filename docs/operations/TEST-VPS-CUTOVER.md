# Cutover VM de teste — current/ (Contabo MinerCore 1)

Alvo: `dev.genesisdao.tech` em `161.97.176.125`.
Produção (`genesisdao.tech`) nesta VM fica em **manutenção 503** — não reactivar no cutover de teste.

**Não commitar senhas, `.env`, dumps nem chaves SSH.**

## O que esta VM já tinha (legado)

Compose `app_production` em `/root/minestation/app_production`:

| Contentor | Papel |
|---|---|
| `app` / `app_scheduler` / `app_worker` | Genesis legado (Node) |
| `postgres_app` | Postgres 16, volume `deployment_pgdata` |
| `redis_app` | Redis 7, volume `deployment_redisdata` |
| `mongodb_app` | Mongo 7, volume `deployment_mongodata` |
| `app_nginx` | 80/443; vhost `dev.genesisdao.tech` → `http://app:3000` |
| `app_certbot` | renovação Let's Encrypt |

Outros contentores na mesma VM (**não mexer**): `polygon-rpc`, `polygon-postgres`, `polygon-redis`, `bgutil-provider`, e daemons host (`dogecoind`, `litecoind`).

## Executado em 2026-08-19 (VM de teste)

- Código em `/root/genesis-current`, compose `deploy/docker-compose.yml`.
- Postgres restaurado do dump local: **13800** users, **5301 MB**.
- Imagens: `storage/media-seed` (442 MB) + `storage/uploads` (13 MB).
- Mongo **não** foi sobrescrito: o dump local tinha ~31 `game_activity_logs`; a VM tinha ~3.5 M. Backup em `/root/genesis-cutover-20260819/vm-before.genesis_logs.archive.gz`.
- Contentores Node legado (`app`, `app_scheduler`, `app_worker`) removidos; `app_worker` (Bull) não sobe.
- `genesisdao.tech` continua **503** (manutenção). Teste em `https://dev.genesisdao.tech`.
- Backup pré-cutover: `/root/genesis-cutover-20260819/vm-before.minestation.dump` + `vm-before-img.tgz`.

## O que o cutover faz

1. Pára o Genesis **legado** (`app`, `app_scheduler`, `app_worker`).
2. Backup do Postgres/Mongo/imagens **que estavam na VM**.
3. Restaura o dump local (`minestation` + `genesis_logs`) e as pastas de imagem de `current/storage`.
4. Sobe `current/` (Docker) com os **mesmos nomes** `app` e `app_scheduler` na rede `app_production_default`, para o nginx continuar a resolver `app:3000`.
5. `app_worker` (Bull do legado) **não sobe** — o worker Bull não foi portado.

`current/` **não** corre `prisma migrate deploy`. O schema é o do dump.

## Pré-requisitos na máquina de origem (dev)

- Docker com Postgres local (`minestation-local-db`) e Mongo (`minestation-local-mongo`).
- `ssh` + `rsync` (+ `sshpass` se a auth for por palavra-passe).
- Disco: dump custom ~1–2 GB + imagens ~450 MB + código.

```bash
# Postgres (custom format)
docker exec minestation-local-db pg_dump -U postgres -Fc -d minestation -f /tmp/minestation-local.dump
docker cp minestation-local-db:/tmp/minestation-local.dump /tmp/minestation-local.dump

# Mongo (logs de jogo)
docker exec minestation-local-mongo mongodump --db genesis_logs --archive=/tmp/genesis_logs.archive --gzip
docker cp minestation-local-mongo:/tmp/genesis_logs.archive /tmp/genesis_logs.archive.gz
```

Imagens fonte de verdade em `current/`:

- `storage/media-seed` → `IMG_DIR`
- `storage/uploads` → `IMG_UPLOADS_DIR`

## Enviar para a VM

```bash
VM=root@161.97.176.125
REMOTE=/root/genesis-current

ssh "$VM" "mkdir -p $REMOTE/storage/backups $REMOTE/deploy /root/genesis-cutover-$(date +%Y%m%d)"

rsync -a --delete \
  --exclude node_modules --exclude client/node_modules \
  --exclude dist --exclude client/dist \
  --exclude .git --exclude '*.dump' --exclude .env \
  ./ "$VM:$REMOTE/"

rsync -a --delete storage/media-seed/ "$VM:$REMOTE/storage/media-seed/"
rsync -a --delete storage/uploads/ "$VM:$REMOTE/storage/uploads/"

rsync -a /tmp/minestation-local.dump "$VM:/root/genesis-cutover-$(date +%Y%m%d)/minestation-local.dump"
rsync -a /tmp/genesis_logs.archive.gz "$VM:/root/genesis-cutover-$(date +%Y%m%d)/genesis_logs.archive.gz"
```

Na VM, copiar secrets **sem** apontar para localhost:

```bash
# Reusa JWT/mail/RPC da stack antiga; o compose injeta DATABASE/REDIS/MONGO.
grep -vE '^(DATABASE_URL|REDIS_URL|MONGODB_URI)=' /root/minestation/app_production/.env \
  > /root/genesis-current/deploy/.env
# Confirmar POSTGRES_PASSWORD igual ao do contentor postgres_app.
```

## Na VM — backup + restore + rebuild

```bash
CUT=/root/genesis-cutover-$(date +%Y%m%d)
mkdir -p "$CUT"

# 1) Backup do que vai ser substituído
docker exec postgres_app pg_dump -U postgres -Fc -d minestation > "$CUT/vm-before.minestation.dump"
docker exec mongodb_app mongodump --db genesis_logs --archive --gzip > "$CUT/vm-before.genesis_logs.archive.gz"
tar -C /root/minestation/backend -czf "$CUT/vm-before-img.tgz" img

# 2) Parar Node legado (Postgres/Mongo/Redis/nginx ficam)
docker stop app app_scheduler app_worker
docker rm app app_scheduler app_worker

# 3) Postgres: drop + restore (termina sessões)
docker exec -i postgres_app psql -U postgres -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='minestation' AND pid <> pg_backend_pid();"
docker exec -i postgres_app psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS minestation;"
docker exec -i postgres_app psql -U postgres -d postgres -c "CREATE DATABASE minestation OWNER postgres;"
docker exec -i postgres_app pg_restore -U postgres -d minestation --no-owner --role=postgres \
  < "$CUT/minestation-local.dump"
# pg_restore pode sair ≠0 com avisos de ACL; confirmar:
docker exec postgres_app psql -U postgres -d minestation -c "SELECT count(*) FROM users;"

# 4) Mongo: substitui genesis_logs
docker exec -i mongodb_app mongorestore --drop --gzip --archive --db genesis_logs \
  < "$CUT/genesis_logs.archive.gz"

# 5) Redis: cache/locks do legado (opcional mas recomendado no teste)
docker exec redis_app redis-cli FLUSHDB

# 6) Build + up current (mesmos nomes app / app_scheduler)
cd /root/genesis-current/deploy
docker compose up -d --build

# 7) Nginx resolve `app` no arranque — reiniciar depois do IP novo
docker restart app_nginx
```

Health:

```bash
docker ps --filter name=app
docker logs app --tail 80
curl -fsS http://127.0.0.1/api/news -H 'Host: dev.genesisdao.tech' | head
curl -fsSI https://dev.genesisdao.tech/
```

Rollback rápido (só se o backup `vm-before.*` existir):

1. `docker compose -f /root/genesis-current/deploy/docker-compose.yml down`
2. Restaurar `vm-before.minestation.dump` / mongo / `img` como acima.
3. `cd /root/minestation/app_production && docker compose up -d app app_scheduler app_worker`
4. `docker restart app_nginx`

## Produção (sexta) — diferenças

- **Não** usar esta VM se `genesisdao.tech` voltar a apontar para ela sem manutenção.
- Janela: manutenção 503 (já há `genesisdao-maintenance.conf`) **antes** de dropar a BD.
- Dump da origem deve ser o Postgres **de produção**, não o portátil de desenvolvimento, salvo se for essa a decisão explícita.
- Confirmar DNS / Cloudflare (laranja) e `FRONTEND_URL` / `CORS_EXTRA_ORIGINS` no domínio real.
- Volumes de imagem: no legado era `backend/img`; em `current/` são `storage/media-seed` + `storage/uploads`.
- Não ligar `app_worker` até o Bull ser portado (ou aceitar jobs de manutenção desligados).
- Réplicas `app2`/`app3`: só se o nginx tiver `upstream` com esses hosts; nesta VM de teste o vhost aponta só a `app:3000`.
- Nunca `prisma migrate deploy` contra a BD restaurada neste cutover.
- Depois do teste: **rodar a palavra-passe root** se foi partilhada em chat.

## Checklist pré-produção

- [ ] Backup `pg_dump -Fc` + `mongodump` + tarball de imagens, copiados para fora da VM
- [ ] `genesisdao.tech` em 503
- [ ] Stop só dos contentores Node do Genesis
- [ ] Restore verificado (`count(*)` users, sample `/img`, login admin)
- [ ] Um único contentor `app` com API + scheduler (`SCHEDULER_ENABLED=1`; locks Redis)
- [ ] Nginx reload/restart após recreate
- [ ] Health `/api/news` 200 e SPA HTML em `/`
- [ ] Socket.IO (chat) pelo mesmo host/proxy
- [ ] Mail / Polygon RPC / Etherscan a responder
- [ ] Plano de rollback ensaiado com o `vm-before.*`
