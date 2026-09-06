# Cron jobs (legado)

`legacy/backend/cron/` — 12 arquivos, compilados via `tsconfig.cron.json`
separado do resto do server (`build:cron`).

| Job | Responsabilidade (pelo nome) |
|---|---|
| `accountManagerPayoutCron` | payout semanal de comissão de account manager → **migrado** para `server/modules/gerente/services/payout-cron.ts` (`startGerentePayoutCron`, poll horário + catch-up de semanas UTC fechadas) |
| `chatTtlCron` | expiração/limpeza de mensagens de chat |
| `emailCampaignCron` | disparo de campanhas de e-mail agendadas |
| `inactiveAutoBlockCron` | bloqueio automático de contas inativas |
| `miningDistributionRollupCron` | rollup de distribuição de mineração |
| `miningGlobalStatsStore` | persistência de estatísticas globais de mineração |
| `miningNumeric` | cálculo numérico de mineração (helper, não é job em si — confirmar) |
| `miningProgressComputer` | cálculo de progresso de mineração |
| `miningRuntimeStats` | estatísticas em runtime |
| `miningScheduler` | orquestrador/agendador principal dos jobs de mineração |
| `miningWallClockGrid` | grid de tempo real (wall clock) para ticks de mineração |
| `miningYieldCron` | cálculo de yield/rendimento |

## Produção (`current`)

Jobs activos no processo `app` via `server/bootstrap/schedulers.ts`
(`startBackgroundSchedulers`): backup SQL, chat TTL, ranking refresh (noop se
worker URL set), idempotency purge, **gerente payout**. Yield + progress +
ranking I/O: contentor `mining-worker`.

## Pendente (legado)
- [ ] Confirmar quais dos restantes arquivos acima são jobs vs helpers.
- [ ] Mapear frequência de cada cron legado ainda não migrado.
