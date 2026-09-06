# Workers (legado)

`legacy/backend/workers/bullGenesisWorker.ts` — único worker BullMQ
identificado. Consome fila via Redis (`ioredis`).

Em produção roda como container separado: `app_worker`
(`app_production/docker-compose.yml`); em dev, `app-bull-worker`
(`docker-compose.yml` raiz) — mesmo `Dockerfile` da API, comando diferente.

## Pendente
- [ ] Mapear quais jobs são enfileirados nesse worker e por quem (produtores).
- [ ] Confirmar retry/backoff policy configurada no BullMQ.
