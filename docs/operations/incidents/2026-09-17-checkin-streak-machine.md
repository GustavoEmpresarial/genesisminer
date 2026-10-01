# Incidente: máquina do check-in (streak) não creditada (2026-09-17)

## Resumo

Jogadores com streak alto (marcos 7/14/21…) não recebiam a máquina temporária do check-in. O streak em `game_states` avançava; a lease `asic_dolar_f2p` não era criada.

## Causa raiz

Path live: `POST /api/checkin` → genesis-api → mining-worker `run_checkin_perform`.

O worker **forçava** `streakRewardGranted: 0` e **não** chamava `/v1/hardware/credit`. O grant Node (`grantCheckinStreakTemporaryItem`) existia, mas o perform só fazia proxy Rust.

## Fix (código)

Grant após commit do check-in via hardware credit (policy `checkin_streak_reward_*`, item prod `asic_dolar_f2p`, duração tipicamente 45d — **não** confundir com o marco de 7 dias).

Docs de módulo: `docs/architecture/modules/checkin.md`.

## Compensação tickets (vinicius / frank)

| User | Script |
|------|--------|
| `10589`, `12687` | `scripts/ops/checkin-compensate-streak-tickets-20260917.sh` |

- **Não** fazer `INSERT` cru em `player_asic_leases` / `stock` (dessincroniza hardware).
- Creditar só via `POST /v1/hardware/credit` na rede Docker (`genesisminer-hardware`).
- Idempotência: o script recusa credit se já existir lease `asic_dolar_f2p` com `acquired_at` na última hora (`MS_PER_HOUR`).
- **Correr uma vez** na VM após deploy do fix (este repo **não** executa na VM).

Backfill em massa (preview / listagem): `scripts/ops/checkin-backfill-missed-streak-leases-20260917.sql` + crédito com `scripts/ops/checkin-backfill-missed-streak-leases-20260917.sh`.

## SOP suporte

```sql
SELECT user_id, checkin_streak, last_checkin_day
FROM game_states WHERE user_id = <id>;

SELECT id, acquired_at, expires_at, status
FROM player_asic_leases
WHERE user_id = <id> AND item_id = 'asic_dolar_f2p'
ORDER BY acquired_at DESC LIMIT 10;
```

Tag ops humana: `20260917-checkin-streak` (o endpoint de credit não grava meta; validar por `acquired_at` pós-script).

## Texto curto para tickets (PT — copiar/colar)

```
Olá! Sobre a máquina do check-in (prémio a cada 7 dias de sequência):

Houve um bug no path de check-in em que a sequência era registada mas a máquina temporária (ASIC Dólar F2P, validade tipicamente 45 dias) não era creditada. Já corrigimos o sistema.

Compensámos a tua conta com 1 máquina. Confirma no inventário / sala de ASICs. Se não aparecer em alguns minutos, responde neste ticket com o teu user id.

Obrigado pela paciência.
```
