# Motor de mineração — análise ponta a ponta

Data: 2026-09-09 · branch `feat/mining-usd-month-distribution` (deployed, `origin/main` @ `2b82a2a`)

Cobre: distribuição de blocos, cálculo do yield, crédito de saldo, calculadora e a
animação da navbar. Objetivo: mostrar o que cada peça faz, o que está correto e o
que ainda está errado.

---

## 1. Config da moeda — `mining_coins`

Por moeda:

| campo | uso |
|---|---|
| `distribution_mode` | `legacy` \| `usd_month` |
| `distribution_usd_month` | orçamento USD/mês (só `usd_month`) |
| `price_usd` | preço da moeda (converte orçamento → coins) |
| `block_reward` / `block_time` / `network_hashrate` | fórmula histórica (só `legacy`) |
| `nft_room_only`, símbolo | decide se é **pool independente** (GHO/NFT/usdc_interno) |

Estado atual de produção: **as 18 moedas em `usd_month`**. 9 estão em **$0,01/mês**
(GEMT, GHO_nft, POL, SOL, TRX, USDT_nft, DOGE, DAI, usdc_interno); 8 em valores
reais ($50–$240: BNB, CBBTC, DAI, ETH, SHIB, USDT, WBTC, XRP).

---

## 2. Yield por boundary — a cada 10 min na grade UTC

`yield_tick.rs` → `build_yield_history_rows_for_boundary` (`yield_boundary.rs`).
É o **único** lugar onde `yield_per_hash` nasce.

### 2a. Hashrate ativo real

Varre **todo slot equipado** de **todo rack ligado** (`list_slot_mining_credits`),
soma `effective_base_prod` por moeda → `Σ active_hash`. Grava em
`app_cache.network_stats.hashrates`. É a base do rateio.

### 2b. `usd_month`

```
budget_per_sec  = usd_month / 2_592_000 / max(price, 1)      // coins/segundo p/ a rede toda
divisor         = max(Σ active_hash, 10)                      // DIST_MIN_HASHRATE = 10
yield_per_hash  = 0                     se Σ active_hash ≤ 1   // pool vazia
                = budget_per_sec / divisor   caso contrário
```

Linha em `mining_yield_history`: `yield = yield_per_hash`, `reward = budget_per_sec`,
`network_hashrate = divisor`, `effective_at = boundary_ms`.

Propriedades (travadas por teste):
- **`Σ pago/seg = yield_per_hash × Σ active_hash = budget_per_sec`** exatamente → a
  rede inteira nunca paga mais que `distribution_usd_month` no mês.
- `divisor` com piso 10 ⇒ abaixo de 10 H/s ativos a moeda **sub**-distribui
  (`budget × active/10`), nunca estoura. Direção segura p/ taxa perpétua e p/ replay.
- `active ≤ 1` ⇒ yield 0 (sem disparada quando a pool esvazia).
- orçamento NaN/∞/negativo ⇒ yield 0.

### 2c. `legacy` (inalterado)

```
reward_per_sec = block_reward / block_time
effective_hash = pool independente ? max(floor_admin, 1)
                                   : max(floor_admin, live, implied, 1)
yield_per_hash = reward_per_sec / effective_hash        (0 se sem live e competitiva)
```

---

## 3. Crédito de saldo — por usuário, sob demanda

`progress.rs::compute_progress_locked`.

```
credit_cap = último boundary de 10 min FECHADO         (mining_credit_cap_now_ms)
last       = coin_balances.last_write   (por usuário)
dt         = credit_cap − last , CLAMP em 72 h         (MAX_EARNING_WINDOW_MS)
```

Nada além do último boundary fechado é creditado (sem janela parcial).

Para cada slot equipado / moeda:

```
integrated    = ∫ yield_per_hash dt  sobre [last, credit_cap]
                step-function das linhas de mining_yield_history  (calculate_integrated_yield)
                fallback: fallback_yield × segundos   — só se NÃO houver linha no lookback de 73 h
effective_hash = base_production ATUAL do catálogo (+ bônus check-in, multiplicadores)
                 calculado UMA vez, aplicado no intervalo inteiro
gained        = effective_hash × integrated
```

- `gained` arredondado a 8 casas, somado em `total_gained[coin]`.
- Grava: `coin_balances += total_gained`, `last_write = credit_cap`, **1 linha por
  janela de 10 min** em `mining_block_history`.
- Idempotência tripla: chave `mp:{user}:{from}:{to}` + `mining_progress_commit_ledger`
  + `ON CONFLICT (user_id, coin_id, window_start_ms, window_end_ms) DO NOTHING`.
- `assert_tick_history_matches_economy`: Σ(linhas block_history) tem de bater
  Σ(delta de saldo) por moeda a 8 casas, ou a transação aborta.

---

## 4. Calculadora — projeção (read-only)

`snapshot.rs::compute_snapshot`. Por moeda: `user_power_hps` = Σ `base_production`
equipado dessa moeda.

### `usd_month` (corrigido em `f96b098`)

O trio de exibição é **reconstruído a partir do orçamento** — os campos legados da
linha (`block_reward 0.1`, `network_hashrate 179`…) não são mais a verdade nesse modo:

```
divisor       = max(Σ active_hash, 10)
block_time    = 600
block_reward  = yield_per_hash × divisor × 600      // reward por bloco da rede toda
net_eff       = divisor
```

### `legacy` (inalterado)

`net_eff = effective_network_hashrate_for_coin(...)`, trio direto da linha.

### Comum aos dois

```
daily_coins   = (user_power / net_eff) × block_reward × (86400 / block_time)
daily_usd     = daily_coins × price
projection30  = daily_usd × 30
```

---

## 5. Animação da navbar

- `header.rs`: `estCoinsPerSecByCoinId[coin] = daily_coins / 86400`  (o **mesmo**
  `daily_coins` da calculadora). `liveAccrualAnchorMs = último boundary de 10 min`.
- Cliente (`GameShell.tsx` + `liveCoinBalanceEstimate.ts`): a cada 1 s,
  `exibido = saldo_servidor + coinsPerSec × (agora − âncora)`.  Sem poll, sem WS.
- `formatMinedCoinAmount`: **8 casas** para valores < 1; `exp(2)` abaixo de `1e-8`;
  4 casas para 1–1000.  (o 2º arg de `formatLiveTokenAmount` é morto — formatação é
  função pura do valor.)

### Por que "morreu"

```
coinsPerSec = user_power × usd_month / 2_592_000 / price / divisor
```

GHO_nft, usuário de ~20 H/s:  `20 × 0,01 / 2_592_000 / 1 / 13150 ≈ 5,9·10⁻¹²` coins/s.

Para a 8ª casa andar 1×/segundo é preciso `coinsPerSec ≥ 1·10⁻⁸`. Falta **~1700×**.
A última casa visível levaria ~40 min para mexer → número parado.

Antes de `f96b098`, essa moeda caía no caminho **legacy** com `network_hashrate = 179`
(piso admin morto, não os 13150 reais) e `0.1/600`:
`20/179 × 0,1/600 ≈ 1,9·10⁻⁵` coins/s — visível, subindo ~0,0011/min. **~3000× a
verdade**, e nada disso entrava em `coin_balances` (que acumula sobre o
`mining_yield_history` real). Era o "subindo igual água / saldo do banco parado".

---

## 6. Veredito do audit

| Componente | Estado |
|---|---|
| Yield boundary `usd_month` | ✅ correto — `Σ pago/seg = budget_per_sec` exato (teste trava) |
| Yield boundary `legacy` | ✅ intacto |
| Spike guard (`divisor ≥ 10`) | ✅ só sub-distribui abaixo de 10 H/s, nunca estoura |
| `active ≤ 1 ⇒ yield 0` | ✅ sem disparada quando a pool esvazia |
| Integração `∫` step-function | ✅ correta; usa as linhas reais de histórico |
| Clamp de 72 h da janela | ⚠️ **risco conhecido** (item 7.1) |
| Idempotência (ledger + ON CONFLICT + assert) | ✅ sólida |
| Teto de crédito = último boundary fechado | ✅ sem crédito de janela parcial |
| Calculadora `usd_month` | ✅ corrigida em `f96b098` (usava campos legados mortos) |
| Calculadora `legacy` | ✅ intacta |
| Ticker da navbar | ✅ agora verdadeiro; "parado" porque os orçamentos são $0,01/mês |

---

## 7. Defeitos reais (só 2)

### 7.1. Repagamento retroativo de 72 h ao editar H/s no catálogo — **NÃO corrigido**

`effective_hash` no crédito vem do `base_production` **atual** e é aplicado sobre
**toda** a janela atrasada (até 72 h). Trocar o H/s de uma máquina no catálogo
**repaga até 72 h de backlog na taxa nova**. Foi o que gerou as 23 janelas a 100× do
ElonMuskBR (Mítico 2→200 H/s enquanto janelas 17:30–19:50 ainda estavam sem crédito).

Não é só NFT — vale para qualquer edição de poder com qualquer usuário que tenha
backlog.

**Correção certa:** versionar `base_production` no tempo e fatiar o `integrated` por
boundary usando o poder vigente em cada um. Exige schema novo.
**Correção barata (imediata):** baixar `MAX_EARNING_WINDOW_MS` de 72 h para 1–2
boundaries (10–20 min). Uma edição de catálogo passaria a repagar no máximo 10–20 min
em vez de 3 dias. Efeito colateral: quem ficar >20 min sem abrir o jogo perde o
excedente do backlog (hoje o teto é 72 h).

### 7.2. Orçamentos em $0,01/mês — **config, não código**

Faz todo ticker e toda projeção darem ~zero. É o piso de monitoramento que você
pediu ("0.01 em cada moeda"). Não há bug; é só o valor.

---

## 8. Alavanca para a animação voltar (só config, sem deploy)

Para o ticker de uma moeda mexer visivelmente (8ª casa / segundo) para um dono com
`H` de hash:

```
distribution_usd_month  ≥  1e-8 × 2_592_000 × price × divisor / H
```

| Moeda | price | divisor (ativo real) | $/mês p/ 20 H/s mexer | $/mês p/ 200 H/s |
|---|---|---|---|---|
| GHO_nft | ~1 | ~13 150 | **$17/mês** | $1,70/mês |
| USDT_nft | ~1 | ~54 | **$0,07/mês** | $0,007/mês |
| GEMT | 0,05 | ~965 | **$0,06/mês** | $0,006/mês |
| usdc_interno | 1 | ~99 900 | **$130/mês** | $13/mês |
| SOL | 103 | ~25 000 | **$3 200/mês** | $320/mês |

(SOL/ETH ficam caros porque `price × divisor` é enorme — cada "tick" de SOL vale
muito.) Isso é só o limiar de *visibilidade*; o total distribuído continua sendo
exatamente `distribution_usd_month`.

Comando: `UPDATE mining_coins SET distribution_usd_month = <valor> WHERE id = <id>;`
— efeito no próximo boundary de 10 min, sem deploy.
