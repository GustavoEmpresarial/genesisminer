# MineStation / Genesis Miner — Documentação

Índice geral. Esta documentação descreve, na Fase 1, o estado **atual (legado)**
do código em `legacy/` — serve de mapa para a reestruturação que vai acontecer
em `current/`.

## Getting Started
- [getting-started/README.md](getting-started/README.md) — como rodar o projeto localmente.

## Arquitetura
- [architecture/README.md](architecture/README.md) — visão geral da arquitetura.
- [architecture/DECISIONS.md](architecture/DECISIONS.md) — decisões tomadas na reestruturação (com o problema do legado que motivou cada uma).
- [architecture/PROJECT_OVERVIEW.md](architecture/PROJECT_OVERVIEW.md) — visão de produto/domínio.
- [architecture/modules/README.md](architecture/modules/README.md) — inventário de módulos do backend legado.
- [architecture/database/README.md](architecture/database/README.md) — Postgres (Prisma), Mongo, Redis.
- [architecture/services/README.md](architecture/services/README.md) — camada de services.
- [architecture/infrastructure/README.md](architecture/infrastructure/README.md) — containers, deploy, nginx.
- [architecture/dependencies/README.md](architecture/dependencies/README.md) — dependências principais.

## Desenvolvimento
- [development/README.md](development/README.md)
- [development/backend/README.md](development/backend/README.md)
- [development/frontend/README.md](development/frontend/README.md)
- [development/frontend/GAME_SHELL.md](development/frontend/GAME_SHELL.md) — chrome pós-login (navbar/sidebar) em `current/client`
- [development/testing/README.md](development/testing/README.md)
- [catalog/CANONICAL-CATALOG-CONTRACT.md](catalog/CANONICAL-CATALOG-CONTRACT.md) — contrato congelado do catálogo `upgrades` (identidade, OCC, soft-retire)

## Operações
- [operations/README.md](operations/README.md)
- [operations/cron/README.md](operations/cron/README.md)
- [operations/workers/README.md](operations/workers/README.md)
- [operations/monitoring/README.md](operations/monitoring/README.md)
- [operations/KUBERNETES.md](operations/KUBERNETES.md) — scaffold K8s (**sem deploy**)
- [operations/KAFKA.md](operations/KAFKA.md) — scaffold Kafka (**sem deploy**)
- [operations/STORAGE.md](operations/STORAGE.md) — filesystem / PVC

## Deploy
- [deployment/README.md](deployment/README.md)

## Referência
- [reference/api/README.md](reference/api/README.md)
- [reference/env-vars/README.md](reference/env-vars/README.md)
- [reference/scripts/README.md](reference/scripts/README.md)
- [reference/security/README.md](reference/security/README.md)

## Prompts
- [prompts/README.md](prompts/README.md)

---
**Status**: Fase 1 — documentação do legado. A reestruturação de código
(backend modular, limpeza de `controllers/models/lib` soltos) ainda não começou.
