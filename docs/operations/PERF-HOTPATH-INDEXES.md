# Performance indexes — apply & verify checklist

Migration: `prisma/migrations/20260820010000_perf_hotpath_indexes/`

Additive only (`CREATE INDEX IF NOT EXISTS`). No data changes. No drops.

## When to use which path

| Ambiente | Preferência |
|----------|-------------|
| VPS cutover / BD a partir de dump (`_prisma_migrations` vazio ou legado) | **`apply-sql`** |
| BD já gerida por Prisma migrate history | **`apply-prisma`** ou `apply-sql` |

O cutover docs (`docs/operations/TEST-VPS-CUTOVER.md`) dizem para **não** correr `prisma migrate deploy` cegamente contra dump restaurado. Nesse caso use `apply-sql`.

## Pré-requisitos

- `DATABASE_URL` no ambiente (ou em `.env` na raiz de `current/`)
- `psql` no PATH
- Para `apply-prisma`: `npx prisma` disponível
- Janela de manutenção leve recomendada em tabelas grandes (CREATE INDEX bloqueia writes na tabela no Postgres standard; esta migration **não** usa `CONCURRENTLY` de propósito, para caber em `migrate deploy` transacional)

## Checklist operacional

### 1. Backup / ponto de restauração

- [ ] Confirmar backup SQL recente (job diário ou dump manual)
- [ ] Anotar horário de início

### 2. Verificar estado atual (read-only)

```bash
cd /path/to/current
chmod +x scripts/apply-perf-hotpath-indexes.sh
./scripts/apply-perf-hotpath-indexes.sh verify
```

Esperado: `MISSING` nos índices (antes) ou `PASS` (se já aplicados).

### 3. Aplicar

**Dump-based / VPS (recomendado):**

```bash
CONFIRM=1 ./scripts/apply-perf-hotpath-indexes.sh apply-sql
```

**Prisma history alinhada:**

```bash
CONFIRM=1 ./scripts/apply-perf-hotpath-indexes.sh apply-prisma
```

### 4. Re-verificar

```bash
./scripts/apply-perf-hotpath-indexes.sh verify
```

Esperado: `PASS: todos os índices presentes` (11 índices).

### 5. Confirmar no Postgres (opcional, manual)

```sql
SELECT indexname, tablename
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE ANY (ARRAY[
    '%blocked_ranking%',
    'placed_racks_%',
    'player_listings_%',
    'p2p_trade_history_%',
    'mining_yield_history_%',
    'withdrawal_requests_user_created%'
  ])
ORDER BY tablename, indexname;
```

### 6. Smoke pós-apply (app)

- [ ] `/health/ready` → 200
- [ ] Login + dashboard
- [ ] P2P state / listagens
- [ ] Logs do job `mining_yield` sem erro novo

### 7. Próximo passo (não neste script)

`EXPLAIN (ANALYZE, BUFFERS)` nos hot paths **depois** de tráfego real — bloco B da sequência.

## Rollback

Índices são aditivos. Rollback = `DROP INDEX CONCURRENTLY IF EXISTS <nome>;` por índice, se necessário. Não há rollback automático no script (de propósito).

## Índices esperados (11)

1. `users_blocked_ranking_excluded_idx`
2. `placed_racks_is_on_user_idx`
3. `placed_racks_user_id_idx`
4. `player_listings_status_expires_idx`
5. `player_listings_user_status_idx`
6. `player_listings_status_reserved_until_idx`
7. `p2p_trade_history_buyer_created_idx`
8. `p2p_trade_history_seller_created_idx`
9. `mining_yield_history_effective_at_idx`
10. `mining_yield_history_coin_effective_idx`
11. `withdrawal_requests_user_created_idx`
