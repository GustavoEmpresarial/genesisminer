# NFT Pool V3 — consolidação em `nft_pool_v3_comum` + dobrar rendimento

Data: 2026-09-08. Plano completo: `~/.claude/plans/mighty-wandering-pie.md`.

## Objetivo

- Aposentar **`nft_pool_v3_incomum` ($10, ×1), `nft_pool_v3_raro` ($20, ×2), `nft_pool_v3_epico`
  ($40, ×4), `nft_pool_v3_lendario` ($100, ×10)** → todos viram **`nft_pool_v3_comum`**
  ("NFT POOL-V3", $10, 10 H/s). Multiplicador = `base_cost_antigo / 10`.
- **Não** reequipar: as unidades convertidas ficam no **inventário** (`stock`), o jogador reequipa.
- Dobrar o rendimento (GHO_nft): `mining_coins.block_reward` `0.1 → 0.2` (id `6529d347-…`).
- **Fora de escopo (intactos):** `nft_pool_v3_mitico`, `nft_baleuidos`, `nft_hodl_bitcoin`,
  `nft_only_miner`.

## Modelo de dados (validado em prod 2026-09-08)

Autoritativo: `player_asic_leases` (1 linha/instância) + `stock (user_id,item_id,qty)` (qty solta,
lida pela tela de inventário) + `rack_slots` (equipados / fonte do yield). `item_instances` é espelho
derivado das leases (`reconcile_stock_instances_to_qty` em `rust/genesis-hardware/src/instances.rs`) —
mantido consistente aqui na mesma TX. `player_machines` **não é lida por código nenhum** — sync
best-effort só p/ higiene.

Consts: separador do `code` = `:` · `expires_at = acquired_at + 126144000000` (4 anos) ·
status terminal: lease `expired`, instance `consumed` · unequip de `rack_slots` = `SET …=NULL`.

Totais esperados: **564** unidades `nft_pool_v3_comum` a cunhar, **25 usuários**
(incomum 70×1 + raro 52×2 + epico 35×4 + lendario 25×10).

## Como rodar (tudo via VM, Postgres = container `postgres_app`, DB `minestation`)

`run.sh` encapsula `ssh … docker exec -i postgres_app psql -U postgres -d minestation`.
Credenciais da VM: `../../vm-credentials.txt` (host 177.7.47.139:2222).

### Ordem

| # | passo | comando | reversível |
|---|---|---|---|
| 0 | **Levantamento INICIAL** | `./run.sh survey.sql -v phase=initial > out/survey-initial.txt` | (read-only) |
| 1 | Backup | `./run.sh backup.sql` | drop das `*_bak_nftv3` |
| 2 | (opcional) pré-limpeza sombra | `./run.sh preclean.sql` | — |
| 3 | **Catálogo** (aposenta os 4) | `./run.sh stage1-catalog.sql` | `bak_nftv3` → re-`UPDATE`/`POST /api/upgrades` |
| 4 | Migração DRY-RUN | `./run.sh migrate-holdings.sql -v dry_run=1 > out/migrate-dryrun.txt` | (rollback automático) |
| 5 | revisar o dry-run (diffs por usuário) | — | — |
| 6 | **Migração APPLY** | `./run.sh migrate-holdings.sql -v dry_run=0 > out/migrate-apply.txt` | `./run.sh rollback-holdings.sql` |
| 7 | **Rendimento** GHO_nft | `./run.sh stage3-yield.sql -v k=<n>` (ver survey [8] p/ o k) | `block_reward` de volta p/ 0.1 |
| 8 | **Levantamento FINAL** | `./run.sh survey.sql -v phase=final > out/survey-final.txt` | (read-only) |
| 9 | **Verificação** (diff vs backup) | `./run.sh verify.sql > out/verify.txt` | — |

Janela: site já em manutenção no domínio principal. **Pausar o mining-worker** antes do passo 3
(`docker stop genesisminer-mining-worker`) e religar depois do passo 7
(`docker start genesisminer-mining-worker`).

### Comparar inicial × final
`diff out/survey-initial.txt out/survey-final.txt` — as seções "TIERS APOSENTADOS" devem zerar, a
seção "SOBREVIVENTE nft_pool_v3_comum" deve subir +564, e todas as reconciliações continuam PASS.

## ⚠️ `network_hashrate` da GHO_nft está CONGELADO

`scripts/ops/fix-gho-nft-network-floor-20260831.sql` recalcula `network_hashrate` = soma do
`base_production` equipado que paga GHO_nft. Depois desta consolidação essa soma **cai** (tiers saem
da sala, as 564 comuns ficam no inventário). **NÃO re-rodar aquele script para a GHO_nft** — o piso
despencaria e o rendimento explodiria. Manter `network_hashrate = 179` fixo.
