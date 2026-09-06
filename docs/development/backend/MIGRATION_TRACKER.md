# Tracker de migração — backend legado → `current/server`

Checklist por peça. Marcar `[x]` só quando o arquivo novo existir E compilar/testar.
Ordem: `core/` e `shared/` primeiro (fundação), depois `modules/` por domínio.

## `server/core/` + `server/shared/` (fundação) — ✅ completa

- [x] `core/database/prisma.ts` ← `config/prisma.ts`
- [x] `core/database/pool.ts` ← `config/db.ts` + `config/database.ts`
- [x] `core/mongo/client.ts` ← `lib/genesisStack/init.ts` (metade Mongo)
- [x] `core/mongo/logs.ts` ← `lib/mongoLogs.ts`
- [x] `core/redis/client.ts` ← `lib/genesisStack/init.ts` (metade Redis)
- [x] `core/redis/lock.ts` ← `lib/redisDistributedLock.ts` + `lib/stack/redisLock.ts` (**consolidado**: eram 2 implementações/2 conexões, agora 1)
- [x] `core/logger/throttle.ts` ← `lib/logThrottle.ts`
- [x] `shared/errors/http-controlled-error.ts` ← extraído de `utils/apiErrorResponse.ts`
- [x] `shared/errors/prisma-errors.ts` ← `utils/prismaHttpResponse.ts`
- [x] `shared/http/error-response.ts` ← `utils/apiErrorResponse.ts` (resto)
- [x] `bootstrap/env.ts` ← `utils/loadEnv.ts`
- [x] `core/http/client-ip.ts` ← `utils/clientIp.ts`
- [x] `core/http/cors.ts` ← `server.ts` (bloco CORS inline, extraído)
- [x] `core/http/csp.ts` ← `server.ts` (bloco helmet/CSP inline — **removido** `frame-src: blockminer.space`, ver DECISIONS.md #3)
- [x] `core/http/rate-limit.ts` ← `server.ts` (limiter global `/api`; limiters de auth/signup/password-reset vão no módulo `auth`)
- [x] `core/socket/client.ts` ← `lib/stack/stackIoSingleton.ts`
- [x] `core/socket/attach.ts` ← `lib/stack/socketIoServer.ts` (**desacoplado** de `modules/chat`, ver DECISIONS.md #4)
- [x] `shared/security/auth-flow-secret.ts` ← `utils/authFlowSecret.ts`
- [x] `shared/security/cloudflare-turnstile.ts` ← `utils/cloudflareTurnstile.ts`
- [x] `shared/security/mailer.ts` ← `utils/mailer.ts` (dedupe do template HTML entre reset/verificação)
- [x] `shared/security/signup-proxy-vpn-guard.ts` ← `utils/signupProxyVpnGuard.ts`
- [x] `shared/utils/safe-text.ts` ← `lib/safeText.ts`
- [x] `shared/utils/rpc-backoff.ts` ← `lib/rpcBackoff.ts`
- [x] `shared/utils/sql-transaction.ts` ← `lib/sqlTransaction.ts`
- [x] `shared/utils/time.ts` — novo (não existia no legado), fonte única de conversão ms/min/hora
- [x] ~~`shared/blockchain/rpc-providers.ts`~~ — **removido**, código morto (ver Notas de decisão)

### Adiado de propósito (não é esquecimento)
- `auth middleware` (JWT/sessão) — entra junto com o módulo `modules/auth`
- `modules/chat/chat.socket.ts` — registra via `attachSocketIo(server, onConnect)` quando `chat` migrar
- `shared/blockchain/` — só quando `modules/wallet` migrar (`depositReceipt.ts`, não `ethersPolygon.ts`)
- `shared/validation/` — decisão: fica vazio, validação de domínio vai dentro de cada módulo
- `core/database/pgCliSpawnOptions` — vai para `modules/admin/backup`
- `bootstrap/app.ts` + `routes.ts` + `index.ts` — só fazem sentido com pelo menos 1 módulo de rota real montado

## `server/modules/` (por domínio)

Lista completa de origem em [../../architecture/modules/README.md](../../architecture/modules/README.md)
e mapeamento pasta-a-pasta em `../../../ESTRUTURA.txt`.

- [x] `modules/auth/config.ts` ← `src/auth/config.ts`
- [x] `modules/auth/cookies.ts` ← `src/auth/cookies.ts`
- [x] `modules/auth/jwt-service.ts` ← `src/auth/jwtService.ts`
- [x] `modules/auth/refresh-token-store.ts` ← `src/auth/refreshTokenStore.ts`
- [x] `modules/auth/storage-mirror.ts` ← `src/auth/storageMirror.ts` (**simplificado**: sem o hack de detecção `src/` vs `dist/` de `lib/backendRoot.ts` — caminho de `storage/` agora é fixo, possível porque `current/` nunca importa de `dist/`, ver DECISIONS.md #1)
- [x] `modules/auth/http-auth.ts` ← `src/auth/httpAuth.ts`
- [x] `modules/auth/index.ts` ← `src/auth/index.ts`
- [x] `server/types/express.d.ts` ← `types/express-augment.d.ts` + `types/express-auth.d.ts` (**consolidado**: os 2 arquivos do legado tinham `userId` com tipo divergente — `string|number` vs `number` — unificado em `number`, que é o que o middleware de fato usa)
- [x] `modules/auth/login-controller.ts` ← `modules/login/login.controller.ts`
- [x] `modules/auth/repository.ts` ← `models/authModel.ts`
- [x] `modules/auth/super-admin.ts` ← `utils/legacySuperAdmin.ts` (**achado + removido por decisão explícita do usuário**: e-mail hardcoded promovendo conta a super-admin automaticamente no boot do servidor — ver DECISIONS.md #6. `current/` não tem essa allowlist nem a escrita automática (`ensureAdminSuperAdminSchema`, não portado); só a coluna `is_super_admin` do banco conta)
- [x] `modules/auth/referral-code.ts` ← `models/signupPolicy.ts`
- [x] `modules/auth/login-validation.ts` ← `models/registrationValidation.ts` (só as 3 funções de login; validação de cadastro fica pro lote do `register.ts`)
- [x] `modules/auth/email-verification-flags.ts` ← `modules/email-verification/emailVerification.service.ts` (só as 2 funções puras usadas no login; fluxo de envio/confirmação migra depois como módulo próprio)
- [x] `modules/auth/register-controller.ts` ← `modules/login/login.register.ts` (`PUT /api/user`, **separado em `POST /api/register`** — decisão do usuário: o legado misturava cadastro público + edição de perfil autenticada + limpeza de sala de streamer no mesmo handler. `PATCH /api/profile` fica pro `modules/profile/`; limpeza de streamer vai pro `modules/servers/`)
- [x] `modules/auth/signup-validation.ts` ← `models/registrationValidation.ts` (parte de cadastro: domínio de e-mail, username, senha, referral, wallet opcional)
- [x] `modules/auth/password-policy.ts` ← `models/profilePasswordPolicy.ts` (só `validatePasswordStrengthPolicy`)
- [x] `modules/auth/user-creation.ts` ← `models/userModel.ts` (**achado**: `executeUserPutCoreTransaction` do legado também creditava recompensa de referral pra quem indicou + histórico de wallet — não portado, decisão do usuário. `referred_by` é gravado no registro mas o crédito ao indicador fica `TODO` até `modules/wallet`/`modules/profile` migrarem, ver DECISIONS.md)
- [x] `modules/auth/device-fingerprint.ts` ← `models/deviceFingerprintModel.ts` (só sanitize + insert; `listDeviceFingerprintLogs` é admin, fica pra depois)
- [x] `modules/auth/email-verification.ts` ← `modules/email-verification/emailVerification.service.ts` (substituiu `email-verification-flags.ts`; token assinado + envio + flags. Fluxo de *confirmação* ainda não migrou)
- [x] `modules/profile/` ← `modules/profile/*.service.ts` + `profilePlayer.controller.ts` (todos os 9 arquivos do legado). Estrutura final: `controllers/` (profile, referral, wallet), `services/` (9), `index.ts` — sem `models/` próprio (módulo não tinha uma camada de dados dedicada no legado como `authModel.ts`; acesso a Prisma fica embutido nos services, igual ao legado; ver nota abaixo). **Revisão** (DECISIONS.md #66): bloqueio nas rotas; races referral/wallet/username.
  - `services/reserved-username.ts` ← `models/profileUsernameReserved.ts`
  - `services/audit.ts` ← `profileAudit.service.ts`
  - `services/identity.ts` ← `profileIdentity.service.ts`
  - `services/password.ts` ← `profilePassword.service.ts` (+ `validateProfileNewPasswordStrength` voltou pra `modules/auth/services/password-policy.ts`, de onde tinha ficado faltando)
  - `services/referral-bind.ts` ← `profileReferralBind.service.ts` (**simplificado + achado**: legado usava `executeUserPutCoreTransaction` pra isso — mesma economia já identificada em `auth`; além do crédito, também inseria a linha em `referrals`, que agora não é inserida — o referrer não vai ver esse vínculo até essa lógica migrar. **Também achado**: o `catch` de "regra anti-fraude por IP" do legado era código morto — `clientIpReferral` era um parâmetro nunca lido dentro da transação)
  - `services/referral-overview.ts` ← `profileReferralOverview.service.ts` (read-only, portado sem corte)
  - `services/wallet.ts` ← `profileWallet.service.ts` (challenge/verify assinatura Ethereum via `ethers.verifyMessage`, sem custódia de chave)
  - `services/wallet-history.ts` ← `profileWalletHistory.service.ts` (só a parte do jogador; `fetchAdminWalletHistoryReport` fica pro `modules/admin/`)
  - `services/state.ts` ← `profileState.service.ts` (**corte de escopo**: o "bundle" de season passes/loot boxes/taxa de notícia — `lib/meBundlesPayload.ts` → `lib/publicBootstrapPayload.ts`, 473 linhas cruzando `shop`/`season-pass`/`loot-box` — não portado. Campos `badges`/`bundle` fora do payload; `GET /api/profile/badges` não migrou por depender só disso)
  - Upgrade de dependência: `express-rate-limit` `^7.4.0` → `^8.6.2` (achado: legado usa `ipKeyGenerator`, só existe a partir da v8; nossa versão fixada originalmente não tinha)
- [x] `modules/checkin/` ← `modules/checkin/checkin.controller.ts` + `checkin.service.ts` + `checkinErrors.ts` + `checkinPremiumPolicy.ts` + `checkinRewardPolicy.ts` + `checkinReward.ts`. Estrutura: `controllers/checkin.controller.ts`, `services/` (errors, premium-policy, reward-policy, reward, checkin), `index.ts`. **Revisão pós-migração** (DECISIONS.md #54): bloqueio em status/perform, `grantCheckinInventoryItem` com qty honesta (N inserts), docs do streak lease alinhados com #50.
  - `services/errors.ts` ← `checkinErrors.ts` (verbatim)
  - `services/premium-policy.ts` ← `checkinPremiumPolicy.ts` (verbatim; usa o novo `shared/settings/settings-repository.ts`)
  - `services/reward-policy.ts` ← `checkinRewardPolicy.ts` (verbatim; usa o novo `shared/utils/lease-duration.ts` em vez de `lib/asicLease.ts`)
  - `services/reward.ts` ← `checkinReward.ts` completo — `grantCheckinStreakTemporaryItem` concede de verdade desde o item #50 (`createAsicLeasesOnPurchase`/`syncTimedAsicStockForItem`, motor já portado pelo #38). **Achado**: `shouldGrantCheckinEstelarReward`/`grantCheckinEstelarBattery` do legado eram aliases "mantidos para compatibilidade de testes legados" — confirmado via grep que não têm nenhum chamador fora do próprio arquivo, não portados)
  - `services/checkin.ts` ← `checkin.service.ts` (757 linhas — matemática de fronteira BRT 21:00→21:00, streak diário/premium, `getCheckinStatus`/`performCheckin` via transação `pg` crua)
  - `controllers/checkin.controller.ts` ← `checkin.controller.ts` (**corte de escopo**: `bumpQuestProgress(userId, 'checkin', 1)` do legado, que dependia de `modules/quests` — não migrado ainda —, fica `TODO` no `POST /api/checkin`)
  - Novo utilitário `shared/utils/time.ts`: `MS_PER_DAY` adicionado (fonte única, reaproveitado por `lease-duration.ts` e `checkin.ts`)
  - 66 testes novos (32 de services isolados + 15 de matemática BRT pura + 8 de `getCheckinStatus`/`performCheckin` mockando `core/database/pool.js` + 11 de controller)
- [x] `modules/mining-engine/` — novo módulo (não existia como pasta própria no legado), extraído pra suportar `dashboard` (e futuramente `ranking`/upgrades/servers) sem duplicar lógica. Ver DECISIONS.md #8. **Revisão** (DECISIONS.md #63): `SET LOCAL` timeouts no progress-computer (anti pool-poison) + SAVEPOINT no accrual account-manager.
  - `services/rack-room-id.ts` ← `modules/batteries/batteries.validation.ts` (só `normalizePlacedRackRoomId`)
  - `services/nft-room-mining.ts` ← `lib/nftRoomMining.ts` (verbatim)
  - `services/checkin-bonus-hash.ts` ← `lib/checkinBonusHash.ts` (verbatim)
  - `services/player-game-header-snapshot.ts` ← `lib/playerGameHeaderSnapshot.ts` (verbatim; mesma fonte de hash do WS `/ws/player-game`, ainda não migrado)
  - `controllers/player-game-header.controller.ts` — `GET /api/player-game/header` (fetch sob pedido + cache curto; **sem** poll/WS — DECISIONS #110/#112)
- [x] `modules/ranking/` ← `lib/miningRankingPrisma.ts` (**corte de escopo**: só `getPublicMiningRankingPayload`/`sumGeneralRankingPower`; `getAdminMiningRankingPayload`/`getMyGlobalMiningRank` ficam para `modules/admin`, ver DECISIONS.md #8) **Revisão** (DECISIONS.md #68): bloqueio + rate-limit por userId.
- [x] `modules/wallet/` ← `modules/wallet/walletPlayerController.ts` + `walletExchangeLiquidation.ts` + `walletDeskPercent.ts`. **Completo**: `GET /api/wallet/state|/history` + `POST /api/wallet/exchange/liquidate` (câmbio moeda→USDC transacional, idempotente). O corte original (item #8, "dependem de infraestrutura não portada") deixou de se aplicar depois que `modules/wheel`/`modules/shop` extraíram `stableIntentFingerprint`/`computeAdvisoryLockKey64`. Ver DECISIONS.md #15. **Revisão** (DECISIONS.md #75): bloqueio, rate-limit, lock_timeout, FOR UPDATE saldo.
- [x] `modules/dashboard/` ← `modules/dashboard/dashboard.controller.ts` + `dashboard.service.ts` + `dashboard.types.ts` (verbatim, agora ligado a `mining-engine`/`ranking`/`wallet` reais em vez de placeholder). **Revisão pós-migração** (DECISIONS.md #55): bloqueio, ranking fora do top sem `top[-1]`, asset `img/parceiros/blockminer.webp`, query users consolidada.
  - 61 testes novos: mining-engine (36), ranking (4), wallet (5), dashboard (16)
- [x] `modules/rooms/` ← `server.ts` (`GET /api/rig-rooms`, `POST /api/rig-rooms/purchase-slot`). **Não é port verbatim**: corrige um gap de segurança do legado — `allowed_levels`/`allowed_season_pass_ids` (salas exclusivas por nível de membership/season pass) só eram filtrados na listagem, a rota de compra não conferia nada no servidor. Agora `purchaseRigRoomSlot` valida acesso antes de debitar. Ver DECISIONS.md #8. CRUD admin de salas (`POST /api/rig-rooms`) não migrou — fora do escopo do gap. **Revisão** (DECISIONS.md #70): bloqueio purchase-slot, rate-limit, SET LOCAL timeouts.
- [x] `modules/servers/` ← `modules/servers/servers.rackAuxIntent.service.ts` + `.controller.ts` (só `POST /api/servers/racks/place`). **Não é port verbatim, é reescrita própria**: fecha o pior gap de segurança achado na sessão — colocação de rack não conferia posse (`user_rig_rooms`) nem capacidade real da sala, só ocupação de slot. `services/place-rack.ts` confere dono (room_initial grátis, ou `user_rig_rooms`, ou nível/season-pass) + capacidade real numa única transação. `GET /api/servers/state`, equip/unequip/remove e o save-game em massa não migraram — dependem do motor genérico de persistência (`lib/serverRoomPersistence.ts`, 852 linhas) e do sistema completo de lease de ASIC temporizado, não portados por risco/escopo. Ver DECISIONS.md #9. **Revisão** (DECISIONS.md #71): bloqueio, SET LOCAL, idempotência na tx, rate-limit.
- [x] `modules/upgrades/` ← `modules/upgrades/upgradesPlayer.controller.ts` + `upgradesState.service.ts` + `upgradesPurchase.service.ts` + `upgrades.catalog.ts` + extrações pontuais (`loadAdminUpgradesForUser` de `lib/meUpgradeShopBundlePayload.ts`, `materializeUpgradePackageAsLootBoxInTx` de `models/adminUpgradeGrantModel.ts`). **Corrige o gap de visibilidade já documentado no item #8**: compra agora reconfere `admin_upgrade_visibility` antes de debitar. Novos utilitários genéricos: `shared/validation/idempotency-key.ts`, `shared/security/stable-fingerprint.ts`. CRUD admin de pacotes não migrou. Ver DECISIONS.md #10. **Revisão** (DECISIONS.md #74): bloqueio, rate-limit, FOR UPDATE saldo, lock_timeout.
- [x] `modules/account-manager/` ← todos os 7 arquivos de `modules/account-manager/` do legado (constants, feature, week, accrual, allowlist→guard, controller, service→manager), verbatim (kill-switch `ACCOUNT_MANAGER_ENABLED`, contratar/candidatar/aceitar/recusar/demitir/resignar, entrar/sair de conta gerida, guard de allowlist de rotas em "modo gerência"). `services/accrual.ts` (10% do minerado pro gerente) tem chamador desde o item #24 (`progress-computer.ts`, tick de mineração). 50 testes novos. **Nota (DECISIONS #115):** o módulo em `current/` vive em `modules/gerente` (HTTP path inalterado).
- [x] `modules/black-market/` ← `modules/black-market/*` (6 arquivos) + `models/p2pMarketModel.ts` completo + `controllers/p2pMarketController.ts` (1035 linhas) + `models/referralCommissionModel.ts` (só `runReferralCommissionOnTx`). Leitura (`GET /state`, `/listings`, `/my-listings`, `/escrow`, `/history`) **e mutações completas** (`POST /sell`, `/cancel`, `/reserve`, `/cancel-reserve`, `/buy`, `/claim`, `/claim-all`, `/claim-item`) — mercado P2P inteiro migrado. `P2pUserError` bespoke virou `HttpControlledError`. Ver DECISIONS.md #34. **Revisão pós-migração** (DECISIONS.md #53): bloqueio nas mutações, buy sem vazamento `e.message` como 400, `$executeRawUnsafe` removido, clamp de taxa, corrida de idempotência, comissão sem swallow dentro da tx.
- [x] `modules/quests/` ← todos os 4 arquivos de `modules/quests/` do legado (types, period, controller, service), verbatim. `ensureQuestSchema()` deixou de fazer `CREATE TABLE IF NOT EXISTS` (schema já existe via migration Prisma) — mantém só a semeadura idempotente de `DEFAULT_QUEST_DEFINITIONS`. **Fecha o TODO deixado em `modules/checkin`**: `checkin.controller.ts` agora chama `bumpQuestProgress(userId, 'checkin', 1)` após check-in bem-sucedido, igual ao legado. 30 testes novos (+ 2 no checkin.controller.test.ts pra travar essa integração). **Revisão** (DECISIONS.md #67): bloqueio, rate-limit, lock_timeout, premium gate.
- [x] `modules/merge/` ← todos os 5 arquivos de `modules/merge/` do legado (constants, settings, stats, controller, service), verbatim (pool singleton em vez de injeção, `bumpQuestProgress` importado estaticamente já que `modules/quests` migrou). Extraído `recordInventoryMovement` como utilitário genérico em `shared/audit/inventory-movement.ts`. 45 testes novos. **Revisão** (DECISIONS.md #62): bloqueio nas rotas jogador, `lock_timeout` na tx de execute, rate-limit por userId.
- [x] `modules/announcements/` ← legado `modules/in-app-announcements/` + `validation/inAppAnnouncementValidation.ts` (verbatim, exceto `assertImageFileMagicBytes`). **Renomeado + revisão** (DECISIONS.md #59): módulo/`/api/announcements`, aliases legado, bloqueio nas rotas jogador. 51+ testes.
- [x] `modules/roadmap/` ← os 2 arquivos de `modules/roadmap/` do legado (controller, service), verbatim. Roadmap público + CRUD/reorder admin. 22 testes novos. **Revisão pós-migração** (DECISIONS.md #58): título vazio rejeitado no update, PUT com `respondIfHttpControlledError` (reorder em `$transaction` já existia). **Revisão** (DECISIONS.md #69): confirmada limpa (já #58).
- [x] `modules/guide/` ← os 2 arquivos de `modules/guide/` do legado (controller, service), verbatim. Guia in-game público (categorias + páginas HTML sanitizado) + CRUD/reorder admin. 28 testes novos. **Revisão pós-migração** (DECISIONS.md #57): reorder em `$transaction`, título/categoria validados no update, `HttpControlledError` nas mutações admin.
- [x] `modules/wheel/` ← `modules/wheel/wheelPlayerController.ts` + `controllers/roletaController.ts` + `models/roletaModel.ts` + `models/promoRedeemModel.ts` + `models/wheelIdempotency.ts` + `models/promoCodeRoleta.ts` + `validation/roletaValidation.ts`. Giro pago atómico (`POST /api/wheel/spin`) + giro/reivindicação por código promocional (`POST /api/wheel/roll`, `POST /api/roleta/claim`) + estado/histórico. **Corte de escopo**: fluxo legado de 2 passos (`GET /api/wheel/paid-pending`, `POST /api/wheel/paid-roll`, `POST /api/wheel/paid-claim`) não migrado — o próprio legado já o tratava como substituído pelo giro atómico. `grantAdminUpgradeRewards` substituída por `materializeUpgradePackageAsLootBoxInTx` (mesma função já usada por `modules/upgrades`). Ver DECISIONS.md #11. 54 testes novos. **Revisão** (DECISIONS.md #76): bloqueio, rate-limit, lock_timeout.
- [x] `modules/lucky-boxes/` ← `modules/lucky-boxes/*` (4 arquivos) + `models/lootBoxModel.ts` + `validation/lootBoxValidation.ts`. Loja/inventário/abertura de caixas (`/api/lucky-boxes/state|shop|inventory|history|openings/:id|purchase|open|promocodes/redeem`), reaproveitando `runPromoCodeRedeemInTransaction` de `modules/wheel`. **Corte de escopo**: `/api/loot-boxes/*` (controller de jogador mais antigo + CRUD admin de catálogo) — só `discard` veio na #19. **Completa `modules/upgrades/services/grant.ts`** (item #10). Ver DECISIONS.md #12, #19. **Revisão** (DECISIONS.md #61): bloqueio em todas as rotas jogador, `$executeRawUnsafe`→`Prisma.raw`, rate-limit por userId. 62+ testes.
- [ ] ~~`modules/email-campaigns/`~~ — **removido** de `current/` (DECISIONS.md #56). Código/testes/cron/rotas admin apagados; tabelas Prisma `email_campaigns*` ficam no schema (legado morto, sem consumidor).
- [x] `modules/shop/` completo ← `modules/shop/*` (7 arquivos). Catálogo hardware + carrinho + checkout atômico (`/api/shop/*`, 11 rotas), incluindo compra de item ASIC com aluguer temporizado (cria `player_asic_leases` via `createAsicLeasesOnPurchase`/`syncTimedAsicStockForItem`, motor completo já portado pelo item #38). `pool` deixou de vir por `deps`, importa o singleton direto. Extraídos `shared/http/public-asset-url.ts` e `shared/security/advisory-lock-key.ts`. Ver DECISIONS.md #14, #50. 69 + 1 testes novos. **Revisão** (DECISIONS.md #72): bloqueio em todas rotas, rate-limit por userId, lock_timeout checkout.
- [x] `modules/wallet/` completo ← `walletExchangeLiquidation.ts` + `walletDeskPercent.ts` adicionados (`POST /api/wallet/exchange/liquidate` + `GET /api/wallet/history`) — o corte do item #8 não se aplicava mais (infra já existia via `modules/wheel`/`modules/shop`). Ver DECISIONS.md #15. 25 testes novos. **Revisão** (DECISIONS.md #75): bloqueio, rate-limit, lock_timeout, FOR UPDATE saldo.
- [x] `modules/partners/` completo ← `modules/partners/*` (5 arquivos) + subconjunto de `models/partnerYoutubeModel.ts` + `utils/partnerYoutubeHelpers.ts`, incluindo `POST /youtube/avatar-upload` (multer). Vitrine + candidatura + envio de vídeos de Parceiros YouTube (8 rotas); `avatarUrl` continua também aceitando URL já hospedada. Ver DECISIONS.md #16, #46. 52 + 4 testes novos. **Revisão** (DECISIONS.md #64): bloqueio nas rotas autenticadas, rate-limit por userId, avatar path sem `..`.
- [x] Painel admin de `modules/partners/` ← `controllers/partnerYoutubeController.ts` (parte admin) + subconjunto admin de `models/partnerYoutubeModel.ts` + `modules/partners/partnersApply.service.ts` (metade admin). Novos: `services/admin-model.ts`, `services/admin-apply.ts`, `controllers/partners-admin.controller.ts` (`registerPartnersAdminModuleRoutes`). 15 rotas: allowlist manual (`POST`/`DELETE /api/admin/partner-youtube-allowlist(/:userId)`), `GET /api/admin/partner-youtube-partners` (+ compliance de Sala Streamer), `POST .../:userId/deactivate-nft-room`, `GET /api/admin/streamer-room-users` + `POST .../:userId/deactivate`, listar/aprovar/rejeitar/apagar envios de vídeo (aliases `/api/admin/partner-videos/*` e `/api/admin/partners/videos/*`), `GET`/`PUT /api/admin/partner-youtube-creators/:userId`, candidaturas (`GET /api/admin/partner-youtube-applications` + approve/reject). Reaproveita `loadUserPlacedRacksWithSlots`/`persistStockStoredBatteriesPlacedRacks` de `modules/batteries/` (motor do item de resto de batteries/servers) e `NFT_AUTO_ROOM_ID` de `modules/mining-engine/`. Nenhum corte de escopo. Ver DECISIONS.md #48. 40 testes novos.
- [x] `modules/inventory/` ← `modules/inventory/inventory.{controller,snapshot.service,types}.ts` (`GET /api/inventory/state`). Traz junto `modules/batteries/` novo (parcial — só catálogo canónico + invariante de exposição no armazém, sem rota própria). **Corte de escopo**: tick de mineração religado no #24; `inventoryStockAudit.ts` (save-game em massa) não portado. Ver DECISIONS.md #18, #24. **Revisão** (DECISIONS.md #60): `GET /api/inventory/me` religado (fallback do frontend), rate-limit por userId. 23+ testes.
- [x] `/api/loot-boxes/*` legado ← só `POST /discard` foi para `modules/lucky-boxes` (`POST /api/lucky-boxes/discard`) — `open`/`buy` já cobertos pela v2, CRUD admin de catálogo não migrado. Ver DECISIONS.md #19. 7 testes novos.
- [x] `modules/admin/loot-boxes/` ← CRUD admin de catálogo de `lootBoxController.ts` (`POST /api/admin/loot-boxes` upsert em lote, `DELETE /api/admin/loot-boxes/:boxId` cascata) — gap real deixado pelo item #19, não duplicata. `LootBoxAdminUserError` virou `HttpControlledError`. Ver DECISIONS.md #35. 21 testes novos.
- [x] `GET /api/servers/state` ← `servers.snapshot.service.ts` + subconjunto de `lib/meUpgradeShopBundlePayload.ts`/`lib/publicBootstrapPayload.ts`/`lib/upgradeCatalogShape.ts`. **Corrigiu regressão de segurança**: o port verbatim de `applyPlaceRackFromStock` no item anterior reintroduzia o achado do item #9 (colocar rack sem checar posse/capacidade da sala); `assertPlaceRackRoomAccessAndCapacity` foi adicionada como `postApply` da rota `place`, e `place-rack.ts`/`servers.controller.ts` (a correção autocontida do item #9) foram removidos por redundância. Ver DECISIONS.md #39. 9 testes novos.
- [x] resto de `modules/batteries/`/`modules/servers/` ← motor completo `lib/serverRoomPersistence.ts` (852) + `lib/asicLease.ts` (subconjunto usado) + `batteries.{repository,catalog,validation,recovery,bulk}.ts` + `batterySemanticSync.ts` + `lib/{upgradeRackCompat,storedBatteriesWarehouseDelete,orphanRackBatteryRecoveryGate,saveGameEconomyValidate(subset),gameIntentIdempotencyPrisma(resto)}.ts` + `servers.rackAuxIntent.service.ts` (643) + `sanitizePlacedRacksNftAutoRoom`/`validatePlacedRacksForSave` (nunca extraídas do monólito `server.ts`, 294+64 linhas) + os 2 controllers (`POST /api/server-room/bulk-batteries`, 7 rotas `/api/servers/racks/*`). Reverte o corte do item #20 — confirmado com o dono do projeto. Padrão transacional novo (`pg.Pool` + `BEGIN`/`COMMIT` manual + `pg_advisory_xact_lock`), único módulo que não usa `prisma.$transaction`. `GET /api/servers/state` continua fora de escopo (bloqueio diferente — `loadMyRigRoomsForUser`/bootstrap payload, 743 linhas). Ver DECISIONS.md #38. 50 testes novos.
- [x] `modules/support/` completo ← `modules/support/{supportPlayer.controller,supportState.service}.ts` + subconjunto de models, incluindo anexos (`multer`, `POST /tickets(/:id/messages)` com ficheiros, `GET /attachments/download` autenticado). `GET /state|/tickets`, `POST /tickets/:id/archive|reopen`. Ver DECISIONS.md #21, #45. 21 + 30 testes novos. **Revisão** (DECISIONS.md #73): bloqueio, rate-limit, HttpControlledError, lock_timeout.
- [x] Painel admin de `modules/support/` ← `controllers/supportTicketController.ts` (parte admin) + subconjunto admin de `models/supportTicketModel.ts`. `services/ticket-model.ts` estendido com as funções admin-only; novo `controllers/admin.controller.ts` (`registerSupportAdminModuleRoutes`, com instância `multer` própria pros anexos de resposta admin). 5 rotas: `GET /api/admin/support-tickets`, `GET /api/admin/support/user-history`, `GET /api/admin/support/tickets/:ticketId`, `POST /api/admin/support-tickets/status`, `POST /api/admin/support-tickets/reply`. **Corte de escopo documentado**: `compressUploadedMulterFiles` (compressão de vídeo via ffmpeg) não ligada nos anexos da resposta admin — só a variante imagem-only já portada existe (`modules/admin/image-asset`, mesmo corte do item #44); anexos ficam sem compressão, sem perda de funcionalidade além do tamanho do ficheiro. Ver DECISIONS.md #49. 20 testes novos.
- [x] `modules/chat/` completo ← `modules/chat/{chat.service,chat.auth,chat.socket,chat.controller}.ts`, incluindo `POST /api/chat/audio` (multer + validação de magic bytes de áudio). Chat global + DM dono↔gerente em tempo real (Socket.IO, encaixa em `core/socket/attach.ts` do item #4) + `GET /api/chat/peers|history|mentions`. `purgeExpiredChatMessages` agendada via `services/ttl-cron.ts` (`cron/chatTtlCron.ts`, 1 tick/min), ligada no `bootstrap/server.ts`. Ver DECISIONS.md #22, #46, #47. 35 + 15 + 5 testes novos.
- [x] `cron/` (motor de produção de mineração) — decisão original de não migrar (Ver DECISIONS.md #23) revertida pelos itens #24/#40 abaixo; totalmente coberto.

**Fecha o levantamento dos 6 domínios pendentes** (chat, support, resto de batteries/servers, cron, loot-boxes legado) — todos endereçados: 4 migrados/completados nesta leva (loot-boxes discard, support, chat, e os cortes de batteries/servers documentados), `cron/` fica como trabalho futuro dedicado (item #23).
- [x] `cron/miningProgressComputer.ts` → `modules/mining-engine/services/progress-computer.ts` ← decisão do item #23 revertida por instrução explícita. Porta `computeProgressForUser`/`calculateIntegratedYield` verbatim na lógica de cálculo/crédito (lock distribuído por utilizador, `FOR UPDATE` + re-verificação anti-corrida, tecto de janela offline 72h, grelha de crédito de 10 min UTC, congelamento por check-in, idempotência via `mining_progress_commit_ledger`). Todas as dependências já estavam portadas por módulos anteriores (`core/redis/lock.ts`, `modules/checkin`, `modules/mining-engine/services/{checkin-bonus-hash,nft-room-mining}.ts`, `modules/account-manager` — `accrueManagerMiningShare` finalmente tem chamador). 5 ficheiros pequenos novos: `mining-numeric.ts`, `wall-clock-grid.ts`, `runtime-stats.ts`, `mining-coins-cache.ts`, `shared/redis/json-cache.ts`. `mining_block_history` (tabela nunca tracked no Prisma, criada via DDL manual no legado) recebe o mesmo tratamento defensivo `SAVEPOINT` + catch `42P01` já usado para o ledger. Religado em `modules/inventory` (`buildInventoryStateV1` volta a chamar o tick, desfazendo o corte do item #18) — falha do tick nunca bloqueia o snapshot. Ver DECISIONS.md #24. 20 testes novos + 1 em `modules/inventory`.
- [x] `cron/miningYieldCron.ts` → `modules/mining-engine/services/yield-cron.ts` + `global-stats-store.ts`. Portado a pedido explícito mesmo sem bootstrap real que chame `startMiningYieldCron()` — fica pronto para ligar. Cortes: `enqueueGenesisJob` (`bullmq` não é dependência do projeto) e `maybeSyncLiveUsdToMiningCoinsPostgres` (sem código-fonte TS no legado, só `.js`/`.d.ts`; cosmético, não afeta yield). Ver DECISIONS.md #40. 6 testes novos.
- [x] `modules/admin/user-audit/` completo ← `GET /api/admin/user-activity`, `.../session-snapshots`, `.../account-trace` (as 3 rotas que faltavam do item #17, ver corte documentado em `services/inventory-audit.ts`). Novos: `services/activity-event-formatter.ts` (verbatim, sem dependências externas), `services/player-state-snapshot.ts` (só tipo do payload + `diffSnapshotInventory` — o *writer* `buildPlayerStateSnapshot`/`appendSessionStateSnapshot` não foi portado, só é chamado do `server.ts` legado fora desta leva), `services/account-trace.ts` (agregador Postgres+Mongo; as 4 leituras de `p2p_market_trade_history` viraram `prisma.p2p_market_trade_history.findMany` — a tabela já tem modelo Prisma, não precisava de `$queryRawUnsafe`). Ver DECISIONS.md #42. 25 testes novos.

## Regra fixa de pastas dentro de todo `modules/<dominio>/`

Todo módulo segue a mesma tríade, sempre (substituiu uma tentativa anterior
de agrupar por sub-domínio — `jwt/`, `login/`, `signup/` — que não deixava
claro o *papel* de cada arquivo; o usuário pediu explicitamente `controllers/`
e `models/`):

- `controllers/` — só rota HTTP (`Express.Router`/handlers), um arquivo por
  grupo de rotas (`login.controller.ts`, `register.controller.ts`). Nome
  sempre `<algo>.controller.ts`.
- `models/` — só acesso a dado via Prisma (`repository.ts` ou
  `<algo>.model.ts`), sem regra de negócio complexa além de query/shape.
- `services/` — tudo que não é rota nem acesso a dado puro: validação, JWT,
  cookies, política de senha, e-mail, etc. Se o módulo tiver muitos services,
  aí sim pode subdividir `services/` internamente — mas `controllers/` e
  `models/` ficam sempre no nível raiz do módulo.
- raiz do módulo — só `index.ts` (barril de export).

Aplicado em `modules/auth/`: `controllers/` (2), `models/` (1),
`services/` (14), `index.ts`. `tests/` espelha exatamente a mesma árvore
(`tests/modules/auth/controllers/login.controller.test.ts`, etc.).

## Regra: testes NUNCA dentro de `server/`

`*.test.ts` não fica ao lado do código-fonte — vai em `tests/`, espelhando o
caminho de `server/` (ex.: `server/modules/auth/cookies.ts` → teste em
`tests/modules/auth/cookies.test.ts`). `server/` fica só com código de
produção. Reforçado depois de os testes terem sido colocados ao lado do
source por engano no início da migração — movidos todos pra `tests/` e os
imports relativos recalculados.

- `tsconfig.json` (raiz) — typecheck de `server/**/*.ts` **e** `tests/**/*.ts`, sem `rootDir` (permite os dois lados).
- `tsconfig.build.json` — só `server/`, com `rootDir`/`outDir`, usado por `npm run build`.
- `vitest.config.ts` — `test.include: ['tests/**/*.test.ts']`.
- `eslint.config.js` — lint roda em `server` e `tests` (`npm run lint` = `eslint server tests`).

## Qualidade de código (obrigatório antes de marcar um arquivo como migrado)

`current/` tem `eslint.config.js` (ESLint 10 + typescript-eslint), com
`no-magic-numbers` ligado em `server/**/*.ts` e `tests/**/*.ts` (desligado só
em `tests/**/*.test.ts`). Todo número precisa virar constante nomeada (ou vir
de `shared/utils/time.ts` pras conversões de tempo).

```bash
npm run lint        # eslint server tests
npm run typecheck    # tsc -p tsconfig.json (checa server/ + tests/)
npm run build         # tsc -p tsconfig.build.json (só server/, gera dist/)
npm test              # vitest (roda tests/**/*.test.ts)
```

Estado atual (`core/`+`shared/`+`modules/auth/`+`modules/profile/` **completos**):
0 warnings de lint, 0 erros de typecheck, **323/323 testes passando**.

`modules/auth/` fechado — rotas HTTP prontas: `GET /api/security/turnstile-config`,
`POST /api/login`, `POST /api/register`, `POST /api/auth/refresh`,
`POST /api/logout`, `POST /api/request-email-verification`, `POST /api/verify-email`.

`modules/profile/` fechado — rotas HTTP prontas: `GET /api/profile/state`,
`PATCH /api/profile/identity`, `POST /api/profile/password/change`,
`GET /api/profile/security-events`, `POST /api/profile/referral/bind`,
`GET /api/profile/referral/state`, `GET /api/profile/referral/overview`,
`POST /api/profile/wallet/connect/challenge`, `POST /api/profile/wallet/connect/verify`,
`GET /api/profile/wallet`, `POST|DELETE /api/profile/wallet/remove`.
`GET /api/profile/badges` não migrou (depende do bundle de shop/season-pass não portado).

**Achado no lote de verificação de e-mail**: é em `verifyEmailTokenAndActivate`
(confirmação do e-mail, não no cadastro) que o legado credita a recompensa de
referral pra quem indicou — mesma economia identificada em `user-creation.ts`,
mesma decisão de não portar (TODO explícito no código), ver DECISIONS.md.

`parseCookies` (parser de `header.cookie` cru) saiu do bootstrap monolítico do
`server.ts` legado e virou `core/http/parse-cookies.ts` — infra genérica, não
específica de auth.

## Regra de ouro (ver `../../architecture/DECISIONS.md`)

⚠️ **Nunca importar de `dist/`**. O `server.ts` legado tem 92 imports diretos
de `./dist/*`. Todo import em `server/` aponta pro `.ts` de origem, nunca
`dist/` (nem do legado nem do `current/`). Checar com
`grep -rn "from '.*\/dist\/" server/` antes de dar qualquer módulo como migrado.

## Notas de decisão tomadas na migração

- **Redis lock unificado** (`core/redis/lock.ts`): duas implementações/duas
  conexões ioredis viraram uma, sobre `core/redis/client.ts`.
- **`genesisStack/` vs `stack/`**: não eram duplicata — confirmado, ver
  `docs/architecture/PROJECT_OVERVIEW.md`.
- **`ethersPolygon.ts` era código morto**: nunca chamado no legado. Quem lê
  on-chain de verdade é `depositReceipt.ts` (RPC pública + Etherscan v2 API),
  que vai para `modules/wallet/` quando esse módulo migrar.
- **`AUTH_FLOW_TOKEN_SECRET`**: divergência real achada — código checa 16
  chars, mensagem de erro pede 32. Documentado em DECISIONS.md #5, não
  corrigido sem confirmação (é decisão de segurança).
- **Revisão geral de boas práticas** (todos os módulos migrados até aqui,
  5 agentes em paralelo): backlog completo, item a item, com arquivo:linha
  e o que fazer — ver `CODE_REVIEW_BACKLOG.md` nesta mesma pasta. Todos os
  21 itens resolvidos.

## `modules/admin/` — completo (7 submódulos, ~6000 linhas no legado; só `restore` fica cortado por decisão)

- [x] `modules/admin/security-bulk/` ← `controllers/adminSecurityBulk.controller.ts`, verbatim. Bloqueio de contas inativas + reset forçado de senha (5 rotas players-facing + 2 de config). `$queryRawUnsafe`/`$executeRawUnsafe` trocados por tagged template desde já (ver DECISIONS.md #25). 23 testes novos. **Correção pós-migração** (revisão de segurança, sem frontend admin ainda montado): `POST /inactive-block/apply` passou a exigir `{ confirm: "BLOQUEAR" }` (simetria com `force-password-reset/apply`, que já exigia `"REDEFINIR"`); `blockInactiveUsersByDays` passou a apagar `sessions` dos bloqueados (antes só marcava `is_blocked`, sessão aberta continuava válida). Ver DECISIONS.md.
- [x] `modules/admin/mining-distribution/` ← `controllers/adminMiningDistribution.controller.ts` (240) + `services/adminMiningDistribution.service.ts` (699). 7 rotas (overview/by-coin/timeline/credits/export.csv/summary/rebuild-rollups). Degrade gracioso se `mining_block_history` não existir (ver DECISIONS.md item mining-distribution). 41 testes novos.
- [x] `modules/admin/user-audit/` completo ← `controllers/adminUserAudit.controller.ts` + `services/adminUserInventoryAudit.service.ts` (143) + `lib/mongoLogs.ts` (já coberto por `core/mongo/logs.ts`) + `lib/activityEventFormatter.ts` + `services/playerStateSnapshot.service.ts` (só tipo+diff) + `services/adminUserAccountTrace.service.ts` (890). 4 rotas: inventory-audit, user-activity, session-snapshots, account-trace. Ver DECISIONS.md #42. 7 + 25 testes novos.
- [x] `modules/admin/backup/` (parcial) ← `controllers/backupController.ts` (478) + `models/backupModel.ts` (245) + `config/{postgresCliPaths,pgDump,database}.ts` (parte usada por `pg_dump`). Listar/criar/apagar/baixar backups + agendamento automático diário. **Restore cortado por decisão explícita** (confirmado com o dono do projeto — maior blast radius do backend, sobrescreve tabelas de produção). Ver DECISIONS.md. 35 testes novos.
- [x] `modules/admin/image-asset/` completo ← `controllers/imageAssetController.ts` (383) + `models/imageAssetModel.ts` (176) + `lib/convertImageToWebp.ts` (parte com `sharp`) + `lib/compressMediaAsset.ts` (sem o branch de vídeo, nenhuma rota portada aceita vídeo) + `validation/inAppAnnouncementValidation.ts` (só `assertImageFileMagicBytes`). Classificação/organização de `img/`, middleware de estáticos com fallback `.webp`, `POST /api/upload-image` (data URL) + `POST /api/admin/upload-image`/`upload-ad` (multipart, `multer`) + conversão automática pra webp (`sharp`). Ver DECISIONS.md #44. 37 + 27 testes novos.
- [x] `modules/admin/referral/` completo ← `controllers/adminReferralController.ts` (930), incluindo `network-delete` (`deleteUserByEmail` extraída de `server.ts:6764`). 7 rotas (summary/commissions/links/lookup/export.csv/network-block/network-delete). Reaproveita `REFERRAL_DEPOSIT_COMMISSION_PERCENT` de `modules/profile`. Ver DECISIONS.md #43. 36 + 14 testes novos.
- [x] `modules/admin/suspicious-emails/` ← `modules/admin/suspiciousEmails/*.ts` (5 arquivos, 767+283+106+33+27 linhas). Relatório de contas/emails suspeitos (heurística de formato/domínio + sinais de actividade real), export CSV, desactivação em massa com checagem de contagem (`409 COUNT_MISMATCH` se o filtro mudou). Reaproveita `computePlayerGameHeaderSnapshot` de `mining-engine`. Ver DECISIONS.md. 56 testes novos. **Correção pós-migração** (revisão de segurança, sem frontend admin ainda montado): `POST /deactivate-filtered` passou a exigir super-admin (`req.isSuperAdmin`, antes só `isAdmin`) e `{ confirm: "DESATIVAR" }` no corpo, simetria com `security-bulk`; e a listagem/contagem usada pra decidir quem entra no filtro `dead_account`/`never_mined`/etc. usava aproximação sem hash real de mineração — um jogador que já minerou de verdade mas zerou saldo/desligou rigs podia ser desactivado por engano. Corrigido: o lote final de desactivação é refinado com hash real antes de executar (`excludedByRealMining` na resposta). Ver DECISIONS.md.

**`modules/admin/` fechado** (7 submódulos, itens #25–#31 do DECISIONS.md).
Pendências remanescentes (cada uma bloqueada por uma dependência não
portada, documentada individualmente):
- [ ] `POST /api/admin/restore` (backup) — `pg_restore`/`psql`/JSON-SQLite legado, sobrescreve BD de produção. Mantido cortado por decisão explícita do dono do projeto.
- [x] `POST /api/admin/referrals/network-delete` (referral) — `deleteUserByEmail` extraída de `server.ts:6764` (~97 linhas, nunca tinha sido extraída do monólito) para `modules/admin/referral/services/delete-user.ts`. Ver DECISIONS.md #43.
- [x] `POST /api/admin/upload-image`/`upload-ad` (image-asset) — `multer`/`sharp` adicionadas como dependência (`sharp@^0.35.3`, não `^0.34.5` do legado — CVE de libvips corrigida só na 0.35.3). Ver DECISIONS.md #44.
- [x] `modules/admin/device-fingerprint/` ← `controllers/deviceFingerprintAdminController.ts` (36) + `listDeviceFingerprintLogs` de `models/deviceFingerprintModel.ts` (o resto do model já vivia em `modules/auth`). `GET /api/admin/device-fingerprints`, verbatim. Ver DECISIONS.md #36. 9 testes novos.
- [x] `utils/adminRouteAuth.ts` (190) → `shared/security/admin-route-auth.ts` (mapeamento puro rota→aba) + `modules/auth/services/admin-guard.ts` (middleware `isAdmin` real, portado de `server.ts`) + `modules/auth/services/http-auth.ts` ganhou `createAuthenticateTokenMiddleware`. Todo módulo que recebia `isAdmin`/`authenticateToken` como `RequestHandler` injetado sem implementação agora tem de onde importar a real. Falta só montar `app.use(createResolveAuthMiddleware(...))` global quando o bootstrap do app for construído. Ver DECISIONS.md #37. 74 testes novos.

## `modules/offerwall/` — migrado completo (ex-`zerads`)

- [x] `modules/offerwall/` ← (ex-`modules/zerads/`)  `controllers/zeradsCallbackController.ts` (446), verbatim. 3 rotas (callback público `/zeradsptc.php`, token do jogador, stats do jogador). Nenhum corte de escopo — todas as dependências (`normalizeClientIp`, `appendGameActivityLogMongo`, `bumpQuestProgress`) já estavam portadas. Ver DECISIONS.md #32. 34 testes novos. **Revisão** (DECISIONS.md #77): bloqueio, rate-limit, callback blocked, FOR UPDATE.

## `modules/player-calculator/` — migrado (corrige exclusão indevida de sessão anterior)

- [x] `modules/player-calculator/` ← `controllers/playerCalculatorController.ts` (68) + `services/playerCalculatorService.ts` (454) + `lib/playerCalculatorProjection.ts` (214). `GET /api/calculator/me`. A pasta tinha sido apagada por engano numa sessão anterior junto com módulos-fantasma genuínos (ver DECISIONS.md #33) — nunca havia sido migrada de facto. `PlayerCalculatorScopeError` virou `HttpControlledError`. Nenhuma dependência nova (tudo já portado em `mining-engine`/`checkin`). 26 testes novos. **Revisão** (DECISIONS.md #65): rate-limit por userId, block_history filtrado por scope de sala.

## Cutover produção / VM — checklist aberto

- [ ] **Estelar / baterias infinitas** — stock empilhável vs UUID (DECISIONS.md **#105**).
  UI esconde infinitas do bloco ENERGIA; dados órfãos em `stock` podem existir
  no dump de produção. Amostrar + decidir limpeza antes/depois do restore na VM.
