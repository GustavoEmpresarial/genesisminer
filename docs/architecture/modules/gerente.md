# Módulo `gerente`

Gerência de conta: contratar / candidatar-se, aceitar / recusar, demitir / resignar, entrar / sair da conta gerida, accrual de share na mineração, payout semanal catch-up, e guard de allowlist em “modo gerência”.

Ver também [DECISIONS.md #115](../DECISIONS.md), [#121](../DECISIONS.md).

## Paths

| Camada | Path |
|--------|------|
| Server (legado Express) | `server/modules/gerente/` |
| Rust twins | `rust/genesis-mining-worker/src/gerente/` (`/v1/gerente/*`) + `gerente_payout.rs` |
| genesis-api | `rust/genesis-api/src/gerente.rs` (fachadas `/api/account-manager/*`) |
| Client | `client/src/features/gerente/` (API: `features/gerente/api`) |
| Week UTC | `server/shared/utils/utc-week.ts` + `rust/genesis-core/src/utc_week.rs` |
| Testes | `tests/modules/gerente/`, `tests/shared/utils/utc-week.test.ts` |

## Layout de pastas (server)

```
server/modules/gerente/
  index.ts                          # exports públicos + registerGerenteModuleRoutes
  controllers/gerente.controller.ts # HTTP /api/account-manager/*
  services/
    constants.ts                    # SHARE 10%, FIRE_LOCK_DAYS, statuses
    feature.ts                      # kill-switch ACCOUNT_MANAGER_ENABLED
    manager.ts                      # hire/apply/accept/decline/fire/resign/enter/leave/me
    accrual.ts                      # 10% do minerado → gerente (tx mining / Node path)
    payout.ts                       # liquida semanas UTC fechadas unpaid
    payout-cron.ts                  # poll horário + lock Redis
    guard.ts                        # allowlist em manager_mode
    errors.ts                       # AccountManagerError
```

Client: `features/gerente/ui/*` + `features/gerente/api/gerente.ts`.

## HTTP (compat — path inalterado)

Prefixo: `/api/account-manager/*`

| Método | Rota | Notas |
|--------|------|--------|
| `GET` | `/me` | Estado dono/gerente (contratos, ganhos, semana) |
| `POST` | `/hire` | Dono convida gerente |
| `POST` | `/apply` | Jogador candidata-se |
| `POST` | `/accept` | Aceita convite (gerente) ou candidatura (dono) |
| `POST` | `/decline` | Recusa |
| `POST` | `/fire` | Dono encerra contrato ativo (sujeito a fire-lock) |
| `POST` | `/resign` | Gerente encerra o próprio contrato |
| `POST` | `/enter` | Sessão passa a atuar como dono (`manager_mode`) |
| `POST` | `/leave` | Sai do `manager_mode` |

Kill-switch: `ACCOUNT_MANAGER_ENABLED=1` (default desligado). Mutações e `me` rejeitam com `ACCOUNT_MANAGER_DISABLED` se off.

## Prisma / SQL

Tabelas (nomes legados preservados):

- `account_manager_contracts`
- `account_manager_mining_accrual`
- `account_manager_payout_ledger`

## Fluxo hire / enter / leave

1. **Hire / apply** → contrato `pending` ou `applied`.
2. **Accept** → `active`; define `hired_at` e `fire_locked_until` (fire-lock).
3. **Enter** → gerente troca a sessão para operar como o dono (`manager_mode`); guard restringe rotas à allowlist.
4. **Leave** → volta à sessão do gerente (escape path sempre permitido no guard).

## Economia e regras

| Regra | Valor / comportamento |
|-------|------------------------|
| Accrual | `ACCOUNT_MANAGER_SHARE` = 10% do minerado do dono → ledger de accrual (mesma tx do crédito). Node: `progress-computer` SAVEPOINT; Rust worker: `progress.rs` SAVEPOINT `mining_progress_accrual_sp` quando `ACCOUNT_MANAGER_ENABLED`. |
| Payout | **Rust** `genesis-mining-worker` owns o poll horário (`run_gerente_payout_loop`, lock `genesis:lock:job:gerente-payout`). Money TX: `POST /v1/gerente/payout`. Node `startGerentePayoutCron` é no-op. Chave: `am_payout:{contractId}:{coinId}:{weekStart}`. |
| Fire-lock | `ACCOUNT_MANAGER_FIRE_LOCK_DAYS` = 7 dias após accept |
| Teto de contas | **Sem teto** — sem cap de contas geridas ativas |
| HTTP player | **Rust** twins `/v1/gerente/*` + `genesis-api` fachadas `/api/account-manager/*` (Express residual só admin/socket/partners). |

## Wiring

- Rotas públicas: `genesis-api` `gerente.rs` → mining-worker `/v1/gerente/*`
- Guard Node (manager_mode allowlist): `server/bootstrap/app.ts` → `createManagerModeGuard` (ainda no Express residual path se request chegar lá)
- Payout cron: mining-worker loop; Node `startGerentePayoutCron` no-op
- Rotas Express legado: `server/bootstrap/routes.ts` → `registerGerenteModuleRoutes` (não atingidas quando genesis-api owns o path)