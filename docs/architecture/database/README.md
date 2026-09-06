# Dados — Postgres, Redis

## Postgres (Prisma) — fonte de verdade

- Schema único: `prisma/schema.prisma` (em `current/`).
- Migrations: `prisma/migrations/`.
- **Sem `@relation` entre models** (decisão de design explícita no header do
  schema: reduz conflito com tabelas legadas / `db.query` cru; joins são feitos
  via SQL explícito).

Models principais (agrupados por tema, a partir dos nomes):

| Tema | Models |
|---|---|
| Usuário/acesso | `users`, `access_levels`, `user_access_levels` |
| Jogo/estado | `game_states`, `mining_progress_commit_ledger`, `mining_coins` |
| Inventário/economia | `inventory_movements`, `stock`, `upgrades`, `upgrade_compat_racks` |
| Loja | `shop_carts`, `shop_cart_lines`, `shop_checkout_idempotency` |
| Loot/roleta/season | `loot_boxes`, `loot_box_items`, `season_passes`, `season_purchases` |
| Wallet/depósito | `user_deposit_history`, `user_wallet_history`, `profile_wallet_connect_challenges` |
| Social/chat | `chat_messages`, `matches` |
| Referral/parceria | `referrals`, `referral_commission_ledger` |
| Merge | `merge_history`, `merge_settings` |
| Anúncios/news | `in_app_announcements`, `in_app_announcement_reads`, `system_news` |
| Config/admin | `settings`, `profile_audit_log` |

Regras de manutenção (do header do `schema.prisma`):
1. Alterações via Prisma: `npx prisma migrate dev` (preferível).
2. Alterações só em SQL: `npx prisma db pull` + revisar diff antes de commit.
3. `npx prisma generate` após qualquer mudança (`build:app` já inclui).

## MongoDB — removido

O `current/` **não** depende de MongoDB. Writers/readers de
`game_activity_logs` / `action_logs` / `event_history` / `analytics_events`
foram cortados. O painel admin de atividade usa só o que existir em PostgreSQL
(P2P/trades); histórico Mongo antigo não é carregado.

Na VM de teste o contentor `mongodb_app` pode ainda existir na stack
`app_production` — desligar/remover volume é passo operacional **depois** de
validar typecheck/tests/build, não parte do bootstrap da app.

## Redis

- Locks distribuídos: `server/core/redis/lock.ts`.
- Socket.IO adapter / cache conforme `server/core/redis/`.

## Retenção de logs (90 dias)

Aplicada a `profile_audit_log` (prune no tick de backup SQL diário).
**Não** aplicada a ledgers financeiros (`user_wallet_history`, depósitos, etc.)
nem à política de backups SQL. `mining_yield_history` mantém retenção própria
(72h). Logs Docker (`json-file`, max-size/max-file) limitam tamanho, não dias.
