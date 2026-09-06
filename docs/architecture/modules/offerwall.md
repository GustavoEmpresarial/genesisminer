# Módulo `offerwall`

Offerwall de PTC via provider **ZERads**. HTTP legado preservado; pasta de domínio renomeada de `zerads` → `offerwall`.

Ver também [DECISIONS.md #116](../DECISIONS.md).

## Paths

| Camada | Path |
|--------|------|
| Server | `server/modules/offerwall/` |
| Client UI | `client/src/features/offerwall/` |
| Client API | `client/src/shared/api/zerads.ts` (não mover) |
| Testes | `tests/modules/offerwall/` |

## Layout (server)

```
server/modules/offerwall/
  index.ts
  controllers/offerwall.controller.ts
  services/
    constants.ts      # rate limits, bucket 60 min, split, caps, regex
    callback.ts       # crédito USDC + idempotência
    callback-log.ts   # audit log append-only
    token.ts          # token opaco + stats
```

## HTTP (inalterado)

| Método | Rota | Notas |
|--------|------|--------|
| `GET`/`POST` | `/zeradsptc.php` | Callback público ZERads |
| `GET` | `/api/zerads/me/token` | Token + URL PTC do jogador |
| `GET` | `/api/zerads/me/stats` | Totais + recentes |

## Fluxo

1. Jogador obtém token opaco (`/me/token`) e abre URL PTC ZERads.
2. ZERads chama `/zeradsptc.php` com `pwd`, `user` (token), `amount` (ZER), `clicks`.
3. Validação: password timing-safe, whitelist IP, token → user, caps.
4. `creditZeradsCallback`: conversão ZER→USDC, split 80/20, ledger idempotente (bucket **60 min**), crédito `game_states.usdc`.
5. Quest bump `offerwall` + log de callback.

## Economia / regras

| Regra | Valor |
|-------|--------|
| Idempotência | bucket **60 min** (`ZERADS_IDEMPOTENCY_BUCKET_MS`) |
| Taxa default | `0.013` USDC por ZER (`ZERADS_ZER_TO_USDC`) |
| Split user | `0.8` (`ZERADS_USER_SPLIT`) |
| Cap amount | `1000` ZER (`ZERADS_MAX_AMOUNT_ZER`) |
| Rate limit callback | 60/min |
| Rate limit me/* | 10/min |

## Env

`ZERADS_CALLBACK_PASSWORD`, `ZERADS_ALLOWED_IPS`, `ZERADS_ALLOW_EMPTY_IP_WHITELIST`, `ZERADS_REQUIRE_CF`, `ZERADS_ZER_TO_USDC`, `ZERADS_USER_SPLIT`, `ZERADS_MAX_AMOUNT_ZER`, `ZERADS_REF_ID`.

## Prisma

`zerads_user_tokens`, `zerads_earnings_ledger`, `zerads_callback_log` (nomes de tabela preservados).

## Wiring

`server/bootstrap/routes.ts` → `registerOfferwallModuleRoutes`.
