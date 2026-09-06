# API — referência

Ainda não existe documentação de rotas HTTP consolidada (nem OpenAPI/Swagger
identificado no legado). Rotas hoje ficam implícitas nos `*.controller.ts` de
cada módulo e no bootstrap de `server.ts`.

## Como será feito
Ao migrar cada módulo em `current/backend/src/modules/<dominio>/`, documentar
aqui as rotas expostas (método, path, auth, request/response) — mesmo padrão
adotado no BlockMiner 2.1 (`docs/reference/api/README.md`).

## Domínios a documentar (ordem sugerida = ordem de migração)
Ver lista completa em [../../architecture/modules/README.md](../../architecture/modules/README.md).
