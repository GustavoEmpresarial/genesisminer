# Backlog de revisão de código — módulos migrados

Gerado a partir de uma revisão geral de boas práticas em todo `current/server/modules/`
+ `shared/`/`core/` (5 agentes em paralelo, um por grupo de módulos). Este documento
lista o que falta corrigir, um item por vez, na ordem em que serão trabalhados —
`sim, vai um por um` foi a instrução do dono do projeto.

Cada item traz: onde está, o que fazer, por que, e (quando relevante) os testes que
precisam de ajuste junto. Ao terminar um item, marque `[x]` e mova a entrada para a
seção "Concluídos".

## Regra ao implementar cada item

Depois de cada correção: `npx tsc -p tsconfig.json` (server+tests), `npx tsc -p
tsconfig.build.json` (server), `node node_modules/eslint/bin/eslint.js server tests`
(zero warnings), `npx vitest run` (suite completa) — só marcar `[x]` com os 4 verdes.

---

---

## Pendentes

Nenhum. Todos os itens (2 de alta, 7 de média, 12 de baixa severidade) foram
resolvidos nesta sessão — ver "Concluídos" abaixo. Este backlog fica só como
histórico; próxima revisão geral deve gerar um documento novo.

---

## Concluídos nesta sessão

- [x] `modules/account-manager/controllers/account-manager.controller.ts` (rota `/resign`) — catch silencioso agora loga (`console.warn` estruturado).
- [x] `modules/auth/controllers/login.controller.ts` — 2 catches silenciosos (`recordLoginFailure`, `clearLoginFailures`) agora logam.
- [x] `modules/dashboard/services/dashboard.ts` — 3 catches silenciosos (access_levels, placed_racks, lucky-boxes notification) agora logam.
- [x] `modules/checkin` — `GAME_STATE_NOT_FOUND` migrado de `Error` genérico + comparação de string no controller para `HttpControlledError` + `respondIfHttpControlledError`.
- [x] `modules/roadmap` — `POST` não vaza mais `e.message` cru (`HttpControlledError`); `DELETE`/`reorder` ganharam try/catch; `reorderRoadmapSteps` virou atômico (`$transaction`).
- [x] `modules/shop/services/checkout.ts` — `runHardwareCheckoutTransaction` convertido de Result-type (`{ok:false}`) para `HttpControlledError` em todos os ~13 pontos de falha; controller usa `respondIfHttpControlledError`, preservando o log `shop_checkout_denied` no Mongo.
- [x] `modules/email-campaigns/services/campaigns.ts` — `activateCampaign` trocou `$executeRawUnsafe` com interpolação de string por `createMany({ skipDuplicates: true })` parametrizado (alta severidade).
- [x] `modules/profile/services/wallet.ts` — teste dedicado criado (`tests/modules/profile/services/wallet.test.ts`, 18 casos, assinaturas reais via `ethers.Wallet`) (alta severidade).
- [x] `modules/black-market/services/snapshot.ts` — `loadP2pHistoryForUser` (as 2 queries de histórico compra/venda) migrado de `$queryRawUnsafe` para `$queryRaw` + `Prisma.sql` (tagged template), mesmo padrão já usado por `loadBuyFilterCategoriesExcludingSeller` no mesmo arquivo.
- [x] Módulos "fantasma" vazios apagados — `modules/device-fingerprint/`, `modules/email-verification/`, `modules/player-calculator/`, `modules/promo-redeem/`, `modules/roleta/` só tinham `.gitkeep`; o código correspondente já vive em `modules/auth/` (device-fingerprint, email-verification) e `modules/wheel/` (promo-redeem, roleta/spin). Confirmado via grep que nada importa esses caminhos (só comentários citando a origem no legado). `modules/admin/` ficou para trabalho futuro; `modules/zerads/` foi migrado e renomeado para `modules/offerwall/` (DECISIONS #116).
- [x] `core/redis/lock.ts` — `withRedisLock` passou a liberar o lock via o mesmo script Lua compare-and-delete atômico de `releaseDistributedLock` (extraído para `releaseLockAtomic`), eliminando a corrida do GET+DEL em duas chamadas. TTL de `withRedisLock` agora aplica o mesmo teto `LOCK_TTL_SECONDS_MAX` de `tryAcquireDistributedLock` (extraído para `clampLockTtlSeconds`). 2 testes novos (release atômico + regressão simulando outro dono assumir o lock entre a expiração do TTL e o release).
- [x] `modules/partners/services/{apply,submit,profile}.ts` — as 3 classes de erro próprias (`PartnerYoutubeApplyError`, `PartnerYoutubeSubmitError`, `PartnerYoutubeProfileError`) trocadas por `HttpControlledError`; `modules/partners/controllers/partners.controller.ts` passou a usar `respondIfHttpControlledError` nas 3 rotas (`submit`, `apply`, `my-profile`), o que também resolveu de graça o clamp de `statusCode` inconsistente entre rotas (agora é sempre o mesmo helper).
- [x] `modules/black-market/controllers/black-market.controller.ts` — detecção de "tabela `p2p_market_trade_history` ausente" trocada de regex na mensagem de erro para checagem direta do código Prisma `P2021` (`err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2021'`). Teste de regressão adicionado: erro Prisma com mensagem parecida mas código diferente (`P2022`) continua caindo no 500 genérico, não é engolido.
- [x] `modules/upgrades/services/grant.ts` — os 2 `throw new Error` genéricos (`materializeUpgradePackageAsLootBoxInTx`, `grantAdminUpgradeRewardsInTx`) migrados para `HttpControlledError(409, {code:'UPGRADE_NOT_FOUND'})` (conflito de concorrência, não input inválido). `GENESIS_BUNDLE_UPGRADE_ID`/`GENESIS_ROOM_ID` mantidos hardcoded (confirmado idêntico ao legado, `legacy/backend/models/adminUpgradeGrantModel.ts`, não é bug introduzido nesta migração) — mas `user_rig_rooms.room_id` não tem FK pra `rig_rooms`, então adicionada checagem defensiva antes do insert: loga `genesis_bundle_room_missing` se a sala não existir, sem bloquear a concessão (USDC/moedas já creditados antes não devem ser revertidos por este efeito colateral). 3 testes novos/atualizados.
- [x] `modules/quests` (itens 8+9) — decisão: manter result-type no controller (consistente com a decisão já documentada de usar `db.query` cru em vez de Prisma). `ensureQuestSchema()` ganhou cache em memória (`questSchemaEnsured`, só reseta em caso de falha) em vez de remoção pura das chamadas por entry-point — correção de escopo: `bumpQuestProgress` é chamado por `modules/checkin`/`modules/merge` independentemente do boot de `modules/quests`, então remover as chamadas defensivas quebraria a garantia de seed nesses casos; a cache resolve o desperdício de BD sem essa regressão. 3 testes novos.
- [x] `modules/wheel/services/spin.ts` — `HTTP_FORBIDDEN` movido pro bloco de constantes do topo.
- [x] `modules/merge/services/merge.ts` — loop de INSERTs em `merge_history` virou uma única query com `unnest`, timestamps distintos preservados via array pré-calculado. Teste novo (`count=3`, 1 query só, 3 timestamps distintos).
- [x] `modules/profile/services/referral-overview.ts` — as 2 queries de `loadReferralOverview` migradas de `$queryRawUnsafe` para `$queryRaw`+`Prisma.sql`.
- [x] `modules/checkin` — `CHECKIN_WINDOW_MS` duplicado entre `checkin.ts`/`reward.ts` unificado: `reward.ts` agora importa `MS_PER_DAY` de `shared/utils/time.ts` (mesma fonte de `checkin.ts`) em vez de recalcular `24*60*60*1000` localmente.
- [x] `modules/checkin/services/reward.ts` — `shouldGrantCheckinReward` mantida (não removida): confirmado idêntica ao legado (`checkinReward.ts`, mesmos parâmetros ignorados) — documentado com comentário explicando que é ponto de extensão deliberado, não oversight.
- [x] `modules/chat/services/chat.ts` — rate limit em `Map` local documentado com comentário explicando a limitação (não compartilhado entre processos) e o caminho de migração (`shared/redis/json-cache.ts`) se/quando o deploy for horizontal.
- [x] `modules/dashboard/services/dashboard.ts` — `blockminerDashboardImageUrl`/`ecosystemModulesForResponse` migradas de `fs.statSync` síncrono para `fs.promises.stat` (async), já que `buildDashboardStatePayload` já é `async`.
- [x] `shared/security/mailer.ts` — aviso no import se `MAIL_USER`/`MAIL_PASS`/`MAIL_HOST`/`MAIL_FROM` ausentes (`warnIfMailerMisconfigured`); aviso (uma única vez, não a cada envio) quando `resolvePublicBaseUrl` cai no fallback de produção por falta de `FRONTEND_URL`/`PUBLIC_URL`/`SITE_URL`. 2 testes novos.
- [x] Cobertura de testes em `shared/`/`core/` — todos os 13 arquivos sem teste dedicado ganharam suíte própria: `core/database/{pool,prisma}.ts`, `core/http/index.ts` (barrel), `core/mongo/client.ts`, `core/redis/client.ts`, `core/socket/{attach,client}.ts`, `shared/audit/inventory-movement.ts`, `shared/redis/json-cache.ts`, `shared/security/stable-fingerprint.ts`, `shared/settings/settings-repository.ts`, `shared/utils/time.ts`, `shared/validation/idempotency-key.ts`. 76 testes novos, todos mockando os clientes externos (`pg`, `@prisma/client`, `ioredis`, `mongodb`, `socket.io`) — nenhum toca infraestrutura real.

Todos os itens acima passaram pela ritual completa (tsc×2, eslint zero-warnings, vitest
completo) antes de serem marcados concluídos. Suite final: 1305 testes, 0 falhas.
