# Módulo `checkin`

Check-in diário (UTC) + streak + prémio de máquina no marco de 7 dias.

## Paths

| Camada | Path |
|--------|------|
| HTTP jogador | `GET /api/checkin/status`, `POST /api/checkin` (genesis-api → mining-worker) |
| Admin policies | `GET`/`POST` `/api/admin/checkin-*-policy` (`server/modules/checkin/controllers/`) |
| Math / reward (Node) | `server/modules/checkin/services/` |
| Live perform/status | `rust/genesis-mining-worker/src/player_reads/checkin.rs` |
| Math pura (Rust) | `rust/genesis-core/src/checkin/` |
| Client | `client/src/features/checkin/` |
| Testes | `tests/modules/checkin/` |

## HTTP jogador (live)

| Método | Rota | Worker |
|--------|------|--------|
| `GET` | `/api/checkin/status` | `GET`/`POST` interno `/v1/checkin/status` |
| `POST` | `/api/checkin` | `/v1/checkin/perform` |

Fluxo: genesis-api → mining-worker. O Node `performCheckin` / status são **proxy** para o worker quando o path Rust está activo — o grant da máquina de streak corre **no worker**, após o commit do check-in, via `POST /v1/hardware/credit`.

## Regras de tempo

| Constante | Valor | Notas |
|-----------|--------|--------|
| `CHECKIN_TIMEZONE` | `UTC` | Ciclo civil 00:00 → 00:00+1d |
| `CHECKIN_GRACE_MS` | 48h (`2 * MS_PER_DAY`) | Mineração activa até freeze; streak tolera 1 dia perdido |
| `CHECKIN_REWARD_EVERY_DAYS` | `7` | Marco do prémio de streak (`n % 7 == 0`) |

- Um check-in por dia UTC (idempotente se já fez hoje).
- Streak +1 se o período anterior for o dia UTC imediatamente anterior **ou** com grace de 1 dia perdido.

## Máquina de streak (não confundir com o marco 7)

O **marco** é a cada 7 check-ins (`CHECKIN_REWARD_EVERY_DAYS`). A **duração do lease** da máquina é outra coisa — vem de settings:

| Setting | Papel |
|---------|--------|
| `checkin_streak_reward_enabled` | Liga/desliga o grant |
| `checkin_streak_reward_item_id` | Item (prod: `asic_dolar_f2p`) |
| `checkin_streak_reward_duration_amount` | Tipicamente `45` |
| `checkin_streak_reward_duration_unit` | Tipicamente `day` |

**Prod:** item `asic_dolar_f2p`, lease tipicamente **45 dias**. O “7” do marketing/UI é o ciclo do streak, **não** a validade da máquina.

Grant: após commit do check-in, se `next_streak % 7 == 0` e policy activa → `call_hardware_credit` (qty 1 + duration da policy). Fail-closed: upgrade em falta / type ≠ `machine` / credit falha → `streakRewardGranted=0` + log ERROR (nunca inventa granted=1).

## Bug 2026-09 (resolvido no código)

Durante o path Rust live, a resposta forçava `streakRewardGranted: 0` e **não** chamava hardware credit — o streak subia em `game_states`, mas a lease não era criada.

**Fix:** grant via hardware credit **depois** do commit do check-in (espelho do Node `grantCheckinStreakTemporaryItem`).

Compensação / SOP: ver [incidente 2026-09-17](../../operations/incidents/2026-09-17-checkin-streak-machine.md).

## SOP suporte (suspeita “não recebi a máquina do check-in”)

1. Confirmar streak:

```sql
SELECT user_id, checkin_streak, last_checkin_day, last_checkin_at_ms
FROM game_states
WHERE user_id = <id>;
```

2. Confirmar leases do item de streak (prod `asic_dolar_f2p`):

```sql
SELECT id, item_id, status, acquired_at, expires_at
FROM player_asic_leases
WHERE user_id = <id> AND item_id = 'asic_dolar_f2p'
ORDER BY acquired_at DESC
LIMIT 20;
```

3. Interpretação:
   - `checkin_streak >= 7` **e** sem lease nova perto do último marco → candidato a bug pré-fix / compensação ops.
   - Lease recente com `acquired_at` após ops/fix → já creditado; orientar a equipar no inventário / sala ASIC.

### Tickets exemplo (2026-09)

| Ticket | Email / nick | Notas |
|--------|----------------|--------|
| Check-in | `vinicius.jrc.lara@gmail.com` (SHEIKLES) | Aberto ~16/09/2026 |
| check in diário | `frankdorian13@gmail.com` (dorian att) | Aberto ~15/09/2026 |

Compensação dirigida: userIds `10589` e `12687` — script `scripts/ops/checkin-compensate-streak-tickets-20260917.sh` (hardware credit; **não** INSERT cru em leases).

## Check-in premium

| Regra | Detalhe |
|--------|---------|
| Elegibilidade | Gasto USDC vitalício ≥ `checkin_premium_min_usdc` **ou** `game_states.checkin_premium_unlocked = 1` |
| Fontes de gasto | loja (`shop_checkout_idempotency`), merge (`fee_usdc`), passe, upgrades admin, P2P buyer, wheel |
| Default `min` | `100` USDC (`DEFAULT_CHECKIN_PREMIUM_MIN_USDC` em TS + `genesis-core`) |
| Override | Chave `checkin_premium_min_usdc` em `settings` (admin); se ausente, usa o default |
| 1× na vida | Ao cruzar o limiar, persiste `checkin_premium_unlocked = 1` — permanece para sempre |
| Admin | `POST /api/admin/users/:userId/grant-premium-checkin` — unlock + activa janela agora |
| Cadência | `checkin_premium_interval_days` (default 7) — um check-in premium desbloqueia mineração na janela |
| Recompensas | Path premium mantém H/s semanal + máquina de streak (`maybe_grant_streak_reward`) |
| Missões | `ensure_premium_credit` avança `daily_checkin` + `weekly_checkin` 1×/dia UTC na janela activa; corre em `run_quests_state` **e** no início de `run_checkin_status` (best-effort) |

## Admin

Policies em `settings` via `/api/admin/checkin-reward-policy` e `/api/admin/checkin-premium-policy` (Express `checkin.controller.ts`).

## Ver também

- Incidente + texto suporte: `docs/operations/incidents/2026-09-17-checkin-streak-machine.md`
- Backfill preview: `scripts/ops/checkin-backfill-missed-streak-leases-20260917.sql`
