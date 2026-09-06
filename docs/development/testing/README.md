# Testes (legado)

Vitest nos dois lados (backend e frontend), sem framework de e2e identificado.

## Backend
`legacy/backend/test/` — ~90 arquivos. Cobertura concentrada em `lib/`,
`models/`, `modules/*` (validação de regras de negócio: check-in, roleta,
lucky boxes, wallet, batteries, server room). Alguns testes marcados
"backendOptional" (`pgIntegration.backendOptional.test.ts`) — dependem de
Postgres real disponível.

```bash
cd backend
npm test         # roda tudo
npm run test:cov # com cobertura
```

## Frontend
`legacy/frontend/test/` — cobre principalmente `controllers/`, `models/`,
`utils/`, `validation/` client-side (server room, batteries, activity log).

```bash
cd frontend
npm test
```

## Pendente
- [ ] Levantar % de cobertura atual (`test:cov` de cada lado).
- [ ] Definir meta de cobertura para módulos migrados na reestruturação.
