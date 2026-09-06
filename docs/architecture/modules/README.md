# Inventário de módulos — backend legado

Levantamento em `legacy/backend/` (exclui `node_modules/`, `dist/`).
Objetivo: mapa completo antes de migrar para `current/backend/src/modules/`.

## 1. `backend/modules/<dominio>/` — já modularizado (28 domínios)

Padrão parcial: `*.controller.ts` + `*.service.ts` (+ `*.types.ts`,
`index.ts` quando existe). Inconsistente entre pastas.

- `account-manager/` — legado; em `current/` vive como [`gerente/`](./gerente.md) (HTTP `/api/account-manager/*` inalterado)
- `admin/suspiciousEmails/` — subpasta própria dentro de admin
- `batteries/` — bulk, catalog(.js+.ts duplicado), constants, controller, integrity, recovery, repository, service, validation(.js+.ts duplicado), invariant.service, semanticSync, index.ts
- `black-market/` — controller, listings.service, query, snapshot.service, types, index.ts
- `chat/` — auth, controller, service, socket
- `checkin/` — controller, errors, premiumPolicy, rewardPolicy, reward, service
- `dashboard/` — controller, service, types
- `email-verification/` — controller, service, index.ts
- `guide/` — controller, service
- `announcements/` — controller, service, types
- `inventory/` — index.ts, audit, controller, snapshot.service, stockAudit, types
- `login/` — index.ts, controller, register
- `lucky-boxes/` — index.ts, controller, idempotency, state.service, types
- `merge/` — constants, controller, service, settings, stats
- `partners/` — applyService, playerController, profileService, stateService, submitService, youtubeUrl
- `profile/` — audit.service, identity.service, password.service, playerController, referralBind.service, referralOverview.service, state.service, walletHistory.service, wallet.service
- `quests/` — controller, period, service, types
- `roadmap/` — controller, service
- `servers/` — index.ts, controller, rackAuxIntent.controller, rackAuxIntent.service, snapshot.service, types
- `shop/` — index.ts, cart.service, catalog, checkout.service, controller, productRules, snapshot.service, types
- `support/` — attachmentsProxy, playerController, state.service
- `upgrades/` — catalog, playerController, purchase.service, state.service
- `wallet/` — deskPercent, exchangeLiquidation, locks, playerController, withdrawRequest, withdrawSchema
- `wheel/` — playerController

**Duplicatas `.js`/`.ts` a limpar** (provável leftover de build antigo comitado):
`batteries.catalog.js`+`.ts`, `batteries.validation.js`+`.ts`.

## 2. `backend/src/auth/` — feature isolada fora do padrão modules

`config.ts`, `cookies.ts`, `httpAuth.ts`, `index.ts`, `jwtService.ts`,
`refreshTokenStore.ts`, `storageMirror.ts`. Deveria virar `modules/auth/` na
reestruturação.

## 3. `backend/controllers/` — estilo antigo, flat (14 arquivos)

`adminMiningDistribution`, `adminReferral`, `adminSecurityBulk`,
`adminUserAudit`, `backup`, `deviceFingerprintAdmin`, `imageAsset`,
`inventory` (duplica `modules/inventory`?), `lootBox`, `p2pMarket`,
`partnerYoutube`, `playerCalculator`, `promoRedeem`, `roleta`,
`supportMutation`, `supportTicket`, `zeradsCallback (agora `modules/offerwall`)`, `index.ts`.
Maioria parece ser **admin** ou features que nunca migraram para `modules/`.

## 4. `backend/models/` — estilo antigo, acesso a dados direto (22 arquivos)

`adminUpgradeGrant`, `auth`, `backup`, `connection`, `deviceFingerprint`,
`imageAsset`, `index.ts`, `lootBox`, `p2pMarket`, `partnerYoutube`,
`profilePasswordPolicy`, `profileUsernameReserved`, `promoCodeRoleta`,
`promoRedeem`, `referralCommission`, `registrationValidation`,
`roletaDbTypes`, `roleta`, `signupPolicy`, `supportMutation`,
`supportTicket`, `user`, `userPutCoreTransaction`, `wheelIdempotency`.

## 5. `backend/lib/` — utilitários de domínio, flat (~40 arquivos)

Mistura de: helpers puros (`safeText`, `logThrottle`, `rpcBackoff`,
`redisDistributedLock`, `sqlTransaction`), coisas específicas de domínio que
deveriam estar dentro de um módulo (`checkinBonusHash`, `nftRoomMining`,
`upgradeRackCompat`, `walletDeskPercent`-like, `depositReceipt`,
`withdrawalHistoryShape`), e duas subpastas suspeitas: `genesisStack/` e
`stack/` (checar se são duplicadas — ver `PROJECT_OVERVIEW.md` pendências).
Também tem duplicatas `.js`+`.ts`: `depositHistoryBackfill`,
`depositHistoryShape`, `depositReceipt`, `legacyTempStock`,
`stockPurgedRemap`, `upgradeCatalogShape`, `userDepositHistory`,
`withdrawalHistoryShape`, `miningLivePrices` (só `.js`+`.d.ts`), `nftRoomMining`,
`publicAssetUrl`.

## 6. `backend/services/` — estilo antigo (6 arquivos)

`adminMiningDistribution`, `adminUserAccountTrace`, `adminUserInventoryAudit`,
`inventorySnapshotService` (duplica `modules/inventory/inventory.snapshot.service.ts`?),
`playerCalculatorService`, `playerStateSnapshot.service`.

## 7. `backend/cron/` — jobs agendados (8 arquivos)

`accountManagerPayoutCron`, `chatTtlCron`, `emailCampaignCron`,
`inactiveAutoBlockCron`, `miningDistributionRollupCron`,
`miningGlobalStatsStore`, `miningNumeric`, `miningProgressComputer`,
`miningRuntimeStats`, `miningScheduler`, `miningWallClockGrid`,
`miningYieldCron`. Ver [../../operations/cron/README.md](../../operations/cron/README.md).

## 8. `backend/workers/` — BullMQ (1 arquivo)

`bullGenesisWorker.ts`. Ver [../../operations/workers/README.md](../../operations/workers/README.md).

## 9. `backend/utils/`, `backend/validation/`, `backend/config/`, `backend/types/`

- `utils/` (12): auth helpers, CORS, mailer, turnstile, client IP, threat observer, VPN guard.
- `validation/` (3): `inAppAnnouncementValidation`, `lootBoxValidation`, `roletaValidation`.
- `config/` (9): `database`, `db`, `initDb`, `pgDump`, `pgRestore`, `postgresCliPaths`, `prisma`, `psql`, `uiDisplayLabelKeys`.
- `types/` (3): augments de Express e WS.

## 10. Entrada e testes

- `backend/server.ts` → compila para `server.js` — bootstrap único (rotas, middlewares, Prisma, Mongo, Redis, Socket.IO). Candidato a virar `src/app/*` na reestruturação.
- `backend/test/` — ~90 arquivos vitest, cobrindo majoritariamente `lib/`, `models/`, `modules/*`.

## Próximo passo de migração (proposto)

Ordem sugerida por menor acoplamento primeiro: `lib/` (utils puros) →
`utils/`/`validation/`/`config/` → módulos já modularizados (só realinhar
padrão) → `controllers/`+`models/`+`services/` soltos (fundir dentro do
módulo de domínio correspondente) → `src/auth` → `server.ts` vira `src/app/`.
