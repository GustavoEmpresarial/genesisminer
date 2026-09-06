# Rust migration (incremental)

Node/Express remains the HTTP/API runtime. Pure domain math moves to Rust **slice by slice**
via `genesis-node` (napi). **Mining engine I/O** (yield cron + progress credit) cutover to
the standalone binary `genesis-mining-worker`.

## Layout

| Crate / path | Role |
|--------------|------|
| `genesis-core` | Pure Rust (no Node). Unit-tested domain rules. |
| `genesis-node` | `cdylib` + napi-rs FFI (JSON in/out for now). |
| `genesis-mining-worker` | **Binário 100% Rust** (Postgres + Redis I/O): yield cron + progress + ranking HTTP. |
| `genesis-hardware` | **Binário 100% Rust** (Postgres I/O): stock / racks persist + intent + credit + adjust HTTP. |
| `genesis-auth` | **Binário 100% Rust** (crypto I/O, sem Postgres): bcrypt + access JWT + Turnstile siteverify + SMTP HTTP. |
| `genesis-api` | **Casco HTTP público** (`app:3000`): cookies auth + download de anexos; resto (SPA / `/img` / `/socket.io`) proxy para Express `:3001`. |
| `native/genesis.node` | Built artifact (gitignored). |
| `server/shared/rust/genesis-native.ts` | Loader + opt-in flags. |
| `server/modules/*/…/*-rust-bridge.ts` | Opt-in bridge per module (TS fallback). |
| `server/modules/mining-engine/services/mining-worker-client.ts` | Thin HTTP client → mining worker. |
| `server/modules/hardware/services/hardware-client.ts` | Thin HTTP client → hardware worker. |
| `server/modules/auth/services/auth-worker-client.ts` | Thin HTTP client → auth worker (fail-closed). |

## Já em produção (flags Compose)

| Fatia | Flag | O que é Rust | O que fica Node |
|-------|------|--------------|-----------------|
| Auth login/registro | `GENESIS_AUTH_RUST=1` + `GENESIS_AUTH_URL` | validação/HMAC/lockout (napi) + **bcrypt + JWT + Turnstile + SMTP** (worker HTTP) | Prisma sessão/refresh, UI |
| Transparência health | `GENESIS_TRANSPARENCY_RUST=1` | `compute_transparency_health` | listagem/admin, Prisma, UI |
| Merge stats | `GENESIS_USE_RUST=1` | rarity / result stats / equivalence | inventário, fees I/O |
| Check-in | `GENESIS_CHECKIN_RUST=1` | dia UTC, grace 48h, freeze | Prisma, rewards, premium I/O |
| Calculator | `GENESIS_MINING_WORKER_URL` | snapshot I/O + assemble **100% Rust** (`POST /v1/calculator/snapshot`) | AI/OpenCode Node |
| Game nav | `GENESIS_NAV_RUST=1` | allowlist + filtros do menu | sessão, i18n, ícones |
| Mining domain math | `GENESIS_MINING_RUST=1` | rede, grelha 10 min, integral yield, history, yield-boundary | residual napi se ainda chamado |
| Mining engine I/O | `GENESIS_MINING_WORKER_URL` | yield cron + `POST /v1/mining/progress` + ranking HTTP | Express chama HTTP; sem URL → TS fallback |
| Ranking I/O | (same URL) | refresh loop + `GET /v1/ranking/{public,me,admin}` | Express delega; Node loop noops |
| Partner Games | `GENESIS_PARTNER_GAMES_RUST=1` | session config + heartbeat gate | Redis last-hb, Kafka publish, Express, UI |
| Market / black-market | `GENESIS_MARKET_RUST=1` | page/tax/reserve helpers + band USD | P2P mutations Prisma, WS |
| Lucky boxes | `GENESIS_LUCKY_BOXES_RUST=1` | independent + grant-all rolls | open/buy tx Prisma; samples from Node RNG |
| Wallet helpers | `GENESIS_WALLET_RUST=1` | desk percent + fraction gates | deposits / on-chain RPC ❌ |
| Header hash agg | `GENESIS_HEADER_RUST=1` | `hashByCoinId` + `totalHash` (general only) | Prisma snapshot I/O; Kafka invalidate já em `genesis.mining.progress` + `genesis.economy.ledger` |
| Shop / hardware write validate | `GENESIS_CATALOG_RUST=1` | parse allowlist + ID regex + identity immutability + protected-row | Prisma replace / OCC / soft-retire ❌ → worker |
| Inventory + rooms persist | `GENESIS_HARDWARE_URL` | credit HTTP (optional `durationAmount`/`durationUnit` override) + **adjust** + **shop/checkout** (USDC+credit+idem one TX) + **merge/execute** (fee+adjust+history one TX) + **intent** (apply+persist+idempotency INSERT no mesmo TX) + **racks-power** (save-servers / room-coins) + **fold-warehouse** (GET credit+delete one TX) + **recall-all** (credit+DELETE racks one TX) + **wipe-user** (item tables) + **catalog/upgrades/replace** (OCC+UPSERT+soft-retire+bump one TX) + persist warehouse→stock keep-list CTE + ensureMounted + semantic-sync + domínio em `genesis-core` | OCC / advisory lock Node (upsert idem após HTTP); P2P listings / reserve / USDC / custody via `/v1/market/*`; streak no-URL leases Node; merge_* catalog revision bump still Node |

## Mapa de migração

Legenda: ✅ domínio Rust em prod (flag Compose) · 🟡 parcial (math / worker / bridge) · ❌ ainda Node / não migrado

| Módulo | Estado | Notas |
|--------|--------|-------|
| Auth (login/signup/tokens) | 🟡 | Math napi ✅; bcrypt+JWT+Turnstile+SMTP → `genesis-auth`; sessão PG/refresh Node |
| Check-in | ✅ | Rewards / premium I/O Node; streak timed item via credit HTTP + duration override when URL set |
| Calculator | ✅ | Snapshot fail-closed Rust |
| Game nav | ✅ | Ícones/i18n client |
| Merge (stats) | ✅ | Inventário/fees via `POST /v1/merge/execute` (worker) |
| Transparência (health) | ✅ | Admin/listagem Node |
| Mining domain math | ✅ | Via napi + worker |
| Mining engine I/O | ✅ | `genesis-mining-worker` |
| Ranking | ✅ | Worker HTTP + Kafka `genesis.ranking.snapshot` |
| Partner Games | ✅ | Config/heartbeat Rust; Redis+Kafka+API Node |
| Market / black-market | ✅ | Domain helpers Rust; mutations Prisma ❌ |
| Wheel / loot odds | ✅ | Lucky-box rolls Rust; open tx Node |
| Offerwall | ❌ | |
| Partners (YouTube) | 🟡 | Video approve UPDATE → `genesis-wallet` `POST /v1/partners/youtube/submissions/approve` (fail-closed); apply/reject/list/avatar ainda Node |
| Wallet / deposits | 🟡 | Desk percent + fraction helpers Rust; deposits/RPC ❌ |
| Player-game header | 🟡 | Hash agg Rust (`GENESIS_HEADER_RUST`); snapshot I/O Node; invalidate Kafka `genesis.mining.progress` + `genesis.economy.ledger` (`notifyMiningProgressHeader` / `notifyEconomyLedgerHeader`) |
| Shop / hardware store | 🟡 | Write validate Rust (`GENESIS_CATALOG_RUST`); admin replace OCC/soft-retire via `POST /v1/catalog/upgrades/replace` (fail-closed URL) |
| Inventory | 🟡 | Domínio `genesis-core::hardware`; credit + adjust + shop/checkout + merge/execute + intent + racks-power + fold-warehouse + recall-all + wipe-user HTTP se URL; persist warehouse→stock keep-list CTE + ensureMounted + semantic-sync; `item_instances` = unit identity; OCC/advisory Node; P2P via `/v1/market/*` |
| Quests | ❌ | Progress bump Node; sem reward inventado no hub |
| Support / tickets | ❌ | Mutations Prisma-heavy (advisory + idempotency + anexos) — adiado |
| Rooms / servers / save | 🟡 | Intent HTTP (idempotency no worker TX) + racks-power (power/coin) se URL; OCC / advisory lock + `game_states` version Node |
| Chat | 🟡 | TTL purge SQL → mining-worker `POST /v1/chat/purge-expired` (fail-closed); Redis lock + disk/socket Node; send/history/socket Node |
| Profile / referral claim | 🟡 | Referral code gen já Rust (auth) |

### Kafka tópicos activos (Compose `kafka-init`)

| Tópico | Uso |
|--------|-----|
| `genesis.auth.events` | auth audit |
| `genesis.mining.progress` | yield/progress invalidate **+ navbar header cache** (`notifyMiningProgressHeader`) |
| `genesis.economy.ledger` | economy invalidate **+ navbar header cache** (`notifyEconomyLedgerHeader`) |
| `genesis.ops.deadletter` | ops |
| `genesis.ranking.snapshot` | ranking invalidate |
| `genesis.partner_games.session` | visit / heartbeat / stop |
| `genesis.market.events` | P2P reserve / buy / sell |
| `genesis.lucky_box.open` | lucky-box open |

## Mining engine (crítico) — fases

Dois modelos (não misturar):

1. **Competitivo** — `effective = max(floor, live, implied, MIN)` (GPU / pool partilhado).
2. **Independente** — floor-only: `max(floor, MIN)` (NFT / `usdc_interno` / `nft_room_only`; ignora live e implied; não partilha rede).

| Fase | Escopo | Estado |
|------|--------|--------|
| 0 | Network math (`network-hashrate`) | ✅ |
| A | wall_clock + epsilon | ✅ |
| B | accrual (integrate / history / consolidate) + yield_boundary | ✅ |
| C | Node host chama Rust math (`progress-computer` + `yield-cron` via napi) | ✅ (legado bridge) |
| D | Worker Rust `genesis-mining-worker` (I/O incluso) | ✅ Compose cutover; HTTP progress em port |

Slot credits / check-in bonus H / NFT predicates: já no `calculator` Rust (partilhado).

### Cutover Compose (prod Hostinger)

Serviço: **`mining-worker`** (`genesisminer-mining-worker`).

| Processo | Env | Efeito |
|----------|-----|--------|
| `mining-worker` | `GENESIS_MINING_WORKER=1`, `NODE_ENV=production`, `SCHEDULER_ENABLED=1`, `MINING_YIELD_*=1`, `DATABASE_URL`, `REDIS_URL`, `MINING_WORKER_PORT=8091`, `MINING_WORKER_AUTH_TOKEN` (from `.env`) | Owns yield tick + progress + ranking HTTP/loop |
| `app` | `MINING_YIELD_SCHEDULER_ENABLED=0`, `MINING_YIELD_CRON_ENABLED=0`, `GENESIS_MINING_WORKER_URL=http://mining-worker:8091`, `MINING_WORKER_AUTH_TOKEN` (same), `GENESIS_MINING_RUST=1` | Não agenda yield/ranking; progress + ranking → worker HTTP |

**HTTP contract** (worker):

- `GET /health` (public — Compose healthcheck)
- `POST /v1/mining/progress` body `{ "userId": N }` → `{ "ok": bool, … }`
- `GET /v1/ranking/public?fresh=`, `GET /v1/ranking/me?userId=&fresh=`, `GET /v1/ranking/admin`, `POST /v1/ranking/refresh`
- `POST /v1/chat/purge-expired` body `{ "nowMs"?, "limit"? }` → `{ "ok", "deleted", "ids", "channels", "audioUrls", "beforeMs" }` (Node cron holds Redis lock; disk/socket stay in Node)
- `POST /v1/calculator/snapshot` body `{ "userId": N, "scope"? }` → `{ "ok", "scope", "scopesUi", "generalPowerHps", "coinComparisons", "coins" }` (403 `FORBIDDEN_SCOPE` / 422 `INVALID_SCOPE`)
- Auth: header `x-mining-worker-token: <MINING_WORKER_AUTH_TOKEN>` (required when `NODE_ENV=production`; empty token in dev → allow + warn once)

**Runtime stats**: worker writes `app_cache.network_stats`; Node calls `hydrateMiningRuntimeStatsFromAppCache(pool)` on admin/catalog/calculator reads when worker URL is set.

**Local / tests**: omit `GENESIS_MINING_WORKER_URL` → Node keeps TS/napi progress + can schedule yield if flags allow.

```bash
# Worker só (dev)
cargo run -p genesis-mining-worker --manifest-path rust/Cargo.toml
# env: DATABASE_URL, REDIS_URL, MINING_WORKER_PORT (default 8091),
#      MINING_WORKER_AUTH_TOKEN (optional in non-prod),
#      MINING_YIELD_CRON_INTERVAL_MS (≥15000, default 120000),
#      SCHEDULER_ENABLED, MINING_YIELD_CRON_ENABLED, MINING_YIELD_SCHEDULER_ENABLED,
#      MINING_WALL_CLOCK_TEN_MIN_GRID, KAFKA_ENABLED / KAFKA_BROKERS
```

Lock Redis partilhado: `genesis:lock:mining_yield_tick` — só um processo (worker **ou** Node) deve ter o scheduler ligado. Cancel/timeout do tick libera o lock via `OwnedYieldTickLock` (Drop).

Kafka: tópicos `genesis.mining.progress` + `genesis.ranking.snapshot` + `genesis.partner_games.session` no Compose Hostinger (`kafka-init`). Mining-worker publica via rdkafka quando `KAFKA_ENABLED=1`. K8s: manifests em `deploy/k8s/` são scaffold.

## Roadmap fácil → difícil

### Fácil (próximas)
1. ~~**Check-in BRT**~~ → **Check-in UTC 00:00 + grace 48h** (`GENESIS_CHECKIN_RUST=1`) ✅
2. Affinity de salas / validators
3. ~~Mining domain math (rede + grelha + accrual + yield boundary)~~ ✅ `GENESIS_MINING_RUST=1`
4. ~~**Partner Games**~~ ✅ `GENESIS_PARTNER_GAMES_RUST=1`
5. ~~Market reserve~~ ✅ `GENESIS_MARKET_RUST=1`
6. ~~Lucky-box rolls~~ ✅ `GENESIS_LUCKY_BOXES_RUST=1`
7. ~~Wallet desk helpers~~ ✅ `GENESIS_WALLET_RUST=1` (deposits still Node)

### Médio
8. ~~**Mining progress math**~~ ✅ (napi + worker I/O)
9. Affinity de salas / validators
10. **Kafka payload schemas** — serializar eventos tipados (broker continua kafkajs no app).

### Difícil (deixar para o fim)
11. ~~**Mining-engine cron worker Rust**~~ → `genesis-mining-worker` (Compose cutover).
12. **Wallet deposits / on-chain** — RPC, receipts, idempotência.
13. **Black-market mutations** — transações + listagens.
14. ~~**Save-game / room persistence**~~ → `genesis-hardware` (Compose cutover; merge mode fecha wipe Grangeiro).
15. **Mining worker K8s** — só com cluster real + domínio estável.

## Regra de ouro

- **Rust** = funções puras + testes unitários; **mining worker** = I/O de motor (DB/Redis/HTTP).
- **Node** = API, UI, SMTP, chain, e fallback TS quando worker URL ausente.
- Sempre bridge opt-in + fallback TS até a fatia estar estável em prod.

## Build

```bash
npm run test:rust
npm run build:rust
cargo check -p genesis-mining-worker --manifest-path rust/Cargo.toml
cargo check -p genesis-hardware --manifest-path rust/Cargo.toml
cargo check -p genesis-auth --manifest-path rust/Cargo.toml
# flags no deploy/docker-compose.yml
```

## Docker

- Stage `rust-builder` → `libgenesis_node.so`, `genesis-mining-worker`, `genesis-hardware`, `genesis-auth` **e** `genesis-api`.
- Target `mining-worker` (debian slim + binary + ca-certs) → serviço Compose `mining-worker`.
- Target `hardware` (debian slim + binary + ca-certs) → serviço Compose `hardware`.
- Target `auth` (debian slim + binary + ca-certs) → serviço Compose `auth`.
- Target `api` (debian slim + binary + ca-certs + curl) → serviço Compose `app` (`genesis-api` :3000).
- Stage final (default) → imagem `express` com `native/genesis.node` (PORT 3001).

### Hardware worker (Compose)

Serviço: **`hardware`** (`genesisminer-hardware`). Sem yield/kafka.

| Processo | Env | Efeito |
|----------|-----|--------|
| `hardware` | `DATABASE_URL`, `MINING_WORKER_PORT=8091`, `MINING_WORKER_AUTH_TOKEN` | Owns persist / intent / credit / adjust / shop/checkout / merge/execute / racks-power / fold-warehouse / recall-all / wipe-user / market HTTP |
| `app` | `GENESIS_HARDWARE_URL=http://hardware:8091`, `GENESIS_HARDWARE_RUST=1`, same auth token | Catalog/streak credit + shop checkout + merge execute + P2P stock + place/equip intent + save-servers/room-coins + inventory GET fold-warehouse → worker; OCC/advisory/`game_states` version Node; intent idempotency INSERT no worker TX |

**HTTP contract** (hardware):

- `GET /health` (public — Compose healthcheck)
- `POST /v1/hardware/persist` body `{ userId, stock?, stockMode, storedBatteries?, placedRacks? }`
- `POST /v1/hardware/intent` body `{ userId, kind, scope, idempotencyKey, requestFingerprint?, … }` — apply+persist+idempotency INSERT no mesmo TX; replay se a row existir
- `POST /v1/hardware/credit` body `{ userId, itemId, qty, durationAmount?, durationUnit? }` — stock UPSERT + timed leases (override cfg when both duration fields present and timed; else catalog) + `item_instances` mint (unit identity; qty stays cache; timed lease id = instance id)
- `POST /v1/hardware/adjust` body `{ userId, debit, credit }` — debit+credit stock in one TX (also used in-process by merge/execute)
- `POST /v1/shop/checkout` body `{ userId, cart, idempotencyKey, clearCartId?, requestFingerprint? }` — USDC + credit + limited + cart + idem one TX
- `POST /v1/merge/execute` body `{ userId, sourceItemId, resultItemId, sourceRarity, resultRarity, feeUnitUsdc, count, debit, credit, historyTimestamps? }` — fee USDC + adjust + merge_history one TX
- `POST /v1/hardware/racks-power` body `{ userId, racks? }` or `{ userId, roomId, coinId }` — power/coin (save-servers / room-coins)
- `POST /v1/hardware/fold-warehouse` body `{ userId, batteryIds }` — GET inventory fold: credit+delete loose IDs in one TX (mounted protected; retry `{ stock: {} }`). Persist keep-list CTE unchanged.
- `POST /v1/hardware/recall-all` body `{}` — admin global recall: credit every rack component + DELETE slots/multis/racks in one TX (`itemsMoved`, `racksProcessed`).
- `POST /v1/hardware/wipe-user` body `{ userId }` — admin delete-user item tables (racks/slots/stock/batteries/leases/idem). Persist after placed_racks UPSERT runs ensureMounted + semantic-sync.
- Auth: header `x-mining-worker-token` (same as mining worker)

**Napi:** não wired nesta fase — `GENESIS_HARDWARE_RUST=1` reserva a flag; domínio + I/O vão pelo HTTP worker.

**Local / tests:** omit `GENESIS_HARDWARE_URL` → Node keeps TS persist/intents (unitários).

### Auth worker (Compose) — bcrypt + JWT + Turnstile + SMTP

Serviço: **`auth`** (`genesisminer-auth`). Sem Postgres; crypto + captcha + mail HTTP.

| Processo | Env | Efeito |
|----------|-----|--------|
| `auth` | `AUTH_WORKER_PORT=8091`, `MINING_WORKER_AUTH_TOKEN`, `JWT_*`, `CLOUDFLARE_TURNSTILE_*`, `MAIL_*`, `FRONTEND_URL`/`PUBLIC_URL`/`SITE_URL` | Owns password/JWT/turnstile/mail routes |
| `app` | `GENESIS_AUTH_URL=http://auth:8091`, same auth token + JWT_* | Login/register/jwt/password/turnstile/mail → worker; **fail-closed** se URL unset |

**HTTP contract** (auth):

- `GET /health` (public — Compose healthcheck)
- `POST /v1/auth/password/hash` `{ password, rounds }` → `{ ok, hash }`
- `POST /v1/auth/password/verify` `{ password, hash }` → `{ ok, match }`
- `POST /v1/auth/jwt/sign` `{ userId }` → `{ ok, token }`
- `POST /v1/auth/jwt/verify` `{ token }` → `{ ok, userId, jti?, exp? }`
- `POST /v1/auth/turnstile/verify` `{ token, remoteip? }` → `{ ok }` (worker owns enabled gate)
- `POST /v1/auth/mail/reset` `{ email, resetToken, validityMinutes? }` → `{ ok }`
- `POST /v1/auth/mail/verify` `{ email, verificationToken, validityHours? }` → `{ ok }`
- Auth: header `x-mining-worker-token` (same as mining/hardware)

**Residual (ainda Node):** sessão PG / refresh rotate / cookies orchestration.

**Deploy:** rebuild imagem (`rust-builder` + target `auth`) + Compose com serviço `auth`.
