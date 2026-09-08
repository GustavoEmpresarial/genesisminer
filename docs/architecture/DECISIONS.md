# Decisões de arquitetura — `current/`

Registro de decisões tomadas durante a reestruturação, com o problema real do
legado que motivou cada uma.

## 0. Nome de arquivo: kebab-case, sempre

Todo arquivo novo em `server/` e `client/` usa kebab-case
(`client-ip.ts`, `error-response.ts`, `http-controlled-error.ts`) — nunca
camelCase (`clientIp.ts`) nem PascalCase, exceto componentes React no
frontend (`AdminPanel.tsx` segue convenção própria do React, a confirmar
quando chegar a vez do frontend). Bate com o padrão de nome de pasta que já
usamos (`account-manager`, `black-market`). Arquivos que ainda não foram
migrados nesse padrão: nenhum — os 7 que tinham nome camelCase (herdados do
legado ao portar) já foram renomeados.

## 1. Nunca importar de `dist/` no código-fonte

**Achado no legado**: `legacy/backend/server.ts` (arquivo `.ts`, fonte) tem
**92 imports diretos de `./dist/*`** (ex.: `import db from './dist/config/db.js'`,
`import { mergeSaveGameSlicePayload } from './dist/lib/gameSaveSliceMerge.js'`).
Ou seja: o código-fonte principal do backend — incluindo o caminho de
persistência do save-game (`/api/save-game`, merge de slice, `serverRoomPersistence`)
e o WS de `/ws/player-game` — depende do **build compilado**, não do TS de
origem. Isso só funciona por acaso: se alguém edita `lib/gameSaveSliceMerge.ts`
e esquece de rodar `build:app`/`build:ts` antes de reiniciar o servidor, o
processo sobe e roda a versão **antiga** do `dist/`, sem qualquer erro ou aviso.
Explica também por que `build:app` tem que copiar manualmente
`lib/miningLivePrices.js` pro `dist/` — o pipeline de build já é frágil por
natureza dessa mistura fonte/artefato.

**Regra pro `current/`**: todo import em `server/` aponta pro `.ts` de origem
(`../core/database/prisma.ts`, nunca `../../dist/core/database/prisma.js`).
`dist/` é saída de build, gerada, git-ignorada, nunca referenciada por nenhum
`import` dentro de `server/`. Se isso acontecer de novo é bug — sinal de que
alguém colou código do legado sem trocar o import.

**Como verificar**: `grep -rn "from '.*\/dist\/" server/` deve sempre voltar
vazio. Vale adicionar isso como lint/CI check quando o projeto tiver pipeline.

## 2. Redis lock consolidado (ver também `docs/development/backend/MIGRATION_TRACKER.md`)

Duas implementações de lock distribuído com duas conexões `ioredis`
independentes (`lib/redisDistributedLock.ts` e `lib/stack/redisLock.ts`) foram
unificadas em `server/core/redis/lock.ts`, sobre um único cliente
(`server/core/redis/client.ts`).

## 3. CSP com domínio de outro projeto colado por engano

**Achado no legado**: `server.ts`, bloco `helmet()`/CSP, `frame-src` incluía
`https://blockminer.space` e `https://*.blockminer.space` — domínio do projeto
BlockMiner (outro produto seu), sem relação com o MineStation/Genesis Miner.
Clássico copy-paste de config entre projetos que nunca foi limpo.

**Correção**: removido em `server/core/http/csp.ts`. Nenhum iframe do
MineStation aponta pra `blockminer.space`; se precisar liberar um domínio novo
no `frame-src`, adicionar explicitamente com justificativa.

## 4. Socket.IO desacoplado de módulo de domínio + conexão Redis reaproveitada

**Achado no legado**: `lib/stack/socketIoServer.ts` (infra genérica de Socket.IO)
importava direto `modules/chat/chat.socket.ts` (módulo de domínio) — infra
acoplada a produto. Além disso abria sua própria conexão `ioredis` pro adapter
Redis, somando com as outras conexões já duplicadas (ver item 2) — 3+ conexões
Redis no mesmo processo para propósitos parecidos.

**Correção**: `server/core/socket/attach.ts` não conhece `chat` nem nenhum
outro módulo — recebe um callback `onConnect(io, socket)` que cada módulo
registra na sua vez. O adapter Redis usa `.duplicate()` do cliente único de
`core/redis/client.ts`, não abre conexão própria.

## 5. `AUTH_FLOW_TOKEN_SECRET`: check de 16 chars, mensagem pede 32

**Achado ao aplicar a regra de "sem número mágico"**: `getAuthFlowTokenSecret()`
(`server/shared/security/auth-flow-secret.ts`, portado de
`legacy/backend/utils/authFlowSecret.ts`) rejeita secrets com menos de **16**
caracteres, mas a mensagem de erro pede **32**. Não corrigido — não é claro
qual dos dois é o valor pretendido, e mudar o enforcement é decisão de
segurança, não só de limpeza de código.

**Pendente**: confirmar com o time se o mínimo real deve ser 16 ou 32 e
alinhar código + mensagem.

## 6. Super-admin legado hardcoded no código-fonte — REMOVIDO

**Achado ao portar `modules/auth/super-admin.ts`** (de `utils/legacySuperAdmin.ts`):
a allowlist de super-admin tinha um e-mail real **hardcoded direto no `.ts`**
(`kellyreg@gmail.com`). Confirmado que era **ativo em produção**, não código
morto: `legacy/backend/server.ts` chama `ensureAdminSuperAdminSchema()` no
boot do servidor (linha ~10205), toda vez que o processo sobe, rodando
`UPDATE users SET is_super_admin = 1 WHERE is_admin = 1 AND email = 'kellyreg@gmail.com'`
— ou seja, o próprio restart/deploy do backend promovia essa conta a
super-admin automaticamente, sem painel nem ação explícita.
`resolveIsSuperAdminFromUserRow` também era chamado em runtime em ≥5 pontos
de `server.ts` (login, sessão, endpoints admin).

**Decisão (usuário, explícita)**: remover completamente. `current/server/modules/auth/super-admin.ts`
agora só olha a coluna `is_super_admin` do banco — sem allowlist de e-mail,
sem bypass, sem escrita automática no boot (`ensureAdminSuperAdminSchema`
**não foi portado**). Se alguém precisar ser super-admin, é via coluna
`is_super_admin` diretamente (quem tem acesso a banco/painel decide),
nunca por e-mail fixo no deploy.

## 6b. Segunda função de auto-promoção por e-mail — `ensureUserLevels()` (mais grave que #6)

**Achado ao varrer o resto da lógica de admin/permissão** (pedido do usuário
depois de descobrir o item #6): existe uma **segunda** função no legado com o
mesmo padrão, só que maior — `legacy/backend/server.ts:916` (`ensureUserLevels`),
chamada em `startServer()` → bloco de boot com `WORKER_ROLE === 'BACKGROUND' || 'ALL'`
(linha ~10133). `WORKER_ROLE` default é `'ALL'` (linha 347) — ou seja, **roda
sempre que ninguém configurar essa env var**, todo restart/deploy, sem flag
pra desligar. `startServer()` é chamado incondicionalmente no fim do arquivo
(linha 10474).

O que essa função faz, com 4 blocos de `UPDATE` direto, todos por e-mail
hardcoded no source:

1. `klealbert19@gmail.com` → `is_admin=1` **+** `access_level_id='tester'`
   **+** um JSON completo de `admin_permissions` (`dashboard`, `users`,
   `settings`, `settings:labels`, `economy`, `logs`, `security`, `cms`,
   `marketplace`, `upgrades` — tudo `true`). Essa é pior que o item #6: não é
   só super-admin, é a permissão granular completa do painel inteiro.
2. `klealbert82@gmail.com` → `access_level_id='tester'`
3. `adfyhubgaming@gmail.com` → `access_level_id='partner'`
4. Lista `founders` com **18 e-mails** → `access_level_id='founder'` cada

Nenhum desses 20 e-mails está numa env var, tabela de config ou allowlist
auditável — é tudo string literal no `server.ts`. Igual ao item #6: não é
código morto, roda de verdade a cada boot em produção.

**Status no `current/`**: **não portado**. Nenhum desses 4 blocos existe em
`current/server/`. Igual à decisão do #6 — se algum desses 20 e-mails precisa
desses níveis de acesso, isso tem que ser uma operação explícita de admin
(via painel ou update manual auditado), nunca um efeito colateral do deploy.

**Verificado direto na produção** (queries read-only no `postgres_app`, 2026-08-15):

- `kellyreg@gmail.com` (item #6): existe (id 14416), mas `is_admin=0`,
  `is_super_admin=0`, `access_level_id='normal'` — **nunca foi promovida**,
  porque a função só age em conta que já é admin. Sem efeito prático hoje.
- Dos 21 e-mails de `ensureUserLevels()`, **16 existem no banco**. Nenhum tem
  `is_admin=1` nem `admin_permissions` preenchido — o grant mais grave
  (`klealbert19@gmail.com` → admin total + permissões completas) **nunca
  ativou porque essa conta não existe** no banco.
- Mas **14 contas têm `access_level_id` ativo de verdade agora**, escrito por
  esse código todo boot: 13 com `founder`, 1 com `partner`
  (`adfyhubgaming@gmail.com`). 2 contas (`b3d1k@outlook.com`,
  `washingtonjrdesouza@gmail.com`) têm `access_level_id='nft_arbam'` — valor
  diferente do que o código escreve, ou seja foram alteradas depois por outra
  via (admin manual ou outro fluxo), não é mais esse código quem as controla.
- **Pendente**: o que `access_level_id='founder'`/`'partner'` concede em
  termos de regra de negócio (bônus, taxa, cosmético) não foi investigado —
  só confirmamos que a tag está gravada. Verificar quando o módulo dono dessa
  lógica (`profile`/`shop`/`upgrades`, a confirmar) migrar.

**Status no `current/`**: confirmado — nenhum dos dois blocos foi portado.

## 7. `genesisStack/` vs `stack/` não eram duplicata

Confirmado: `genesisStack/init.ts` é bootstrap de conexão (Redis + Mongo);
`stack/*` é uso desses clientes (ethers, bullmq, socket.io, cache). Migrados
para `server/core/{redis,mongo}/client.ts` (bootstrap) e serão distribuídos
por módulo/`shared` conforme cada consumidor migrar.

## 8. `modules/dashboard/` exigiu migrar o motor de mineração — feito, com 2 cortes pontuais

`dashboard.service.ts` do legado dependia de 3 arquivos que, juntos, puxavam
quase todo o motor de mineração (~1900 linhas): `lib/playerGameHeaderSnapshot.ts`
(hash real do jogador), `lib/miningRankingPrisma.ts` (ranking) e
`modules/wallet/walletPlayerController.ts` (saldo/carteira). Perguntado ao
usuário se cortava tudo, migrava tudo, ou pulava o módulo — resposta explícita:
**"vai ter que migrar e refatorar... de modo bem feito e inteligente...
modularizado e bem mitigado"**. Migrado por completo, criando 3 módulos novos
reutilizáveis (não só o necessário pro dashboard, mas como domínio próprio):

- **`modules/mining-engine/`** — lógica pura de mineração compartilhada:
  `services/nft-room-mining.ts` (regras da Sala NFT/ASIC), `services/checkin-bonus-hash.ts`
  (distribuição do bónus de check-in por hash), `services/rack-room-id.ts`
  (normalização de `room_id`, extraído de `modules/batteries/batteries.validation.ts`
  — só essa função; o resto da validação de baterias fica para quando
  `modules/batteries` migrar), `services/player-game-header-snapshot.ts`
  (mesma fonte de hash usada pelo WS `/ws/player-game`, ainda não migrado).
  Sem `controllers/`/`models/` — não expõe rota própria, só é consumido por
  outros módulos (`checkin`, `dashboard`, `ranking`).
- **`modules/ranking/`** ← `lib/miningRankingPrisma.ts`. **Corte de escopo**:
  só `getPublicMiningRankingPayload` + `sumGeneralRankingPower` (o que o
  dashboard consome). `getAdminMiningRankingPayload` (painel admin, inclui
  `coin_balances` por utilizador) e `getMyGlobalMiningRank` (cache dedicado
  pro WS do jogador) não foram portados — voltam quando `modules/admin` e o
  header do jogo migrarem.
- **`modules/wallet/`** ← `modules/wallet/walletPlayerController.ts`.
  **Corte de escopo**: só `buildWalletStatePayload` (snapshot de leitura,
  usado pelo dashboard). As rotas `GET /api/wallet/history` e
  `POST /api/wallet/exchange/liquidate` do legado (câmbio moeda→USDC
  transacional, com replay de idempotência) **não migraram** — dependem de
  infraestrutura própria não portada: `wallet_idempotency` +
  `pg_advisory_xact_lock` (`lib/gameIntentIdempotencyPrisma.ts` +
  `modules/wallet/walletLocks.ts`), além de `walletExchangeLiquidation.ts`
  (276 linhas) e `validation/roletaValidation.ts` (usado também por outros
  módulos ainda não migrados — `roleta`, `lucky-boxes`). Ficam para quando
  `modules/wallet` migrar como módulo completo (rotas de câmbio/extrato),
  não é bloqueante pro dashboard.
- **`modules/dashboard/`** ← `dashboard.controller.ts` + `dashboard.service.ts`
  + `dashboard.types.ts`, agora ligado aos 3 módulos acima em vez de dados
  fictícios — `GET /api/dashboard/state` devolve miner state, carteira e
  ranking reais.

61 testes novos (mining-engine 36, ranking 4, wallet 5, dashboard 16).

**Achado depois, corrigido na mesma leva**: o port inicial de `getPublicMiningRankingPayload`
não tinha cache — cada carregamento de `GET /api/dashboard/state` (de qualquer
utilizador) disparava um scan de **todos os utilizadores elegíveis pro ranking
+ todas as racks ligadas deles**, sem limite, toda vez. O legado tinha esse
mesmo scan pesado, mas com um cache TTL curto (`getPublicMiningRankingPayloadCachedForMe`,
5–60s) que não foi portado por engano.

Corrigido em 2 passos:
1. Primeira correção: cache TTL em memória de processo (10s), igual ao padrão
   do legado.
2. **Revisado a pedido do usuário** — cache em memória tem 2 problemas: cada
   processo Node (cluster/múltiplos containers) recalcula por conta própria, e
   quem paga o preço do recálculo é sempre o próximo utilizador azarado que
   bate na borda do TTL. Trocado por **snapshot pré-calculado no Redis**:
   - `refreshPublicMiningRankingSnapshot()` — calcula o ranking e grava em
     `ranking:public:v1` (Redis), com TTL de 3× o intervalo de refresh (folga
     pra sobreviver a um ciclo atrasado sem a chave sumir no meio).
   - `startPublicMiningRankingRefreshLoop()` — job de fundo, `setInterval` a
     cada `RANKING_REFRESH_INTERVAL_MS` (env, **default 5 minutos** — decisão
     explícita do usuário: não precisa ser em tempo quase-real). Precisa ser
     chamado uma vez no bootstrap do processo (ainda pendente — `current/`
     não tem `server.ts` montado ainda, ver `modules/dashboard` no tracker).
   - `getPublicMiningRankingPayload()` só faz `GET` no Redis — não escaneia
     `users`/`placed_racks` por request, não importa quantos utilizadores
     estejam online. Em cache-miss (Redis não configurado, ou job ainda não
     rodou), calcula uma vez, grava no Redis, e usa um fallback local de 10s
     como rede de segurança pro caso de Redis indisponível — com dedupe de
     chamadas concorrentes (`inFlightCompute`) pra não escanear a mesma coisa
     em paralelo se várias requisições caírem juntas nesse instante.
   - `{ fresh: true }` força recálculo + regravação, ignorando o snapshot.

As demais queries do módulo (`mining-engine`, `wallet`, `dashboard`) já eram
todas escopadas por `user_id` ou por tabelas de catálogo pequenas
(`upgrades`/`rig_rooms`), então não tinham esse risco.

**Sobre "salas" (`rig_rooms`) e nível de acesso** — perguntado se `dashboard`/
`mining-engine`/`ranking` tratam o controle de sala por `access_level_id`.
**Não tratam, de propósito**: esse controle nunca fez parte de
`dashboard.service.ts` no legado. `mining-engine`/`ranking` só leem racks
**já colocadas** (`placed_racks`) e calculam hash — não reavaliam se o
utilizador tinha nível pra ter comprado aquela sala; isso é decidido no
momento da compra, não no cálculo de hash depois.

O controle de sala por nível vive em `rig_rooms.allowed_levels` (JSON) +
`allowed_season_pass_ids`, usado em 2 lugares do legado, nenhum migrado:
1. `GET /api/rig-rooms` — devolve `allowedLevels` no payload pro cliente decidir o que mostrar trancado.
2. `lib/meUpgradeShopBundlePayload.ts` — filtra quais salas aparecem como compráveis, cruzando `access_level_id` do user com `allowed_levels` da sala. **É o mesmo arquivo do corte de "bundle" já documentado no item #6 desta migração** (`modules/profile/services/state.ts`, season pass/loot box, 473 linhas) — não é um corte novo, é o mesmo.

**Achado nessa investigação** (legado, não introduzido por `current/`):
`POST /api/rig-rooms/purchase-slot` (rota que debita USDC e libera a sala de
verdade) **não confere `allowed_levels` no servidor** — só o payload de
listagem filtra. Ou seja, no legado, uma requisição forjada direto na rota
compraria slot em qualquer sala, nível nenhum bloqueia de fato no backend —
é um gate cosmético (esconde o botão), não uma autorização real.

**Corrigido nesta mesma leva** — criado `modules/rooms/` (listagem pública +
compra/desbloqueio de slot), migrado de `server.ts` (`GET /api/rig-rooms`,
`POST /api/rig-rooms/purchase-slot`). Diferente do resto da migração, aqui
**não é port verbatim**: `purchaseRigRoomSlot` agora chama
`isRoomAccessAllowedForUser(room, resolveUserRoomAccess(userId))` — combina
`users.access_level_id` actual + `user_access_levels` (múltiplos selos
concedidos) + `season_purchases` (passes comprados) — **antes** de debitar
USDC ou liberar o slot, devolvendo 401 (`ROOM_ACCESS_DENIED`) se a sala for
restrita e o utilizador não bater nível nem passe. Mesma regra de
nível-OU-passe-dentro-de-cada-eixo, E-entre-eixos que já existia (só) na
listagem do legado (`lib/meUpgradeShopBundlePayload.ts`) — agora também
aplicada onde realmente importa. CRUD admin de salas (`POST /api/rig-rooms`)
não migrou nesta leva — não fazia parte do gap de segurança. 23 testes novos,
incluindo os que travam especificamente o bloqueio/liberação da compra.

**Varredura pedida pelo usuário** ("verifica o que mais não tem validação") —
mandei um agente auditar `legacy/backend` procurando especificamente essa
mesma forma de bug (regra de elegibilidade conferida só na leitura/listagem,
pulada na rota que muda estado/gasta dinheiro). Verifiquei manualmente o
achado antes de registar aqui (lendo o código, não confiando no relatório
do agente):

- **`modules/upgrades/upgradesPurchase.service.ts` (`runUpgradePackagePurchase`),
  chamado por `POST /api/admin-upgrades/purchase`** — mesmo formato do bug das
  salas. A tabela `admin_upgrade_visibility` (que pacotes admin são
  exclusivos de qual `access_level_id`) só é lida em
  `lib/meUpgradeShopBundlePayload.ts` (`loadAdminUpgradesForUser` →
  `visibleToAccessLevelIds`) e filtrada em `modules/upgrades/upgradesState.service.ts:94`
  (`visibleToUser()`) — só na listagem/estado. A compra confere `is_active`,
  janela `starts_at`/`ends_at`, `stock_remaining`, versão do pacote e saldo
  USDC (linhas ~170–220 de `upgradesPurchase.service.ts`) — **nunca consulta
  `admin_upgrade_visibility`**. Sabendo o id de um pacote exclusivo (ex.:
  "Pacote Founder"), qualquer conta autenticada compra e recebe a loot box,
  sem ter o nível. **`modules/upgrades` ainda não foi migrado pra `current/`**
  — nada a corrigir agora (não existe ainda), mas fica registado aqui pra
  quando for a vez desse módulo: `runUpgradePackagePurchase` tem que
  reconferir `admin_upgrade_visibility` contra o nível/passe do utilizador
  (nível actual + `user_access_levels`, mesmo padrão de `resolveUserRoomAccess`)
  **dentro da mesma transação**, antes de debitar — mesmo padrão já aplicado
  em `modules/rooms`.
- **Achado secundário, sem exploit real**: `POST /api/exchange/sell`
  (`server.ts` ~9789) passa `idempotencyKey: null` pra
  `runExchangeLiquidation`, diferente de `/api/withdraw` (~9878) e dos fluxos
  de compra de shop/upgrade/lucky-box, que exigem chave de idempotência.
  Não é duplicável de forma perigosa (revende uma fração do saldo *actual*,
  então repetir a chamada só revende de novo o que sobrou — não duplica
  crédito), mas é inconsistente com o padrão que o próprio código usa em
  toda rota que mexe em dinheiro. Anotado, sem ação — `modules/wallet`
  (exchange completo) ainda não migrou.
- **Verificado e sem problema** (varredura do agente, não reexecutada
  linha-a-linha por mim, mas cobre bastante terreno): mercado P2P
  (comprar/vender/cancelar/reservar), checkout da loja (preço/stock
  travados na transação), compra/abertura de lucky-box, compra de season
  pass, transferência de NFT, entrada/contratação no account-manager,
  operações em lote de baterias, giros pagos de roleta/roda — todos
  reconferem preço/posse/elegibilidade no servidor. Middleware `isAdmin`
  presente de forma consistente nas rotas admin amostradas (sem rota-irmã
  esquecida). Isso cobre uma fatia grande do `server.ts`, não o arquivo
  inteiro linha a linha — se aparecer algo suspeito num módulo específico
  quando for a vez de migrá-lo, vale reconferir localmente antes de portar.

## 9. `modules/servers/` — colocação de rack sem checar dono/capacidade da sala (pior achado da sessão)

Segunda varredura pedida pelo usuário, focada em `modules/servers/` (racks/ASIC)
e referral. **Referral saiu limpo** (auto-indicação/ciclo bloqueados, comissão
de depósito idempotente de verdade via `ON CONFLICT DO NOTHING` + `rowCount`,
comissão é constante do servidor, rotas admin com `isAdmin`; único ponto
frágil sem exploit hoje: `runReferralCommissionOnTx` não tem chave de
idempotência própria — só não é explorável porque o único chamador já roda
dentro de uma transação que trava a listing por `FOR UPDATE`).

**`servers` teve o pior achado da sessão** — pior que o das salas, porque
aqui não havia verificação NENHUMA, nem cosmética: `POST /api/servers/racks/place`
(`modules/servers/servers.rackAuxIntent.service.ts`, `applyPlaceRackFromStock`,
chamado por `servers.rackAuxIntent.controller.ts`) pega `roomId` **direto do
body**, sem consultar `user_rig_rooms` (dono da sala) nem `rig_rooms.max_capacity`/
`unlocked_slots` (capacidade real) — só confere compatibilidade de chassis NFT
e se o slot já está ocupado, com `slotIndex` limitado só a um intervalo
0–999 fixo. Confirmado lendo o código, incluindo o controller (`roomId =
String(body.roomId ?? '').trim()`, sem nenhuma validação de posse). Qualquer
conta autenticada com chassi em stock montava rack em **qualquer sala paga
nunca comprada**, em quantidade limitada só pelo cap global de 350 racks do
save-game em massa — não pela capacidade real da sala.

**Escopo da correção, e por que não é port verbatim**: a persistência dessa
rota no legado passa por `lib/serverRoomPersistence.ts`
(`persistStockStoredBatteriesPlacedRacks`, 852 linhas) — um motor genérico
de sync de save-game completo, partilhado com o endpoint de save-game em
massa do monólito, cobrindo stock+baterias+racks+leases de ASIC
temporizados+recuperação de peças ao desmontar. O próprio código deles
documenta um bug histórico grave nessa área ("92 racks fantasmas"). Decisão:
não reimplementar esse motor genérico à mão (risco alto demais de introduzir
bug novo numa área historicamente frágil, e fora do escopo do achado real).
Em vez disso, `modules/servers/services/place-rack.ts` é uma implementação
própria e autocontida só pra "colocar 1 rig nova a partir do stock":

- `assertRoomAccessForPlacement` — dono real: `room_initial` (sala grátis
  inicial) sempre libera; senão precisa de linha em `user_rig_rooms` (já
  comprou a sala) OU `isRoomAccessAllowedForUser` (nível/season-pass já dá
  acesso mesmo sem ter comprado slot — mesma regra combinada usada em
  `lib/meUpgradeShopBundlePayload.ts`, `owned || (levelOk && seasonOk)`).
- Capacidade real: `roomCapacity = min(max_capacity, initial_capacity +
  unlocked_slots)`; `slotIndex` tem que caber nela E a contagem de racks já
  colocadas na sala pelo utilizador tem que ser menor que a capacidade —
  as duas verificações que não existiam no legado.
- Tudo numa única transação com `FOR UPDATE` no catálogo e no stock.

**Não migrado nesta leva** (ficam fora, dependem do motor genérico acima ou
do sistema completo de lease de ASIC temporizado, `lib/asicLease.ts` —
só as funções puras de duração já estavam em `shared/utils/lease-duration.ts`):
`GET /api/servers/state` (snapshot, depende também do cron de produção
`computeProgressForUser`), equipar/desequipar peça, remover rack, e o
save-game em massa do monólito. 23 testes novos, incluindo os que travam
especificamente o bloqueio por posse e por capacidade da sala.

## 10. `modules/upgrades/` — corrige o gap de visibilidade já documentado no item #8

Migrado a partir de `modules/upgrades/upgradesPlayer.controller.ts` +
`upgradesState.service.ts` + `upgradesPurchase.service.ts` +
`upgrades.catalog.ts`, mais 2 extrações pontuais de arquivos maiores que
não migraram por inteiro: `loadAdminUpgradesForUser` (de
`lib/meUpgradeShopBundlePayload.ts`, o "bundle" já cortado no item #6/#8 —
só essa função, não o resto) e `materializeUpgradePackageAsLootBoxInTx` (de
`models/adminUpgradeGrantModel.ts`, 419 linhas — só a função de compra, não
`grantPassRewardsInTx`/`expandAdminUpgradeBundleAsLootRewardsInTx`, que são
do fluxo de *abertura* de caixa em `modules/lucky-boxes`, não migrado).

**Corrige o achado do item #8**: `admin_upgrade_visibility` (pacote
exclusivo por `access_level_id`) só era conferida na listagem
(`services/state.ts`, `visibleToUser()`) — a compra
(`services/purchase.ts`, `runUpgradePackagePurchase`) nunca reconsultava.
Agora `assertPackageVisibleToUser` confere isso dentro da mesma transação,
antes de debitar, devolvendo 403 `PACKAGE_ACCESS_DENIED` se a lista de
níveis permitidos não estiver vazia e o utilizador não tiver nenhum deles.

Também extraídos como utilitários genéricos reutilizáveis (não existiam
isolados no legado): `shared/validation/idempotency-key.ts` (só
`parseIdempotencyKey`, de `validation/roletaValidation.ts`) e
`shared/security/stable-fingerprint.ts` (só `stableIntentFingerprint`, de
`lib/gameIntentIdempotencyPrisma.ts` — o resto desse arquivo é a tabela de
idempotência de `servers`, ainda não usada em `current/`).

CRUD admin de pacotes (`POST/PUT/DELETE /api/admin-upgrades`) não migrou —
só a rota do jogador. 40 testes novos, incluindo os que travam
especificamente o bloqueio/liberação por visibilidade.

## 11. `modules/wheel/` — roleta paga + roleta por código promocional

Migrado a partir de dois controllers legados que na prática são o mesmo
domínio (`modules/wheel/wheelPlayerController.ts` +
`controllers/roletaController.ts`), mais as dependências:
`models/roletaModel.ts` (890 linhas), `models/promoRedeemModel.ts`,
`models/wheelIdempotency.ts`, `models/promoCodeRoleta.ts` e
`validation/roletaValidation.ts`. Rotas portadas: `GET /api/wheel/state`,
`POST /api/wheel/spin` (giro pago atómico), `POST /api/wheel/redeem-code`,
`GET /api/wheel/history`, `GET /api/wheel/spins/:spinId`,
`GET /api/roleta/pending-code`, `POST /api/wheel/roll` (giro por código),
`POST /api/roleta/claim`.

**Cortado deliberadamente**: `GET /api/wheel/paid-pending`,
`POST /api/wheel/paid-roll` e `POST /api/wheel/paid-claim` — o fluxo legado
de 2 passos (cobra em `/paid-roll`, entrega em `/paid-claim`, com
`wheel_paid_pending` como estado intermediário). O próprio comentário do
legado em `paidWheelClaimInTransaction` já dizia "o frontend atual já não
chama esta rota" — o giro atómico (`POST /api/wheel/spin`) substituiu esse
fluxo, debitando e entregando na mesma transação. `paidWheelSpinAtomicInTransaction`
já drena qualquer linha residual de `wheel_paid_pending` (auto-cura) antes de
cada novo giro, então não fica saldo cobrado e nunca entregue mesmo sem essas
3 rotas. `resolveRedeemUserIdWheel` (fallback de autenticação por cookie
`sid` quando `req.userId` está ausente, usado só por clientes muito antigos)
também não foi portado — todas as rotas exigem `authenticateToken`.

`grantAdminUpgradeRewards` (entrega direta de itens/moedas/passes ao
resgatar um código ligado a `admin_upgrade_id`) foi substituída por
`materializeUpgradePackageAsLootBoxInTx` (já usada pela compra de pacotes
em `modules/upgrades`, item #10) — em vez de creditar direto, materializa
1 caixa e credita `unopened_boxes`; o jogador recebe o mesmo conteúdo, só
que via abertura de caixa em vez de crédito imediato. `RoletaAppError` foi
substituída por `HttpControlledError` (padrão do resto de `current/server`).
`queryAllWheelPrizesJoined`/`fetchWheelPrizesForAdminWheelEditor` (editor
admin da roleta) não foram portados — sem painel admin migrado ainda.
54 testes novos, cobrindo especialmente os caminhos de dinheiro (saldo
insuficiente não debita, roleta desativada, idempotência de giro pago e de
resgate de código) e a checagem de integridade em `/api/roleta/claim`
(item reivindicado tem que bater com o sorteado, senão 403).

## 12. `modules/lucky-boxes/` — loja/inventário/abertura de caixas + completa o motor de recompensas de pacote admin

Migrado a partir de `modules/lucky-boxes/*` (4 arquivos) + `models/lootBoxModel.ts`
(640 linhas) + `validation/lootBoxValidation.ts`. Rotas: `GET /api/lucky-boxes/state`,
`/shop`, `/inventory`, `/history`, `/openings/:id`, `POST /purchase`, `POST /open`,
`POST /promocodes/redeem`. O legado tem **dois** controllers concorrentes para o
mesmo domínio — `controllers/lootBoxController.ts` (`/api/loot-boxes/*`, rotas de
jogador mais antigas + CRUD admin) e `modules/lucky-boxes/lucky-boxes.controller.ts`
(`/api/lucky-boxes/*`, v2 com idempotência/rate-limit/DTOs versionados) — ambos
registados em paralelo no `server.ts` do legado. Migrei só o v2 (claramente o ativo:
tem idempotência, `version: 1` nos DTOs, rate limiting). `/api/loot-boxes/*` (rotas
antigas de jogador + CRUD admin de catálogo, incluindo `executeLootBoxDiscardInTransaction`/
`LootBoxDiscardError`/descarte de inventário) não foi portado — fica pendente.

`POST /promocodes/redeem` reaproveita `runPromoCodeRedeemInTransaction` de
`modules/wheel/services/promo-redeem.js` (item #11) em vez de duplicar — o legado
já usava a mesma função nos dois controllers (wheel e lucky-boxes).

**Fecha um corte de escopo do item #10** (compra de pacote em `modules/upgrades`):
na época só `materializeUpgradePackageAsLootBoxInTx` foi portada (materializa o
pacote como 1 caixa); `grantPassRewardsInTx`, `expandAdminUpgradeBundleAsLootRewardsInTx`
e `grantAdminUpgradeRewardsInTx` (o motor real de *entrega* — USDC, moedas, items,
caixas-recompensa, season passes + recompensas do pass, access level, e o caso
especial do bundle Genesis que também concede a sala inicial) ficaram de fora porque
só a *abertura* de caixa (aqui, `executeLootBoxOpenInTransaction`) os chama. Os 3
foram adicionados a `modules/upgrades/services/grant.ts` (mesmo arquivo — mesmo
domínio "conceder pacote admin", dois chamadores diferentes: compra materializa
caixa, abertura entrega de facto).

Sem cortes na lógica de rolagem: `rollLootBoxIndependent` (padrão — cada item
avaliado independentemente por `probability`, com fallback pro item de maior
probabilidade se nada ganhar, pra caixa nunca devolver vazia) e `rollLootBoxGrantAll`
(caixas `registration`/`upgrade_package` — entrega tudo com `probability` > 0) foram
portadas verbatim, igual à auto-reparação de caixas de prémio da roleta órfãs
(`trigger = 'roleta_reward'` sem `loot_box_items`) dentro de `executeLootBoxOpenInTransaction`.
62 testes novos (services + controller), incluindo os 3 novos exports de `grant.ts`.

## 13. `modules/email-campaigns/` — campanhas de e-mail em massa (admin)

Migrado a partir de `modules/email-campaigns/emailCampaigns.{service,controller}.ts`
(verbatim). CRUD de campanha + `activate` (popula `email_campaign_deliveries` com
todos os utilizadores com email via `INSERT ... ON CONFLICT DO NOTHING`, idempotente)
+ `pause`/`resume` + `test` (envia até 5 emails de teste) + `send-batch` (lote manual)
+ stats. Todas as 9 rotas ficam sob `/api/admin/email-campaigns/*`, exigindo `isAdmin`.

O transporter SMTP não foi duplicado: reaproveita `shared/security/mailer.ts`
(`export default transporter`), já usado por reset de senha/verificação de email
— o legado tinha dois `nodemailer.createTransport` com a mesma config em arquivos
diferentes (`utils/mailer.ts` e o próprio `emailCampaigns.service.ts`); aqui ficou
só um. `resolvePublicBaseUrl` (helper de 4 linhas pra montar o link de unsubscribe)
ficou local ao módulo — não vale a pena promover a compartilhado por uma função tão
pequena, e o legado também a duplicava em vez de exportar de `mailer.ts`.

`runDailyBatchForAllCampaigns()` (dispara o lote diário de todas as campanhas ativas,
respeitando um teto global `EMAIL_DAILY_GLOBAL_LIMIT`) foi portada mas **não está
agendada** — não existe `cron/` em `current/server` ainda para chamá-la; fica pronta
para o bootstrap disparar quando o cron migrar (mesma situação de `accrueManagerMiningShare`
em `modules/account-manager`, item anterior). 32 testes novos.

## 14. `modules/shop/` — Lojinha Miner (catálogo + carrinho + checkout atômico) e corte no item ASIC de aluguer temporizado

Migrado a partir de `modules/shop/*` (7 arquivos), verbatim exceto o checkout.
11 rotas: `GET /state|/products|/products/:id|/orders/:id`,
`POST/PATCH/DELETE /cart/items(/:lineId)`, `DELETE /cart`, `POST /checkout`.

**Corte de escopo deliberado no checkout**: comprar um item ASIC configurado
com aluguer temporizado (`asic_duration_kind`/`asic_duration_amount`) no
legado cria leases via `createAsicLeasesOnPurchase`/`syncTimedAsicStockForItem`
(`lib/asicLease.ts`, 700+ linhas — o motor completo de criação/expiração de
leases, partilhado com `batteries`/`servers`, nenhum dos dois migrado por
inteiro ainda). Reimplementar esse motor só pro checkout está fora de escopo
— mesmo raciocínio do corte em `modules/servers/place-rack.ts` (item #9).
Em vez de creditar silenciosamente stock permanente (errado: cobraria preço
de aluguer por posse permanente) ou aceitar o pagamento sem entregar nada,
`runHardwareCheckoutTransaction` agora **recusa** essas linhas de forma
controlada — 422, `code: 'ASIC_LEASE_NOT_SUPPORTED'` — sem debitar USDC nem
tocar em stock limitado. A deteção usa só as funções puras de classificação
de `lib/asicLease.ts` (`normalizeAsicDurationConfig`/`isTimedAsicDuration`)
mais `isAsicMachineUpgradeRow` (já em `modules/mining-engine`, migração do
dashboard). **Correção 2026-08-15**: essas funções já tinham sido extraídas
antes, na migração de `modules/checkin`, para `shared/utils/lease-duration.ts`
— eu tinha esquecido e recriado uma cópia quase idêntica em
`shared/utils/asic-duration.ts` (mesmas 4 funções, faltando só
`durationMsForConfig`/`formatAsicDurationLabelPt`). Consolidado: `checkout.ts`
agora importa de `lease-duration.ts`, o arquivo duplicado foi apagado, e o
teste unitário ganhou cobertura para as 2 funções que faltavam. Todo o resto
do checkout (preço/stock sempre relidos da BD com
`FOR UPDATE`, idempotência via `pg_advisory_xact_lock` + fingerprint estável
do carrinho, limite `max_global_stock` pra itens `limited`) é port verbatim.

`pool: Pool` deixou de vir por `deps` do controller — `services/checkout.ts`
importa o singleton `core/database/pool.js` diretamente, mesmo padrão já
usado por `modules/servers/services/place-rack.ts`.

Dois utilitários genéricos extraídos ao portar este módulo:
`shared/http/public-asset-url.ts` (`normalizePublicAssetUrl`, de
`lib/publicAssetUrl.ts`) e `shared/security/advisory-lock-key.ts`
(`computeAdvisoryLockKey64`, de `modules/wallet/walletLocks.ts` — 2ª
ocorrência do mesmo algoritmo FNV-1a no legado, a 1ª já vivia só dentro de
`modules/wheel/services/idempotency.ts` como `wheelAdvisoryLockKey64`,
propositalmente deixada intocada em vez de refatorada pra reusar a nova
função — não vale o risco de mexer em código já testado por 15 linhas).
69 testes novos, incluindo os que travam especificamente a recusa do item
ASIC temporizado e a idempotência do checkout (replay + mismatch de payload).

## 15. `modules/wallet/` completo — o corte do item #8 já não se aplicava

Item #8 tinha deixado `GET /api/wallet/history` e `POST /api/wallet/exchange/liquidate`
de fora por dependerem de "infraestrutura própria não portada": `wallet_idempotency` +
`pg_advisory_xact_lock`. Isso deixou de ser verdade nas migrações seguintes — `modules/wheel`
(item #11) já tinha portado `stableIntentFingerprint` (`shared/security/stable-fingerprint.ts`)
e `modules/shop` (item #14) já tinha extraído o algoritmo de lock consultivo genérico
(`computeAdvisoryLockKey64`, `shared/security/advisory-lock-key.ts`). Migrado
`modules/wallet/walletExchangeLiquidation.ts` + `walletDeskPercent.ts`, verbatim
(`RoletaAppError` → `HttpControlledError`, incluindo o `code: 'IDEMPOTENCY_PAYLOAD_MISMATCH'`
+ `forceReload: true` do 409 de mismatch), reaproveitando as duas peças que já existiam
em vez de as duplicar de novo. `resolveMiningCoinUsdRate` (`modules/mining-engine`) e
`wallet_idempotency`/`wallet_ledger_entries` (schema Prisma) já estavam prontos desde a
migração do dashboard. Módulo `wallet` fica com as 3 rotas completas:
`GET /state|/history`, `POST /exchange/liquidate`. 25 testes novos.

## 16. `modules/partners/` — vitrine/candidatura/envio de vídeos de Parceiros YouTube, sem upload em disco

Migrado a partir de `modules/partners/*` (5 arquivos, exceto o controller
verbatim) + subconjunto de `models/partnerYoutubeModel.ts` (668 linhas) +
`utils/partnerYoutubeHelpers.ts`. Rotas: `GET /api/partners/state|/videos|
/videos/:id|/my-submissions`, `POST /videos/submit`, `POST /youtube/apply`,
`PUT /youtube/my-profile`.

**Corte de escopo — `POST /api/partners/youtube/avatar-upload` não migrada**:
essa rota usa `multer` (disk storage) para o parceiro enviar a capa do canal
diretamente do disco. `multer` não é dependência de `current/server` — nenhum
módulo migrado até agora precisou de upload de ficheiro, e introduzir a
infraestrutura (dependência nova, `uploadsDir` de bootstrap, serving estático
de `/img/...`) só para esta rota seria decidir uma peça de infraestrutura
transversal ao projeto isoladamente, dentro do escopo de um módulo pequeno.
O fluxo não fica quebrado: `avatarUrl` (em `/youtube/apply` e `/youtube/my-profile`)
já aceita tanto uma URL https quanto um caminho relativo já hospedado
(`sanitizePartnerCreatorAvatarUrl`) — só o atalho "carregar do disco local
direto no formulário" fica pendente até a infraestrutura de upload ser
desenhada de propósito (provavelmente quando `modules/support`/`modules/chat`,
que também precisam dela, migrarem).

**Corte de escopo — painel admin não migrado**: `listPartnerYoutubeSubmissionsForAdmin`,
`updatePartnerYoutubeApprove`/`Reject`, `deletePartnerYoutubeSubmission`,
`listPartnerYoutubePartnersForAdmin`, allowlist manual
(`addPartnerYoutubeManualAllowlist`/`removePartnerYoutubeManualAllowlist`),
`grantPartnerNftRoomAccess`, `ensurePartnerAccessLevel`, e as duas ações de
`runPartnerYoutubeApplicationApprove`/`Reject` — todas só chamadas por um
controller admin que não existe neste levantamento. `ensurePartnerYoutubeSchema`
(DDL manual `CREATE TABLE IF NOT EXISTS`) também não portada — as 4 tabelas
já existem via migration Prisma (`partner_youtube_submissions/creator_profiles/
applications/manual_allowlist`), mesmo padrão já usado em `modules/quests`.
52 testes novos.

## 17. Faxina em `shared/` — 3 duplicatas encontradas numa pesquisa dedicada (pedido do usuário)

O usuário pediu uma varredura minuciosa em `shared/` atrás de arquivos quase
idênticos que dessem pra juntar. Achados (todos confirmados contra o legado
antes de mexer — nenhum dos 3 vem de duplicação que já existia lá, todos
foram introduzidos nesta migração por eu não checar se a extração já tinha
sido feita antes noutro módulo):

1. **`shared/utils/asic-duration.ts` duplicava `shared/utils/lease-duration.ts`**
   quase char-a-char (`normalizeAsicDurationConfig`/`isTimedAsicDuration` e
   helpers — faltavam só `durationMsForConfig`/`formatAsicDurationLabelPt`).
   No legado é **um único arquivo**, `lib/asicLease.ts`, consumido por
   `checkin`, `shop` e `servers` — confirmado via grep antes da correção.
   `lease-duration.ts` já existia desde a migração de `modules/checkin`; ao
   migrar `modules/shop` (item #14) eu não fui checar e recriei uma cópia.
   Apagado `asic-duration.ts`, `shop/services/checkout.ts` agora importa de
   `lease-duration.ts`; o teste (que nem cobria as 2 funções que faltavam)
   virou `lease-duration.test.ts` com a cobertura completa.

2. **`modules/wheel/services/validation.ts` tinha uma cópia local de
   `parseIdempotencyKey`** idêntica a `shared/validation/idempotency-key.ts`
   (extraída antes, na migração de `modules/upgrades`, item #10 — anterior à
   migração de `modules/wheel`, item #11). Trocado por um re-export.

3. **`modules/partners/services/youtube-url.ts` redefinia `YOUTUBE_VIDEO_ID_RE`**
   já presente em `modules/partners/services/helpers.ts` — as duas no mesmo
   módulo, escritas na mesma sessão. No legado a regex nem era uma constante
   nomeada (estava inline 3x dentro de `extractYoutubeVideoId`); nomeá-la foi
   melhoria minha, só que duplicada sem querer. `helpers.ts` agora exporta a
   constante e `youtube-url.ts` importa em vez de redefinir.

**Não consolidado** (mesma pesquisa, decisão deliberada — ver corpo dos
arquivos): `advisory-lock-key.ts` (`shared`) coexiste de propósito com
`wheelAdvisoryLockKey64` (cópia local em `modules/wheel/services/idempotency.ts`)
— mesmo algoritmo FNV-1a, mas refatorar um módulo já testado só para reusar
15 linhas não valia o risco; documentado desde a extração (item #14).
`security/cloudflare-turnstile.ts`, `security/signup-proxy-vpn-guard.ts`,
`security/auth-flow-secret.ts` parecem parecidos à primeira vista (todos
"serviço externo, devolve `{ok, status, error}`") mas resolvem problemas
genuinamente diferentes — juntar pioraria a legibilidade.

**Achado maior, resolvido à parte com confirmação do usuário**: a função
`uidNum`/`uidOptional`/`uidRequired` (extrai e valida `req.userId`) estava
copiada, corpo idêntico, em **18 controllers** — fiel ao legado, que já
tinha essa mesma repetição em cada `*.controller.ts` (cada um seu próprio
`function uidNum(...)`). Extraída para `shared/http/request-user-id.ts`
(`resolveRequestUserId`); os 18 controllers foram atualizados para
`import { resolveRequestUserId as uidNum } from '.../request-user-id.js'`
(mantendo o nome local de cada um — `uidNum`/`uidOptional`/`uidRequired` —
pra não mexer no corpo das rotas). Nenhum teste de controller precisou
mudar (todos testam via `fakeApp`/rota, não mockam a função interna).
4 testes novos para `resolveRequestUserId`; suíte completa: 1096 testes.

## 18. `modules/inventory/` — snapshot de estoque + baterias em armazém, sem o tick de mineração

Migrado a partir de `modules/inventory/inventory.{controller,snapshot.service,types}.ts`
(`GET /api/inventory/state`). Trouxe junto um novo módulo parcial
`modules/batteries/` (só `services/catalog.ts`, `services/invariant.ts`,
`services/legacy-temp-stock.ts` — sem controller nem rota própria ainda),
subconjunto de `modules/batteries/{batteries.catalog,batteryInvariant.service}.ts`
+ `lib/legacyTempStock.ts` do legado, usado só para classificar quais
instâncias de bateria aparecem no armazém e remapear ids de bateria
descontinuados pro catálogo canónico (`battery_estelar`).

**Corte de escopo deliberado**: o legado chama `computeProgressForUser(pool,
userId, ...)` (`cron/miningProgressComputer.ts`, 677 linhas — o motor real de
produção de mineração, não migrado) antes de montar o snapshot, pro stock/USDC
estarem no mesmo tick usado por `GET /api/game-state`. Omitido aqui. Impacto
verificado como mínimo: nenhum campo deste DTO (`stock`, `storedBatteries`) é
escrito pelo tick — só `game_states.usdc`/`coin_balances` são, e `serverUpdatedAt`
já vem direto de `game_states.last_updated_at`/`server_updated_at` sem precisar
do tick rodar primeiro. `GET /api/inventory/me` (rota de compatibilidade do
monólito) e `inventoryStockAudit.ts` (diff de stock do save-game em massa,
`auditStockSaveDelta`) também não portados — o segundo só é chamado pelo
endpoint de save-game em massa, fora de escopo (mesma família de cortes de
`modules/servers`/`modules/shop`, item #9/#14). 23 testes novos.

## 19. `/api/loot-boxes/*` legado (`controllers/lootBoxController.ts`) — só o descarte fechado, resto cortado

Revisitado ao fechar a lista de domínios pendentes. Esse controller legado
tinha 3 rotas de jogador (`open`/`buy`/`discard`, sem idempotência nem
rate-limit) + 2 rotas admin (`POST /api/loot-boxes` upsert de catálogo,
`DELETE /api/admin/loot-boxes/:id` delete em cascata).

- `open`/`buy`: **não portadas** — `modules/lucky-boxes` (item #12) já cobre
  o mesmo fluxo pela rota v2 (`POST /api/lucky-boxes/open|purchase`), com
  idempotência e rate-limit que o legado antigo nem tinha. Portar de novo
  criaria duas rotas concorrentes fazendo a mesma coisa, uma delas pior.
- `discard`: **portada agora** — era a única funcionalidade real que faltava
  (descartar unidades de caixa não abertas do inventário). Adicionada a
  `modules/lucky-boxes/services/loot-box.ts` (`executeLootBoxDiscardInTransaction`
  + `LootBoxDiscardError`, verbatim) e exposta como `POST /api/lucky-boxes/discard`
  — a validação (`bodyOptionalDiscardQty`) já estava portada e sem uso desde
  o item #12. 7 testes novos.
- CRUD admin de catálogo (upsert com warnings de coerção `isActive`, delete
  em cascata com `isLootBoxBrokenForSafeDelete`): **não portado** — painel
  admin, mesmo corte consistente aplicado a todo `current/server` (guide,
  roadmap, upgrades, black-market, partners, etc.).

## 20. Resto de `modules/servers/`/`modules/batteries/` — bloqueado, mesma causa raiz do item #9

Revisitado ao varrer a lista final de domínios pendentes.

`modules/batteries/batteries.controller.ts` (`POST /api/server-room/bulk-batteries`
— preencher/remover baterias numa sala inteira de uma vez, com "preenchimento
inteligente") depende inteiramente de `lib/serverRoomPersistence.ts`
(`loadUserStock`/`loadUserStoredBatteries`/`loadUserPlacedRacksWithSlots`/
`persistStockStoredBatteriesPlacedRacks`) — o mesmo motor de 852 linhas já
cortado no item #9 pro `place-rack.ts`. Diferente de `place-rack.ts` (que deu
pra reescrever autocontido só pra "colocar 1 rig"), este endpoint é uma
mutação em lote genérica sobre stock+baterias+racks — não há fatia estreita
pra reescrever à mão sem recriar o motor inteiro. Não portado.

O resto de `modules/servers/servers.rackAuxIntent.controller.ts` (remover
rack, equipar/desequipar minerador, equipar/desequipar peça aux, equipar/
remover bateria de slot) depende do mesmo `serverRoomPersistence.ts` pelas
mesmas razões — todas as 7 rotas restantes. Não portado.

`GET /api/servers/state` (`servers.snapshot.service.ts`, 262 linhas) é
diferente — não usa `serverRoomPersistence.ts` — mas chama
`computeProgressForUser` (cron não migrado, mesmo corte do item #18) **e**
depende de mais duas funções nunca extraídas de arquivos grandes:
`loadMyRigRoomsForUser` (`lib/meUpgradeShopBundlePayload.ts`, 270 linhas —
só essa função usa SQL cru pra juntar acesso por nível/season-pass/salas com
rack já colocado) e `loadMiningCoinsForBootstrap`/`loadUpgradesForBootstrap`
(`lib/publicBootstrapPayload.ts`, 473 linhas). Ao contrário do corte em
`modules/inventory` (item #18, onde o campo afetado pelo tick não aparecia
no DTO), aqui `gs.usdc` — que o tick escreve — é exposto diretamente; cortar
o tick teria o mesmo efeito de staleness que `modules/dashboard`/`modules/wallet`
já têm hoje (nenhum migrado roda o tick, então esse atraso já existe em todo
`current/server`, não é regressão nova). Mesmo assim, o custo de extrair as
2 funções de apoio (743 linhas de origem) ultrapassa o que compensa nesta
passada — fica para quando `modules/rooms`/`modules/upgrades` tiverem motivo
de reaproveitar essas mesmas funções (parte da lógica de `loadMyRigRoomsForUser`
já se sobrepõe com `resolveUserRoomAccess`/`isRoomAccessAllowedForUser`,
já portadas em `modules/rooms`).

## 21. `modules/support/` — tickets de jogador, sem upload de anexo

Migrado a partir de `modules/support/{supportPlayer.controller,supportState.service}.ts`
+ subconjunto de `models/{supportMutationModel,supportTicketModel}.ts` +
`lib/{supportUploadLimits,supportTicketAttachments}.ts` (só as constantes
`SUPPORT_UPLOAD_MAX_BYTES/FILES`/`SUPPORT_ALLOWED_EXT`, informativas no DTO).
5 rotas: `GET /state|/tickets`, `POST /tickets`, `POST /tickets/:id/messages`,
`POST /tickets/:id/archive|/reopen`.

**Corte de escopo — anexos**: mesma decisão de `modules/partners` (item #16)
— `multer` ainda não é dependência de `current/server`. `POST /tickets` e
`POST /tickets/:id/messages` funcionam só com texto (`attachments` sempre
`[]`); a validação de reply já exigia "mensagem OU anexo", então sem anexo
passa a exigir só mensagem — sem quebra de comportamento visível, só menos
opções. `GET /api/support/attachments/download` (download autenticado,
`supportAttachmentsProxy.ts`) não portada — nada para descarregar sem upload.

**Corte de escopo — painel admin**: `supportTicketModel.ts` tinha ~250 linhas
de funções só de admin (listar/responder tickets, stats, histórico por
utilizador) — nenhuma portada, mesmo corte de sempre.

Idempotência (`support_submission_idempotency` + lock consultivo por hash
SHA-256, diferente do FNV-1a usado em `wheel`/`shop`/`wallet` — mantido
igual ao legado, arquivo próprio deste domínio) é port verbatim. 21 testes
novos.

## 22. `modules/chat/` — chat em tempo real via Socket.IO, sem mensagem de áudio

Fecha a lista de 6 domínios pendentes (só falta `cron/`, tratado à parte —
ver item #23). Migrado a partir de `modules/chat/{chat.service,chat.auth,
chat.socket,chat.controller}.ts`, verbatim na lógica.

**Encaixe na infra já existente**: `core/socket/attach.ts` (item #4, "Socket.IO
desacoplado de módulo de domínio") já preparava exatamente este encaixe —
`registerChatSocketHandlers(io)` é chamado uma vez no bootstrap (não por
conexão) e regista `io.on('connection', ...)` internamente; nenhuma mudança
foi necessária em `core/socket/`. `chat.auth.ts` (resolução do `ChatActor` a
partir dos cookies do handshake) reaproveita `modules/auth` (`verifyAccessToken`/
`COOKIE_ACCESS`) e `modules/account-manager` (`loadSessionManagerFlags`) —
nenhuma duplicação, ambos já existiam e encaixaram sem alteração de assinatura.

**Corte de escopo — mensagem de áudio**: `POST /api/chat/audio` (upload via
multer + validação de assinatura binária do ficheiro) não portada — mesma
decisão de `modules/partners`/`modules/support` (multer ainda não é
dependência de `current/server`). Diferente dos outros dois casos, aqui o
corte é limpo: os handlers de Socket.IO (`chat:subscribe`/`send`/`edit`/
`delete`) são **100% independentes** de upload — o chat de texto em tempo
real (a funcionalidade central) fica inteiro. Só a opção "gravar e enviar
áudio" fica pendente.

**Corte de escopo — schema**: `ensureChatSchema()` deixou de fazer `CREATE
TABLE IF NOT EXISTS` — `chat_messages` já existe via migration Prisma
(mesmo padrão de `modules/quests`/`modules/partners`); mantida como no-op
assíncrono só para preservar a assinatura chamada pelo controller e pelos
handlers de socket.

**Não portado**: `purgeExpiredChatMessages` (limpeza de mensagens com mais
de 1h) foi migrada como função de serviço mas **não tem chamador** — no
legado corria via `cron/chatTtlCron.ts` (112 linhas), que faz parte do
mesmo bloco de `cron/` ainda não migrado (ver item #23); fica pronta para
quando o cron migrar, mesma situação de `accrueManagerMiningShare`
(`modules/account-manager`) e `runDailyBatchForAllCampaigns`
(`modules/email-campaigns`). 35 testes novos.

## 23. `cron/` — motor de produção de mineração, decisão final: não migrado nesta leva

Fecha o levantamento dos domínios pendentes. `cron/miningProgressComputer.ts`
(677 linhas) é o motor real que avança produção, decrementa carga de bateria
e mantém `game_states`/`stock`/`coin_balances` atualizados — é a peça que
`modules/inventory` (#18), `modules/dashboard`/`modules/servers` (#20) e
várias outras já cortaram, sempre com a mesma nota: "sem regressão nova,
`current/server` já não roda o tick em lugar nenhum". `cron/miningYieldCron.ts`
(440 linhas) e os outros 8 arquivos de `cron/` (`accountManagerPayoutCron`,
`chatTtlCron`, `emailCampaignCron`, `inactiveAutoBlockCron`,
`miningDistributionRollupCron`, `miningGlobalStatsStore`, `miningNumeric`,
`miningScheduler`, `miningWallClockGrid`) dependem, direta ou indiretamente,
desse motor.

Não migrado por decisão explícita de risco: o próprio código legado documenta
um bug histórico grave nessa área ("92 racks fantasmas", citado já no item #9),
e o motor é sensível a precisão numérica/tempo-real de um jeito que nenhum
outro domínio migrado até agora exigiu — reescrevê-lo de memória, sem os
72 testes de regressão que o legado tem para essa área especificamente,
seria o maior risco assumido em toda a migração. Cada função que dependeria
dele (`accrueManagerMiningShare`, `runDailyBatchForAllCampaigns`,
`purgeExpiredChatMessages`, e o snapshot completo de `GET /api/servers/state`)
já está pronta e documentada, esperando só o cron. Fica como trabalho futuro
dedicado, não uma tarefa a encaixar entre outras migrações de módulo.

**Actualização (#24): decisão revertida por instrução explícita** — o motor
foi migrado. Ver item #24 abaixo.

## 24. `cron/miningProgressComputer.ts` → `modules/mining-engine/services/progress-computer.ts` — motor de produção migrado

Reverte a decisão do item #23 por instrução explícita do dono do projeto.
Porta `computeProgressForUser`/`calculateIntegratedYield` (677 linhas do
legado) de forma verbatim na lógica de cálculo/crédito — o mesmo risco que
motivou o adiamento em #23 permanece real (dinheiro do jogo é criado aqui),
por isso a migração seguiu byte-a-byte o algoritmo legado em vez de
reescrevê-lo, preservando todas as proteções: lock distribuído por utilizador
(`REDIS_LOCK_KEYS.miningProgressUser`), `FOR UPDATE` + re-verificação de
`last_updated_at` antes de creditar (corrida entre pedidos concorrentes),
tecto de janela offline de 72h (`MAX_EARNING_WINDOW_MS`, anti-farm em
reconexões longas), grelha de crédito alinhada a blocos de 10 min UTC
(`miningCreditCapNowMs`), congelamento por ciclo de check-in
(`isCheckinFrozenForUser`), e idempotência via
`mining_progress_commit_ledger` (chave `mp:{userId}:{last}:{lastWrite}`).

**Todas as dependências já estavam portadas** por módulos anteriores desta
mesma leva de migração — nada foi duplicado: `tryAcquireDistributedLock`/
`releaseDistributedLock`/`REDIS_LOCK_KEYS` (`core/redis/lock.ts`),
`isCheckinFrozenForUser` (`modules/checkin`), `effectiveHashWithCheckinBonus`/
`sumNonNftRoomRigHashHps` (`modules/mining-engine/services/checkin-bonus-hash.ts`),
`listSlotMiningCredits`/`resolveNftAutoArmario1OnlyRoomIds`/
`resolveMiningCoinUsdRate`/`isNftMiningRoomId` (`modules/mining-engine/services/nft-room-mining.ts`),
`accrueManagerMiningShare` (`modules/account-manager`, portado no item #16
sem chamador até agora — este é o chamador).

**Novos ficheiros pequenos portados junto** (dependências que ainda não
existiam): `modules/mining-engine/services/mining-numeric.ts`
(`parseFiniteNumberLenient`), `wall-clock-grid.ts` (`miningCreditCapNowMs`),
`runtime-stats.ts` (`miningRuntimeStats`, fica vazio até `miningYieldCron.ts`
migrar — tolerado via fallback ao `network_hashrate` configurado em
`mining_coins`), `mining-coins-cache.ts` (`getMiningCoinsActiveMap`, Redis+Prisma),
e `shared/redis/json-cache.ts` (helper genérico get/set/del com TTL,
degrada para no-op sem Redis).

**Gap de schema (`mining_block_history`)**: tal como `mining_progress_commit_ledger`
noutros pontos do legado, esta tabela nunca foi tracked no `schema.prisma`
(nem legado nem `current/`) — é criada via DDL manual em
`legacy/backend/config/initDb.ts` (nunca portado). Aplicado o mesmo padrão
defensivo que o próprio legado já usava para `mining_progress_commit_ledger`:
`INSERT` dentro de `SAVEPOINT`, catch de erro Postgres `42P01` (tabela
ausente) com `ROLLBACK TO SAVEPOINT` + aviso único, sem falhar o crédito
principal. Se a tabela não existir na BD de destino, o histórico granular
por janela fica ausente mas `coin_balances`/`game_states` são creditados
normalmente.

**Ligado a `modules/inventory`**: `buildInventoryStateV1` volta a chamar o
tick antes de montar o snapshot (`tickMiningProgressBeforeSnapshot`, com
`skipIfRecentMs=5000` pra não recalcular a cada poll rápido), desfazendo o
corte documentado no item #18 — envolto em try/catch: falha do tick nunca
bloqueia a leitura do inventário, só regista aviso.

**Ainda não migrado nesta leva** (não bloqueiam `computeProgressForUser`,
que já tem fallback pra funcionar sem eles): `miningYieldCron.ts` (440
linhas, curva de yield por rede — sem ele, `calculateIntegratedYield` cai no
`fallbackYieldPerHashByCoin` calculado a partir de `mining_coins`) e
`miningScheduler.ts` (agendamento periódico do tick em background — por
agora o tick só corre disparado por pedido, ex.: `GET /api/inventory/state`,
não em intervalo fixo). `GET /api/servers/state` continua bloqueado por
`lib/serverRoomPersistence.ts` (852 linhas, item #20) — motivo separado, não
resolvido por este item. 20 testes novos cobrindo idempotência do ledger,
corrida via `FOR UPDATE`, tecto de janela offline, congelamento por
check-in, actualização de `is_on` em racks com moeda inactiva, chamada ao
`accrueManagerMiningShare`, e degrade em `42P01` tanto do ledger quanto de
`mining_block_history`.

## 25. `modules/admin/` — início da migração, escopo real maior que o esperado

Ao começar a migrar `modules/admin/` (as 7 pastas placeholder já existentes:
`backup/`, `image-asset/`, `mining-distribution/`, `referral/`,
`security-bulk/`, `suspicious-emails/`, `user-audit/`), o levantamento do
legado revelou ~6000 linhas no total — bem mais do que os nomes das pastas
sozinhos sugeriam:

- `controllers/adminReferralController.ts` — 930 linhas (o maior).
- `services/adminUserAccountTrace.service.ts` — 890 linhas.
- `modules/admin/suspiciousEmails/suspiciousEmailsAdmin.service.ts` — 767 linhas.
- `services/adminMiningDistribution.service.ts` — 699 linhas.
- `controllers/backupController.ts` + `models/backupModel.ts` — 723 linhas.
- `controllers/imageAssetController.ts` + `models/imageAssetModel.ts` — 559 linhas.
- `controllers/adminUserAudit.controller.ts` + `services/adminUserInventoryAudit.service.ts` — 404 linhas.
- `controllers/adminSecurityBulk.controller.ts` — 235 linhas (o menor, migrado primeiro).
- `controllers/deviceFingerprintAdminController.ts` — 36 linhas.
- `utils/adminRouteAuth.ts` — 190 linhas: **mapa de permissões por rota** (`resolveAdminRouteRequirement`) usado pelo middleware `isAdmin` em praticamente toda rota `/api/admin/*` do app inteiro (não é específico de nenhuma das 7 pastas) — precisa migrar antes ou junto do middleware `isAdmin` real (ainda não implementado em `current/`, todo módulo até agora só recebe `isAdmin: RequestHandler` como dependência injetada, nunca a implementação).

Decisão: migrar sequencialmente, do menor pro maior, mesmo padrão do resto da
sessão (arquivo por arquivo, ritual completo, DECISIONS.md + MIGRATION_TRACKER.md
por item). `utils/adminRouteAuth.ts` fica para quando o middleware `isAdmin`
real for implementado — até lá, cada submódulo de admin só declara a
dependência `isAdmin: RequestHandler`, como os módulos já migrados.

### `modules/admin/security-bulk/` — migrado (1º submódulo)

7 rotas: `GET/POST /api/admin/security/bulk-tools/config`,
`GET /api/admin/security/inactive-block/preview`,
`POST /api/admin/security/inactive-block/apply`,
`GET /api/admin/security/force-password-reset/preview`,
`POST /api/admin/security/force-password-reset/apply`. Bloqueio de contas
inativas (dias configuráveis, exclui admin/super-admin) e reset forçado de
senha de jogadores (1 única hash bcrypt pra todos os alvos — evita milhares
de `bcrypt.hash` sequenciais/timeout numa base grande; jogadores usam
"Esqueci a senha" depois). Verbatim na lógica; único ajuste: `$queryRawUnsafe`/
`$executeRawUnsafe` do legado trocados por `$queryRaw`/`$executeRaw` com
`Prisma.sql`/tagged template (parâmetros já eram só valores internos, mas o
padrão do projeto pede tagged template — ver itens #3/#4/#12 do
`CODE_REVIEW_BACKLOG.md`, mesma categoria de achado, corrigido de saída
em vez de introduzir de novo). Reaproveita
`shared/settings/settings-repository.ts` (`getSettingValue`/`upsertSettingsEntries`,
já existente desde `modules/shop`) em vez de duplicar acesso a `settings`.
23 testes novos.

### `modules/admin/mining-distribution/` — migrado (2º submódulo)

7 rotas: `GET /api/admin/mining-distribution/{overview,by-coin,timeline,credits,
credits/export.csv,users/:userId/summary}` + `POST .../rebuild-rollups`.
Relatórios de distribuição de créditos de mineração, lidos de
`mining_block_history` (as janelas gravadas por
`modules/mining-engine/services/progress-computer.ts`) e agregados em
`mining_distribution_daily` (rollup diário, esse sim tracked no Prisma).
Verbatim na lógica de agregação/CSV/paginação; ajustes:
- `$queryRawUnsafe`/`$executeRawUnsafe` → `$queryRaw`/`$executeRaw` com
  `Prisma.sql`/tagged template (mesmo padrão já aplicado no resto da sessão).
- **`mining_block_history` não é tracked no `schema.prisma`** (mesma tabela
  gap já documentada no item #24) — todas as leituras deste submódulo
  degradam graciosamente pra vazio/zero em vez de 500 se a tabela não
  existir na base de destino (catch de `P2021` via Prisma nas leituras,
  `42P01` via raw `pg` no rebuild de rollups — códigos diferentes pro mesmo
  problema, dependendo de qual client fez a query). Isso é reporting
  admin, não o caminho de crédito real — degradar é seguro aqui.
- 3 pontos que o controller legado detectava erro de "intervalo inválido"
  comparando a mensagem (`msg.includes('Intervalo')`) — trocado por
  `HttpControlledError(400, ...)` lançado direto do service
  (`validateCreditsRange`), controller usa `respondIfHttpControlledError`
  (mesmo anti-padrão já corrigido no `CODE_REVIEW_BACKLOG.md`, evitado de
  saída em vez de introduzido de novo).
- `pool: Pool` do rebuild de rollups deixou de vir por parâmetro — importa
  `core/database/pool.js` directamente (mesmo padrão do resto do projeto).

41 testes novos.

### `modules/admin/user-audit/` — parcialmente migrado (3º submódulo, corte de escopo)

Só `GET /api/admin/users/:userId/inventory-audit` foi portada — é a única das
4 rotas do controller legado (`adminUserAudit.controller.ts`) que é
autocontida (lê só `inventory_movements`/`upgrades`, ambos já em
`current/`). As outras 3 (`GET /api/admin/user-activity`,
`.../session-snapshots`, `.../account-trace`) dependem de infraestrutura
ainda não migrada:

- `lib/mongoLogs.ts` (`listAdminUserActivityLogsMongo`,
  `listSessionSnapshotsMongo`, `getGenesisMongo`) — listagem/paginação de
  activity logs a partir do MongoDB, distinta de `core/mongo/logs.ts`
  (que só grava, não lista/pagina).
- `lib/activityEventFormatter.ts` (`formatActivityEvent`,
  `matchesActivityFilter`) — formatação/categorização de eventos de log
  pra exibição no painel.
- `services/playerStateSnapshot.service.ts` (`diffSnapshotInventory`) —
  diff entre snapshots de estado de jogador.
- `services/adminUserAccountTrace.service.ts` (890 linhas — o maior
  arquivo do lote de `modules/admin/`) — cruza todas as dependências
  acima, mais consultas próprias de rastreio de conta (P2P, sessões,
  timeline unificada). Migrar essas 3 rotas exigiria portar as 4
  dependências juntas — fora de escopo desta leva, mesmo raciocínio dos
  cortes já feitos em `modules/servers`/`modules/batteries` (item #20) e
  `cron/miningYieldCron.ts` (item #24).

7 testes novos (o service portado + o controller).

### `modules/admin/image-asset/` — parcialmente migrado (4º submódulo, corte de escopo)

Portados: classificação/organização de `img/` (`classifyImageSubfolder`,
`organizeLooseFilesInImgRoot`), middleware de estáticos com fallback pra
`.webp` já convertido manualmente e resolução de URLs antigas sem subpasta
(`mountImageStaticMiddleware`), e `POST /api/upload-image` — a única rota do
controller original que não depende de `multer` (usa data URL/base64 no
corpo JSON, não multipart).

**Cortado**: `POST /api/admin/upload-image` (upload de arte de item/editor) e
`POST /api/admin/upload-ad` (banner) — ambas usam `multer` (multipart/disco),
que ainda não é dependência de `current/server` (mesmo corte já feito em
`modules/partners` — avatar-upload, `modules/chat` — áudio, `modules/support`
— anexos; padrão consistente: nenhum módulo até agora precisou de fato de
upload multipart). Também cortada a conversão automática pra `.webp` no
upload (`convertRasterFileToWebp`/`compressMediaFileInPlace`, ambas
dependem de `sharp`, também não instalado em `current/`) — imagens são
gravadas tal como enviadas; o fallback de *leitura* pra `.webp` já
convertido manualmente (por outro processo/versão) continua funcionando via
`services/static-serving.ts`, que só precisa dos helpers puros de
`services/webp-paths.ts` (`isConvertibleRasterExt`/`webpSiblingPath`/
`publicPathToWebp`, sem `sharp`).

37 testes novos, incluindo os middlewares de fallback exercitados com
filesystem real (tmp dir) em vez de mocks.

### `modules/admin/backup/` — parcialmente migrado (5º submódulo, corte de escopo confirmado com o dono do projeto)

**Portado**: `GET /api/admin/backups` (listar), `POST /api/admin/backup`
(criar via `pg_dump`), `DELETE /api/admin/backups/:filename` (apagar),
`GET /api/admin/backups/download/:filename` (baixar) — mais o agendamento
automático diário (`startScheduledSqlBackups`, um `pg_dump` por dia com
advisory lock Postgres pra não duplicar entre réplicas; exportado, ainda
sem ser chamado por nenhum bootstrap — `current/server` não tem um
`server.ts` de entrada montado ainda). `resolveSafeBackupPath` (protecção
contra path traversal via `path.basename` + confinamento ao directório de
backup) migrado verbatim.

Consolidados 3 arquivos pequenos do legado num só,
`services/postgres-cli.ts`: `config/postgresCliPaths.ts` (`resolveUnixPostgresCli`)
+ `config/pgDump.ts` (`getPgDumpPath`) + a parte de
`config/database.ts:getPostgresCliSpawnOptions` — só o suficiente pra
`pg_dump`, sem `psql`/`pg_restore` (ver corte abaixo). O antigo carregamento
dinâmico via `import(pathToFileURL(.../dist/config/...))` (padrão do
`models/backupModel.ts` legado, único jeito de os `models/` acederem a
`config/` compilado em `dist/`) não existe mais aqui — `current/` nunca
importa de `dist/` (regra de ouro do projeto), os 3 arquivos viraram
imports estáticos normais.

**Cortado, por decisão explícita do dono do projeto após pergunta direta**:
`POST /api/admin/restore` — o legado sobrescreve tabelas inteiras da base
via `pg_restore` (dumps binários `PGDMP`), `psql` (dumps SQL plain), ou
linha-a-linha via JSON/SQLite legado (com `SAVEPOINT` por registo, tolerando
falhas parciais) — é a rota de maior blast radius de todo o backend
(capaz de apagar/sobrescrever dados de produção inteiros). `POST
/api/admin/backups/upload` também cortada — só fazia sentido como
preparação pro restore. Se algum dia isso for portado, precisa de revisão
dedicada (não encaixar como "mais uma rota" num módulo já fechado).

35 testes novos, incluindo `runPgDumpToFile` com `child_process.spawn`
mockado (sucesso, código de saída != 0, falha ao iniciar o processo) e
`pruneAutoSqlBackups` com filesystem real (tmp dir, mtimes distintos).

### `modules/admin/suspicious-emails/` — migrado (6º submódulo)

3 rotas: `GET /api/admin/users/suspicious-emails` (relatório paginado/filtrado),
`GET .../export.csv`, `POST .../deactivate-filtered` (bloqueio em massa dos
utilizadores que batem no filtro actual, com checagem de contagem —
`expectedCount` tem de bater com o working set recalculado no momento do
POST, senão devolve `409 COUNT_MISMATCH` — protecção contra o filtro ter
mudado entre o admin ver a lista e clicar "desactivar"). Heurística de email
suspeito (formato/domínio/padrões fake) + sinais de actividade real
(mineração, saldo, wallet, depósito, check-in, inactividade) combinados
num score de risco. Verbatim na lógica — só reorganizado em 5 arquivos de
serviço (`domains.ts`, `detect.ts`, `score.ts`, `signals.ts`, `report.ts`)
em vez do único arquivo de 767 linhas do legado, e `db: Pool` deixou de vir
por parâmetro (mesmo padrão do resto do projeto).

Reaproveita `computePlayerGameHeaderSnapshot`
(`modules/mining-engine/services/player-game-header-snapshot.ts`, já
portado desde a migração de `mining-engine`) pra calcular o hash real de
cada jogador na página actual — falha desse cálculo por utilizador não
derruba o relatório inteiro (cai pra `totalHash: 0`, tratado como
"não minerou" na heurística).

No legado, estas 3 rotas viviam inline no `server.ts` monolítico (nunca
tiveram um `*.controller.ts` próprio) — aqui seguem o padrão do resto do
projeto (controller dedicado).

56 testes novos, cobrindo as heurísticas de email (formato/domínio/typo/
fake pattern) e de actividade (nunca minerou, sem wallet, conta morta,
etc.) isoladamente, mais o fluxo completo de filtro/ordenação/paginação/
desactivação em massa.

### `modules/admin/referral/` — migrado (7º e último submódulo de `modules/admin/`)

6 rotas: `GET /api/admin/referrals/{summary,commissions,links,lookup,export.csv}`
+ `POST /api/admin/referrals/network-block`. Só leitura + bloqueio — a API
admin nunca permitiu ajustar comissões directamente (decisão consciente já
do legado: qualquer correcção de comissão exige fluxo dedicado e auditado,
não um PATCH solto). Reaproveita `REFERRAL_DEPOSIT_COMMISSION_PERCENT` de
`modules/profile/services/referral-overview.ts` (já portado). Reorganizado
em 3 arquivos de serviço (`format.ts`, `network.ts`, `report.ts`) em vez do
único arquivo de 930 linhas do legado; `$queryRawUnsafe` → `$queryRaw` +
`Prisma.sql`/`Prisma.join` (padrão do resto do projeto).

**Corte de escopo**: `POST /api/admin/referrals/network-delete` não foi
portada — exclui em cascata o indicador + todos os indicados directos, e
depende de `deleteUserByEmail` (`legacy/backend/server.ts:6764`, ~97
linhas), uma função de exclusão de conta em cascata cruzando várias
tabelas que **nunca foi extraída pro legado nem portada** — só existia
inline no `server.ts` monolítico. Mesma categoria de risco do restore
cortado em `modules/admin/backup` (item #26): apaga dados de produção em
massa, de forma irreversível. `network-block` (só `is_blocked = 1`,
reversível, não apaga nada) foi portada normalmente — mesmo espírito do
`security-bulk` (item #25).

36 testes novos.

---

**Fecha `modules/admin/`** (itens #25–#31): dos 7 submódulos planeados,
6 migrados (`security-bulk`, `mining-distribution`, `user-audit` parcial,
`image-asset` parcial, `backup` parcial, `suspicious-emails`, `referral`),
todos os cortes de escopo documentados individualmente. Pendências que
sobraram, para quando as dependências delas migrarem: `POST
/api/admin/restore` (backup), `POST /api/admin/referrals/network-delete`
(referral, depende de `deleteUserByEmail` nunca extraído),
`user-activity`/`session-snapshots`/`account-trace` (user-audit, dependem
de infra de logs Mongo/snapshot nunca portada), `POST
/api/admin/upload-image`/`upload-ad` (image-asset, dependem de
`multer`/`sharp`, nenhum dos dois é dependência do projecto ainda).

## 32. `modules/zerads/` — integração ZERads PTC, migrado completo

3 rotas: `GET/POST /zeradsptc.php` (callback público do servidor ZERads,
~1×/5min por utilizador, rate-limited), `GET /api/zerads/me/token`
(gera/devolve o token opaco do jogador), `GET /api/zerads/me/stats`
(totais + últimos callbacks). Verbatim na lógica de segurança/negócio —
verificação da senha do callback via `crypto.timingSafeEqual`, whitelist
de IP (`CF-Connecting-IP` como fonte canónica, `req.ip` como fallback),
conversão ZER→USDC + split 80/20 jogador/plataforma, idempotência por
bucket de 5 min (ZERads pode retransmitir o mesmo callback), crédito
atómico em `game_states.usdc` via `UPDATE ... SET usdc = usdc + $1` (evita
lost-update numa coluna `Float`), e log append-only de todo callback
(sucesso ou falha) em `zerads_callback_log` para auditoria/abuso.

Nenhuma dependência faltando — reaproveita `normalizeClientIp`
(`core/http/client-ip.ts`), `appendGameActivityLogMongo`
(`core/mongo/logs.ts`) e `bumpQuestProgress` (`modules/quests`, credita
progresso da quest `offerwall`), todos já portados. Único ajuste
estrutural: dividido em 3 arquivos de serviço (`callback-log.ts`,
`callback.ts`, `token.ts`) em vez do único controller de 446 linhas do
legado, e detecção de duplicado por código Prisma `P2002` em vez de
`catch` genérico com checagem de `.code` solta.

Módulo genuinamente pequeno e autocontido — primeiro desde
`modules/admin/` a não precisar de nenhum corte de escopo. 34 testes
novos.

## 33. `modules/player-calculator/` — migrado (correção de exclusão indevida em sessão anterior)

Numa sessão anterior, durante a limpeza de "módulos fantasma" (pastas
vazias cuja funcionalidade já vivia noutro módulo — `promo-redeem`/
`roleta` → `modules/wheel/`, `device-fingerprint`/`email-verification` →
`modules/auth/`), a pasta `modules/player-calculator/` foi apagada junto
com as genuínas por engano: um relatório de subagente agrupou as 5 pastas
como "fantasmas" sem verificação individual. `services/
playerCalculatorService.ts` (454 linhas, `GET /api/calculator/me`) nunca
tinha sido migrado — não existia equivalente em lugar nenhum de
`current/`. Detectado nesta sessão numa auditoria dos controllers legados
restantes; corrigido migrando o módulo agora.

`GET /api/calculator/me?scope=total|roomId` — projeções server-authoritative
de mineração (H/s por moeda, ganhos diários, projeções 1h/24h/7d/30d/1ano,
comparativo entre moedas, histórico de blocos). Migrado de
`controllers/playerCalculatorController.ts` (68) + `services/
playerCalculatorService.ts` (454) + `lib/playerCalculatorProjection.ts`
(214, puro/sem I/O — virou `services/projection.ts`).

Nenhuma dependência nova: `normalizePlacedRackRoomId`
(`mining-engine/services/rack-room-id.ts`), `aggregateHashByCoinWithCheckinBonus`
(`mining-engine/services/checkin-bonus-hash.ts`), `isNftMiningRoomId`/
`isNftRoomExclusiveMiningCoinRef`/`listSlotMiningCredits`
(`mining-engine/services/nft-room-mining.ts`) e `isCheckinFrozenForUser`
(`checkin/services/checkin.ts`) já estavam todos portados. Único ajuste
estrutural: a classe bespoke `PlayerCalculatorScopeError` (statusCode/code
próprios) virou `HttpControlledError` + `respondIfHttpControlledError`,
consistente com o resto do projeto. Adicionado também degrade gracioso
(P2021/42P01) na leitura de `mining_block_history` — tabela opcional,
mesmo padrão já usado em `modules/admin/mining-distribution`, ausente no
legado original mas necessário porque a tabela nem sempre existe no
schema tracked. 26 testes novos (12 projection + 8 snapshot + 6 controller).

## 34. `modules/black-market/` — mutações do mercado P2P completas (sell/cancel/reserve/buy/claim)

Fecha o mercado P2P: as 5 rotas de mutação de `p2pMarketController.ts`
(1035 linhas) que faltavam desde a migração das rotas de leitura — venda,
cancelamento, reserva, cancelamento de reserva, compra, liquidação de
proventos e resgate de custódia (individual/lote). Confirmado com o dono
do projeto antes de iniciar, por ser área de risco financeiro real (USDC).

Estrutura: lógica de negócio movida para `services/mutations.ts` (cada
rota da controller legada virou uma função, lançando `HttpControlledError`
em vez do `P2pUserError` bespoke do legado — mesmo padrão do resto do
projeto). `services/referral-commission.ts` — porta nova de
`runReferralCommissionOnTx` (comissão hardware/black_market sobre a
compra, creditada na mesma transação via `access_level_referral_models` +
`referral_models`). `services/listing-mapper.ts` ganhou os helpers de
banda de preço que faltavam (`getBlackMarketPriceBandPercentInTx`,
`computeP2PBandReferenceUsd`, `parseUsdFromDb`, `MARKET_RESERVE_MS`,
`MARKET_LISTING_TTL_MS`).

Todo `$queryRawUnsafe`/`$executeRawUnsafe` do legado convertido para
`$queryRaw`/`$executeRaw` com template tagged (interpolação directa nos
back-ticks — Prisma parametriza automaticamente), incluindo dentro de
`prisma.$transaction` com `SELECT ... FOR UPDATE` explícito e ordem de
locks determinística (`[buyerId, sellerId, referrerId].sort()`) para
evitar deadlock — preservado 1:1 do legado, é a mitigação real contra
duas compras concorrentes do mesmo referrer. `SET LOCAL lock_timeout`
(evita 504 em `FOR UPDATE` preso) via `Prisma.raw` — único uso de `raw`
porque `SET LOCAL` não aceita parâmetro bind.

Idempotência de compra preservada via `p2p_market_buy_idempotency`
(tabela já existia no schema, não usada em código nenhum antes). URLs
mantidas em `/api/black-market/...` (não `/api/market/...` do legado) —
consistente com a decisão já tomada nas rotas de leitura na sessão
anterior. Nenhum corte de escopo — todas as dependências (`prismaSqlTx`,
`logUserAction`, tabelas do schema) já existiam. 39 testes novos (23
serviço + 16 controller, cobrindo caminho feliz e principais erros de
negócio de cada rota; não cobre every branch da lógica de banda de preço
— comportamento idêntico ao legado, só a forma mudou).

## 35. `modules/admin/loot-boxes/` — gestão admin do catálogo de caixas

Achado durante a reverificação de `lootBoxController.ts` (564 linhas): as
rotas player-facing são v1, já superseded por `modules/lucky-boxes/`
(`/api/lucky-boxes/*`, confirmado numa sessão anterior) — mas as 2 rotas
*admin* do mesmo arquivo (`POST /api/loot-boxes` upsert em lote,
`DELETE /api/admin/loot-boxes/:boxId` apagar em cascata) geriam a tabela
`loot_boxes`/`loot_box_items` diretamente e nunca tinham sido portadas,
nem para v1 nem para v2 — gap genuíno, não duplicata.

Novo submódulo `modules/admin/loot-boxes/` (`services/catalog.ts` +
`controllers/loot-boxes.controller.ts`). `LootBoxAdminUserError` bespoke
virou `HttpControlledError`. Upsert em lote preserva a lógica de coerção
"activa sem prémios → grava inactiva com aviso" (evita 400 bloqueando o
save de todo o catálogo por uma caixa com estado React desactualizado) e
o "nunca apaga items às cegas" (só substitui se o payload trouxer linhas,
ou `clearItems: true` explícito). Delete em cascata cobre `loot_box_items`,
`unopened_boxes`, `player_claimed_boxes`, `admin_upgrade_boxes`,
`promo_codes.loot_box_id`, `referral_models.{sender,receiver}_loot_box_id`.

Nenhuma dependência nova — `prismaSqlTx` já portado
(`shared/utils/sql-transaction.ts`), `HttpControlledError` idem. 21 testes
novos (12 serviço + 9 controller).

## 36. `modules/admin/device-fingerprint/` — auditoria admin de fingerprints

Último pendente pequeno listado no fecho de `modules/admin/`:
`deviceFingerprintAdminController.ts` (36 linhas), `GET
/api/admin/device-fingerprints` — auditoria paginada/filtrável dos
registos de fingerprint (login/registo). `sanitizeDeviceFingerprint`/
`insertDeviceFingerprintLog` (o lado de escrita, chamado no login/registo)
já viviam em `modules/auth/services/device-fingerprint.ts`; só faltava a
leitura admin — ficou em submódulo próprio (`modules/admin/device-fingerprint/`)
em vez de `security-bulk`, por não ter nenhuma relação funcional com
bloqueio/reset em massa. Verbatim, nenhum corte. 9 testes novos.

## 37. `isAdmin`/`authenticateToken` reais — `utils/adminRouteAuth.ts` migrado

Último pendente cross-cutting documentado no fecho de `modules/admin/`:
até aqui todo módulo migrado só recebia `isAdmin`/`authenticateToken`
como `RequestHandler` **injetado**, sem implementação nenhuma em
`current/` — cada teste de controller passava uma função-coto
(`(req,res,next)=>next()`). Pedido explícito do dono do projeto para
trazer a implementação real.

`shared/security/admin-route-auth.ts` — porta verbatim de
`utils/adminRouteAuth.ts` (mapeamento rota→aba do painel, puro, sem I/O):
`permissionTabSetFromDbJson`, `adminTabAllows`, `allowsAdminRouteAccess`,
`resolveAdminRouteRequirement`. Vive em `shared/` (não em `modules/admin/`)
porque é consumido por qualquer módulo que monte `isAdmin` na sua própria
rota, não é específico de um submódulo.

`modules/auth/services/admin-guard.ts` — o middleware `isAdmin` de facto,
portado de `server.ts` (`isAdmin`, `loadAdminGateContext`, `isIpFromUser`).
Auto-suficiente: resolve `req.userId` sozinho via `createResolveAuthMiddleware`
se ainda não tiver corrido (mesmo comportamento do legado — várias rotas
montavam só `isAdmin` diretamente, sem depender de um middleware global
de sessão já ter rodado). Fluxo: 401 sem sessão (loga tentativa +
`isIpFromUser` em `admin_access_logs`) → 403 sem `is_admin` → 403 sem
permissão para a rota (`resolveAdminRouteRequirement` + `allowsAdminRouteAccess`)
→ seta `req.isSuperAdmin`/`req.adminPermissions` → `next()`. `is_super_admin`
ignora todo o mapeamento de abas (coluna do banco só, sem allowlist de
e-mail — decisão já registada em `modules/auth/services/super-admin.ts`).

`modules/auth/services/http-auth.ts` ganhou `createAuthenticateTokenMiddleware`
— contraparte trivial do legado (`if (req.userId) next(); else 401`),
que só funciona correctamente com `createResolveAuthMiddleware` montado
globalmente antes das rotas (mesmo desenho do `server.ts` legado:
`app.use(createResolveAuthMiddleware(...))` roda para todo pedido, depois
cada rota autenticada só verifica se sobrou `userId`). Montar esse `app.use`
global fica para quando o bootstrap real do `current/server` for construído
— fora do escopo desta migração, que só entrega os middlewares prontos
para serem ligados.

Nenhuma dependência nova — `createResolveAuthMiddleware`, `parseCookies`,
`resolveIsSuperAdminFromUserRow`, `getClientIpFromRequest` já existiam.
`admin_access_logs`/`user_history_ips` já estavam no schema, sem uso em
código nenhum antes. 74 testes novos (60 mapeamento de rotas + 14 guard/
authenticateToken).

## 38. Resto de `modules/batteries/`/`modules/servers/` — motor de persistência de sala completo

Reverte o corte do item #20. Migração confirmada com o dono do projeto após
dois avisos de escopo (852 linhas → ~2400 → ~4500+ linhas reais, incluindo
duas funções nunca extraídas do monólito `server.ts` e um padrão
transacional novo). Fecha `POST /api/server-room/bulk-batteries` e as 7
rotas de `servers.rackAuxIntent.controller.ts` (place/remove/miners
equip-unequip/aux equip-unequip/equip-battery/remove-battery).

**Escopo total portado** (~4500 linhas de origem, zero cortes de lógica):
- `modules/batteries/services/persistence.ts` ← `lib/serverRoomPersistence.ts`
  (852 linhas, verbatim) — motor de load/persist de stock+stored_batteries+
  placed_racks. Contém o comentário histórico sobre os "92 racks fantasmas"
  que motivou a proteção de UUIDs equipados no delete de armazém — preservada
  1:1.
- `modules/mining-engine/services/asic-lease.ts` ← `lib/asicLease.ts` (736
  linhas de origem; portado o subconjunto realmente usado — ficaram de fora
  `listUserAsicLeaseDetails`/`listAsicLeaseSummary`, uso administrativo/
  display não referenciado por nenhuma rota migrada, e os 3 aliases
  `@deprecated` do arquivo original).
- `modules/batteries/services/{repository,catalog,validation,rack-compat,
  semantic-sync,warehouse-delete,recovery,recovery-gate,save-guard,bulk,
  nft-sanitize,placed-racks-validate}.ts` ← respectivamente
  `batteries.repository.ts`, `batteries.catalog.ts` (agora completo — as
  funções que faltavam desde a migração de `modules/inventory`),
  `batteries.validation.ts`, `lib/upgradeRackCompat.ts`,
  `batterySemanticSync.ts`, `lib/storedBatteriesWarehouseDelete.ts`,
  `batteries.recovery.ts`, `lib/orphanRackBatteryRecoveryGate.ts`, subconjunto
  de `lib/saveGameEconomyValidate.ts` (só o usado por `persistence.ts` —
  `validateStockForSave`/`validateUnopenedBoxesForSave`/
  `validateDailyActionsForSave`/`validateStoredBatteriesForSave` pertencem
  ao endpoint de save-game amplo, não migrado), `batteries.bulk.ts`,
  e as **duas funções nunca extraídas do monólito**:
  `sanitizePlacedRacksNftAutoRoom` (`server.ts:4290`) +
  `returnRackBatteryToChangesOnNftSanitize`/`ensureStoredBatteriesArrayFromDb`
  (`modules/batteries/batteries.service.ts`) → `nft-sanitize.ts`; e
  `validatePlacedRacksForSave` (`server.ts:7463`, 294 linhas) →
  `placed-racks-validate.ts`.
- `modules/servers/services/{rack-aux-intent,game-intent-idempotency}.ts` ←
  `servers.rackAuxIntent.service.ts` (643 linhas, lógica pura de
  equipar/desequipar) + o resto de `lib/gameIntentIdempotencyPrisma.ts`
  específico da tabela `game_servers_intent_idempotency`
  (`stableIntentFingerprint`/`parseIdempotencyKey` já viviam em
  `shared/security/`e`shared/validation/`, reaproveitados).
- `modules/batteries/controllers/bulk-batteries.controller.ts` +
  `modules/servers/controllers/rack-aux-intent.controller.ts` ← os 2
  controllers legados, verbatim na lógica de negócio.

**Padrão transacional novo neste projeto**: `pg.Pool.connect()` +
`BEGIN`/`COMMIT`/`ROLLBACK` manual + `pg_advisory_xact_lock` (via
`core/database/pool.ts`, já existia mas nunca usado para transação
interativa completa — só para scripts avulsos). Todo módulo anterior usa
`prisma.$transaction`; aqui o padrão do legado foi preservado porque a
combinação idempotência-com-replay + lock consultivo + múltiplas
verificações de versão de estado antes/depois do lock não tem equivalente
directo limpo em `$transaction` sem reescrever a lógica de concorrência
(risco que o próprio corte original queria evitar).

**Correção de acoplamento**: os 2 controllers legados recebiam
`validatePlacedRacksForSave`/`sanitizePlacedRacksNftAutoRoom` como
dependências injetadas (`unknown` types) porque essas funções só existiam
soltas em `server.ts`. Agora que ambas têm implementação real portada, os
controllers importam-nas directamente — `BatteriesServerRoomDeps`/
`ServersRackAuxIntentDeps` encolheram para só `authenticateToken`/
`appendGameActivityLog` (e `pool`/`prisma` somem dos deps, mesmo padrão de
sempre: importa o singleton directo de `core/database/pool.ts`).

**Cobertura de testes**: dado o tamanho, os testes novos (50) focam a
lógica pura de maior risco de regressão silenciosa —
`bulk.ts`/`rack-aux-intent.ts` (equipar/desequipar/colocar/remover, todos
os `ok:false` de validação) e os helpers de catálogo/compatibilidade — não
cobrem `persistence.ts`/`placed-racks-validate.ts` linha-a-linha (exigiria
mockar dezenas de queries `pg.PoolClient` sequenciais por teste); a
migração em si é verbatim do legado, que já rodava em produção.

## 39. `GET /api/servers/state` migrado — e correção de regressão de segurança introduzida no item #38

Fecha o último bloqueio documentado de `modules/servers/`. Dependências:
`servers.snapshot.service.ts` (262) + subconjunto de `lib/meUpgradeShopBundlePayload.ts`
(só `loadMyRigRoomsForUser`, 88 linhas úteis das 270 do arquivo) + subconjunto
de `lib/publicBootstrapPayload.ts` (só `loadUpgradesForBootstrap`/
`loadMiningCoinsForBootstrap`, ~40 das 473 linhas) + `lib/upgradeCatalogShape.ts`
(`mapUpgradeRowToApi`) + `modules/servers/servers.types.ts`. O resto de
`meUpgradeShopBundlePayload.ts`/`publicBootstrapPayload.ts` pertence ao bundle
da loja de upgrades / bootstrap público completo do SPA, não migrados.

**Achado durante esta migração — regressão de segurança reintroduzida pelo
item #38, corrigida antes de qualquer commit**: o item #9 desta mesma sessão
já tinha identificado e corrigido um achado real (`POST /api/servers/racks/place`
sem checar posse nem capacidade da sala) através de uma reimplementação
própria e autocontida, `modules/servers/services/place-rack.ts`. O item #38
(reversão do corte, motor completo) portou `applyPlaceRackFromStock` +
`servers.rackAuxIntent.controller.ts` **verbatim** do legado — que é
exatamente o código com o bug original. Ao revisar o novo controller para
ligar `GET /api/servers/state`, percebi que a rota `place` recém-portada
reintroduzia a falha (nenhuma verificação de `user_rig_rooms`/nível/passe/
capacidade real, só compatibilidade de chassis NFT).

**Corrigido nesta mesma leva**, antes de qualquer verificação passar a
"pronto": `assertPlaceRackRoomAccessAndCapacity` — nova função em
`modules/servers/controllers/rack-aux-intent.controller.ts`, ligada como
`postApply` da rota `place` (roda dentro da mesma transação, com o `client`
já disponível, depois do `apply` já ter calculado o novo estado — mesmo
padrão usado pelas rotas de miner equip/unequip para finalizar leases de
ASIC). Reaproveita `resolveUserRoomAccess`/`isRoomAccessAllowedForUser` de
`modules/rooms/services/rooms.ts` (já existentes, usados por `place-rack.ts`)
— mesma regra: `room_initial` sempre libera; senão precisa de
`user_rig_rooms` OU nível/season-pass; e capacidade real
(`min(max_capacity, initial_capacity + unlocked_slots)`) contra a contagem
de rigs já na sala após a inserção.

**Consequência**: `modules/servers/services/place-rack.ts` (a reimplementação
autocontida do item #9) e `modules/servers/controllers/servers.controller.ts`
ficaram redundantes — removidos, junto com os testes que os cobriam. O
`POST /api/servers/racks/place` único agora vive em
`rack-aux-intent.controller.ts`, com a correção de segurança embutida.
`modules/servers/index.ts` reexporta tudo do motor completo.

7 testes novos (`assertPlaceRackRoomAccessAndCapacity`, cobrindo os 6 ramos
de decisão) + 2 para `mapPrismaRacksToPlacedRackDtos`.

## 40. `miningYieldCron.ts` migrado — porta código pronto, sem bootstrap que o inicie

Pedido explícito do dono do projeto: portar o cron mesmo sabendo que nada
no `current/` ainda chama `startMiningYieldCron()` (não existe bootstrap
real, mesmo caso de `createResolveAuthMiddleware` no item #37 — fica
pronto para ligar quando o bootstrap for construído).

`modules/mining-engine/services/yield-cron.ts` ← `cron/miningYieldCron.ts`
(440 linhas). Job em background (`setInterval`) que faz um único scan de
racks/upgrades/slots/multipliers, actualiza `mining_yield_history` (grelha
10 min UTC) + `app_cache.network_stats` + stats em memória para ranking,
usando lock distribuído Redis (`REDIS_LOCK_KEYS.miningYieldTick`) para não
duplicar entre processos. `modules/mining-engine/services/global-stats-store.ts`
← `cron/miningGlobalStatsStore.ts`, verbatim.

**Dois cortes de escopo, ambos best-effort/fire-and-forget no legado (a
ausência não muda nenhum cálculo de yield)**:
- `enqueueGenesisJob` (fila BullMQ) — `bullmq` **não é dependência** de
  `current/server` (`package.json` só tem `ioredis`/`socket.io`; mesmo
  tratamento dado a `multer`/`sharp` noutros módulos). Enfileirar o evento
  `miningYieldTick` numa fila de manutenção não tinha nenhum consumidor
  documentado nesta base de código.
- `maybeSyncLiveUsdToMiningCoinsPostgres` (`lib/miningLivePrices.ts`) —
  **sem código-fonte TypeScript no legado** (só `.js`/`.d.ts` compilados,
  o `.ts` original não existe mais no repo). Enriquecimento cosmético de
  preço USD via CoinGecko para a UI; o próprio comentário do arquivo
  original confirma "não altera o yield do jogo".

Todas as outras dependências já estavam portadas: `parseFiniteNumberLenient`
(`mining-numeric.ts`), `miningTenMinuteGridEnabled`/`lastCompletedTenMinuteUtcGrid`
(`wall-clock-grid.ts`), `REDIS_LOCK_KEYS`/`tryAcquireDistributedLock`/
`releaseDistributedLock` (`core/redis/lock.ts`, já consolidado de duas
implementações legadas), `getStackIo`/`setStackIo` → `getSocketIo`/
`setSocketIo` (`core/socket/client.ts`, nome diferente mesma função),
`logGameEvent`/`logAnalyticsEvent` (`core/mongo/logs.ts`), `isNftMiningRoomId`/
`listSlotMiningCredits`/`resolveNftAutoArmario1OnlyRoomIds` (`nft-room-mining.ts`).
`pool: Pool` deixou de vir por parâmetro — importa o singleton direto de
`core/database/pool.ts` (convenção do projeto). 6 testes novos.

## 41. Deduplicação `core/`+`shared/`+`modules/` — 6 duplicatas reais encontradas e corrigidas

Varredura pedida pelo dono do projeto após reclamação legítima sobre
fragmentação de arquivos pequenos em `shared/http/`. Achados e correções:

1. **`shared/http/` → `core/http/`**: `error-response.ts`, `ip-rate-limiter.ts`,
   `public-asset-url.ts`, `request-user-id.ts` estavam separados de
   `client-ip.ts`/`cors.ts`/`csp.ts`/`parse-cookies.ts`/`rate-limit.ts` sem
   motivo — mesma responsabilidade (infra HTTP genérica), duas pastas.
   `ip-rate-limiter.ts`'s `buildIpRateLimiter` fundido em `core/http/rate-limit.ts`
   (que já tinha `parseRateLimit`/`isLoopbackIp`/`buildApiRateLimitMiddleware`
   — **duplicata real**: eu tinha recriado `parseRateLimit` do zero em
   `shared/utils/parse-rate-limit.ts` sem checar que já existia).
2. **`shared/redis/json-cache.ts` → `core/redis/json-cache.ts`**: mesmo padrão,
   separado de `client.ts`/`lock.ts` sem motivo.
3. **`core/logger/throttle.ts` vs `shared/utils/log-throttle.ts`**: função
   idêntica (`shouldEmitThrottled`) recriada do zero ao portar
   `placed-racks-validate.ts`/`state-snapshot.ts` (item #38/#39). Removida a
   cópia; `core/logger/` (pasta de um arquivo só) também foi extinta —
   `throttle.ts` mudou para `shared/utils/log-throttle.ts` (nome mais correto,
   já usado pelos 2 novos consumidores).
4. **`shared/utils/lease-duration.ts` vs `modules/mining-engine/services/asic-lease.ts`**:
   a maior duplicata — 6 funções + 3 tipos de configuração de duração de
   aluguel de ASIC recriados do zero ao portar `asicLease.ts` (item #40),
   quando já existiam (usados por `checkin`/`shop`). `asic-lease.ts` agora
   importa e reexporta do arquivo genérico, mantendo só o que toca banco
   (`computeAsicLeaseExpiresAt` e as funções `player_asic_leases`).
5. **`parseLootBoxId`**: duplicado entre `modules/lucky-boxes/services/validation.ts`
   e `modules/admin/loot-boxes/services/catalog.ts` (portados em sessões
   diferentes, #19 e #35). `admin/loot-boxes` agora importa de `lucky-boxes`.
6. **`loadNftMiningRoomIds`/`normalizeRigRoomPolicyNameKey`** — duplicação
   **herdada do legado** (não introduzida nesta sessão), em
   `modules/ranking/services/mining-ranking.ts`,
   `modules/player-calculator/services/snapshot.ts` (item #34, verbatim do
   legado) e `modules/mining-engine/services/player-game-header-snapshot.ts`.
   As 3 cópias privadas reimplementavam a mesma query (`prisma.rig_rooms.findMany`
   + comparação de nome de sala) com um normalizador **sem tratamento de
   acento**, diferente do já centralizado `isNftAutoArmario1OnlyRoomRow` em
   `nft-room-mining.ts` (que usa `.normalize('NFD')` + strip de diacríticos).
   Consolidado: as 3 agora chamam `isNftAutoArmario1OnlyRoomRow` por linha —
   **corrige um bug real**, não só duplicação: nomes de sala com acento
   (ex.: "Sala Dólar") passam a ser reconhecidos corretamente nos 3 lugares
   onde antes não eram.

`cron/` (pasta) confirmada vazia de propósito — lógica de cron vive em
`modules/mining-engine/` (domínio, não infra solta). `types/` só tem
`express.d.ts`, sem problema. Nenhuma duplicata nova introduzida por essa
limpeza; tsc×2/ESLint/1746 testes continuam limpos.

## 42. `modules/admin/user-audit/` — as 3 rotas restantes (`user-activity`, `session-snapshots`, `account-trace`)

Fecha o gap de escopo documentado no item #17/`inventory-audit.ts`: as 3 rotas
do controller admin original que dependiam de infra ainda não portada.

Levantamento prévio (agente `Explore`) confirmou que a dependência mais pesada
já estava coberta: `core/mongo/logs.ts` já é um superset fiel de
`lib/mongoLogs.ts` (`listAdminUserActivityLogsMongo`/`listSessionSnapshotsMongo`
já existiam, só faltava importar). Restavam 3 ficheiros genuinamente novos:

1. **`services/activity-event-formatter.ts`** ← `lib/activityEventFormatter.ts`,
   verbatim (função pura, sem dependências externas — só mapeia `action`/`meta`
   para texto/categoria/severidade legível no admin).
2. **`services/player-state-snapshot.ts`** ← `services/playerStateSnapshot.service.ts`,
   **com corte de escopo**: só o tipo `PlayerStateSnapshotPayload` e
   `diffSnapshotInventory` foram portados (usados na leitura de snapshots já
   gravados). `buildPlayerStateSnapshot`/`appendSessionStateSnapshot` (o
   *writer*) ficaram de fora — só têm um chamador em todo o legado, o
   `server.ts` monólito (fluxo de login/resync), fora desta leva; portá-los
   teria criado código morto sem chamador em `current/`.
3. **`services/account-trace.ts`** ← `services/adminUserAccountTrace.service.ts`
   (890 linhas), o agregador Postgres+Mongo. As 4 leituras de
   `p2p_market_trade_history` usavam `prisma.$queryRawUnsafe` com SQL estático
   (parâmetros já posicionais, sem risco de injecção) — mas a tabela tem
   modelo Prisma em `current/prisma/schema.prisma` que o legado (mais antigo)
   não aproveitava; convertidas para `prisma.p2p_market_trade_history.findMany`,
   mais alinhado com a convenção do projeto do que só trocar Unsafe→safe.

Reaproveitados sem nova escrita: `computePlayerGameHeaderSnapshot`
(`modules/mining-engine/`) e `MARKET_LISTING_TTL_MS`
(`modules/black-market/services/listing-mapper.ts`) — ambos já portados por
itens anteriores.

25 testes novos (formatter, diff de snapshot, `buildItemDisposition`,
`mergeTimelineEvents`, `mergeAdminUserActivityLogs`); tsc×2/ESLint/1767 testes
totais continuam limpos.

## 43. `POST /api/admin/referrals/network-delete` — porta a exclusão em cascata

Última pendência destrutiva das duas levantadas no item #17 (junto com o
`restore` de `modules/admin/backup`). Confirmado explicitamente pelo dono do
projeto via `AskUserQuestion`: **portar verbatim** o `network-delete`,
**manter cortado** o `restore` (risco maior — sobrescreve o BD de produção
inteiro via `pg_restore`, não só apaga contas específicas).

Extraída `deleteUserByEmail` de `legacy/backend/server.ts:6764` (~97 linhas)
para `modules/admin/referral/services/delete-user.ts` — nunca tinha sido
extraída do monólito no legado, só existia inline. Porte verbatim: mesma
ordem de `DELETE`/`UPDATE` para limpar FKs sem `ON DELETE CASCADE` antes de
apagar `users` (suporte, P2P, sessões, YouTube partners, referrals, rigs,
inventário, etc.), mesmo tratamento defensivo do catch `42P01` nas tabelas de
partners (podem não existir em todo ambiente). A função aceita um `client`
opcional — se vier `null` abre/fecha a própria transação; se vier um client
já em transação (o caso de `network-delete`, que apaga vários utilizadores
numa única transação), reusa-o e deixa o chamador decidir commit/rollback —
mesmo padrão do legado.

`POST /api/admin/referrals/network-delete` em si é porte verbatim do
controller (resolve o alvo, lista a rede referida, bloqueia auto-exclusão de
outro admin por não-super-admin, apaga cada indicado + o indicador numa
transação `pool.connect()`+`BEGIN`/`COMMIT`/`ROLLBACK` manual — mesmo padrão
transacional já usado em `modules/servers`/`modules/batteries`, item #38).
Todas as dependências (`resolveNetworkTarget`, `listAllReferredUsers`,
`getReferredNetworkStats`, `toReferralUserBrief`) já estavam portadas pelo
módulo `referral` existente.

14 testes novos (5 do serviço `deleteUserByEmail` — email inválido,
utilizador não encontrado, caminho feliz, client externo partilhado sem
BEGIN/COMMIT próprios, e-mails duplicados case-insensitive sem correspondência
exacta; 9 do controller — 404 sem chamar delete, caminho feliz com 2 contas
numa transação, 403 pra não-super-admin tentando apagar outro admin, rollback
+ 400 quando o delete do indicador principal falha). tsc×2/ESLint/1776 testes
totais continuam limpos.

## 44. `POST /api/admin/upload-image`/`upload-ad` — adiciona `multer`/`sharp`

Última pendência do backlog. Diferente das outras 3 (que eram só extração de
código já existente), esta exigia uma decisão real de infraestrutura:
adicionar 2 dependências novas ao projecto. Confirmado explicitamente pelo
dono do projeto.

`sharp` instalada em `^0.35.3`, **não** `^0.34.5` (a versão pinada no
`package.json` do legado) — `npm audit` acusou uma vulnerabilidade alta
herdada do `libvips` (CVE-2026-33327/33328/35590/35591) corrigida só a partir
da `0.35.3`; nenhuma API usada aqui (`sharp(buf, {failOn, animated})`,
`.png()`, `.jpeg()`, `.webp()`, `.metadata()`) mudou entre as duas versões.
`multer` instalada em `^2.2.0` (o legado pede `^2.0.2`, `npm install` resolveu
pro último patch compatível — sem CVE pendente).

Novos ficheiros em `modules/admin/image-asset/services/`:
- `webp-convert.ts` ← `lib/convertImageToWebp.ts` (só `convertRasterFileToWebp`,
  que depende de `sharp` — os helpers puros de caminho já viviam em
  `webp-paths.ts` desde o corte anterior).
- `compress-media.ts` ← `lib/compressMediaAsset.ts`, **com corte de escopo**:
  o legado também recomprime vídeo (`.mp4` via `ffmpeg`/H.264), mas nenhuma
  rota portada aceita vídeo (`upload-image`/`upload-ad` só aceitam
  png/jpg/webp/gif) — esse branch ficaria morto, omitido. GIF continua via
  `ffmpeg` (preserva animação; `sharp` sozinho não faz bem isto) — já era
  best-effort no legado (falha silenciosa se o binário não estiver no PATH),
  mantido assim.
- `magic-bytes.ts` ← `validation/inAppAnnouncementValidation.ts`, só
  `assertImageFileMagicBytes` (o resto do ficheiro original já tinha sido
  portado por `modules/in-app-announcements/services/validation.ts`, que
  documentava explicitamente essa função como não migrada até agora).

Controller (`image-asset.controller.ts`) reescrito: porte verbatim das 2
rotas multipart (multer com `diskStorage` + `fileFilter`, mesmos limites do
legado — 50 MB para `upload-image`, 5 MB para `upload-ad`) + `finalizeUploadAsWebp`
(compressão best-effort seguida de conversão pra webp, mesma composição do
legado). `ImageAssetModuleDeps` ganhou `isAdmin` (as 2 rotas novas exigem
admin; a rota de data-URL já fazia a própria checagem inline, mantida como
estava). `bootstrap/routes.ts` actualizado para passar `deps.isAdmin`.

64 testes no módulo (27 novos: `webp-convert` com PNG real gerado por `sharp`
— conversão, no-op se já webp, ficheiro corrompido não lança; `magic-bytes`
com bytes reais de assinatura; `compress-media` com PNG/GIF reais, incluindo
o caminho GIF via `ffmpeg` real (disponível no sandbox); controller com um
stub de `multer` controlável por teste — evita simular parsing multipart
real de uma lib já testada, foca em validar a lógica da nossa rota em torno
do resultado dela). Boot real (`dist/bootstrap/server.js`) confirmado limpo
após a mudança de wiring. tsc×2/ESLint/1803 testes totais continuam limpos.

## 45. `modules/support/` — anexos e download autenticado (multer)

Segundo dos 3 cortes que ficaram obsoletos assim que `multer` virou
dependência (item #44). Confirmado explicitamente pelo dono do projeto.

Novos ficheiros em `modules/support/services/`:
- `attachments.ts` ← `lib/supportTicketAttachments.ts`, verbatim
  (`buildAttachmentsFromFiles`, `sendSupportMulterError`).
- `attachments-proxy.ts` ← `modules/support/supportAttachmentsProxy.ts`,
  **com corte de escopo**: só as 3 funções usadas pela rota de download
  (`isSafeSupportStoredFilename`, `supportStoredFileOwnedByUser`,
  `isSupportReplyStoredName`). `rewriteSupportAttachmentsForPlayerDownload`
  e `storedNameFromImgUrl` (só usada por ela) ficaram de fora — nenhuma rota
  em `current/` devolve a lista completa de anexos de um ticket ainda
  (`services/state.ts` só devolve resumos); ficariam sem chamador.
- `supportStoredNameReferencedOnTicket` adicionada a `services/ticket-model.ts`
  (não um ficheiro novo — já existia o resto do model).

Controller (`support.controller.ts`) reescrito: `POST /tickets` e
`POST /tickets/:ticketId/messages` ganharam `uploadSupport.array('files', 5)`
(multer, mesmos limites informativos que já existiam em `services/limits.ts`
— agora realmente aplicados, não só documentais); `attachments` deixou de ser
sempre `[]` (`NO_ATTACHMENTS` removida), passa a vir de
`buildAttachmentsFromFiles(req.files)`. Nova rota
`GET /api/support/attachments/download` — porte verbatim da checagem de posse
(ficheiro do próprio jogador OU resposta de staff associada a um ticket seu,
via `supportStoredNameReferencedOnTicket`) + `path.resolve` anti-traversal +
`res.sendFile`.

30 testes novos (5 do `ticket-model` — `supportStoredNameReferencedOnTicket`
com prisma mockado; 8 de `attachments.ts`; 8 de `attachments-proxy.ts`; 9 no
controller — erro do multer, anexos construídos dos ficheiros, e 7 cenários
da rota de download incluindo path traversal e posse cruzada). tsc×2/ESLint/
1803+30 testes totais continuam limpos.

## 46. `modules/partners/` e `modules/chat/` — os 2 uploads restantes (multer)

Fecha os 3 cortes obsoletos por falta de `multer` (item #44 identificou os 3;
#45 fez support; este item faz os 2 restantes). Confirmado explicitamente
pelo dono do projeto.

**`modules/partners/`** — `POST /api/partners/youtube/avatar-upload`, porte
verbatim (multer `diskStorage` em `partner-avatars/`, `fileFilter`
PNG/JPG/WEBP, 5 MB). Não escreve na BD — só devolve `avatarUrl` (`/img/partner-avatars/...`),
que o cliente já sabia mandar de volta via `PUT /api/partners/youtube/my-profile`
(`sanitizePartnerCreatorAvatarUrl`, já portada, aceita tanto URL `https://`
como caminho relativo `/...` — desenhada pra este fluxo desde o legado).
`PartnersModuleDeps` ganhou `uploadsDir`.

**`modules/chat/`** — `POST /api/chat/audio`, porte verbatim: multer
(`diskStorage` em `chat-audio/`, resolve extensão por mimetype com fallback
pro nome do ficheiro), valida duração (`400ms`–`30.5s`), sniffa os primeiros
32 bytes contra assinaturas conhecidas (RIFF/WAVE, ID3/MPEG, OggS, ftyp,
EBML — novo `services/audio-magic.ts`, `looksLikeAudioMagic`/`resolveAudioExt`,
mesma ideia de `modules/admin/image-asset/services/magic-bytes.ts` mas pra
áudio), rate-limit por utilizador, bloqueia remetente banido, insere a
mensagem e emite `chat:message` na sala do canal via `getSocketIo()`
(`core/socket/client.ts` — o análogo directo do `getStackIo()` legado,
singleton do servidor Socket.IO já existente desde o item #4/#22, só nunca
tinha sido usado a partir de uma rota HTTP). `ChatModuleDeps` ganhou
`uploadsDir`.

Em ambos, um detalhe de implementação encontrado ao escrever os testes:
o callback do multer precisa de **ser** a função assíncrona que faz o
trabalho (`async (err) => { ...; await handler(); }`), não um wrapper que
dispara `void handler()` — só assim o valor de retorno do callback (a
promise) fica disponível pra quem precisar aguardar a conclusão real do
upload (nos testes, o stub de `multer` captura esse retorno pra dar
`await` correto; em produção não muda nada de comportamento, é só a forma
correcta de encadear).

19 testes novos (4 em `partners.controller.test.ts` — erro do multer, sem
auth, sem ficheiro, caminho feliz; 11 em `audio-magic.test.ts` — cada
assinatura + rejeição; 8 novos em `chat.controller.test.ts` — magia de
áudio válida/inválida, duração curta/longa, canal sem acesso, rate limit,
remetente bloqueado, caminho feliz com emissão via socket confirmada).
Boot real (`dist/bootstrap/server.js`) confirmado limpo após a mudança de
wiring nos 2 módulos. tsc×2/ESLint/1857 testes totais continuam limpos —
**fecha o backlog de migração do backend por completo** (só resta o
`POST /api/admin/restore`, mantido cortado por decisão explícita, item #17).

## 47. Cron scheduler wiring — liga os crons que já existiam "sem chamador"

Primeira leva do levantamento pedido explicitamente pelo dono do projeto
("a maioria disso aí deveria passar pra cá reescrito, refatorado de modo
inteligente") — prioridade dele: começar pelo mais barato/baixo risco.

Um agente de inventário levantou todos os cortes/TODOs ainda abertos em
`current/`. Achado principal desta leva: 3 dos "sem chamador" já listados
como pendentes **já tinham sido resolvidos** em itens anteriores da sessão —
`accrueManagerMiningShare` (item #24, chamado dentro do tick de mineração),
`startMiningYieldCron()` (já wireado em `bootstrap/server.ts` desde a
construção do bootstrap) e `startScheduledSqlBackups()` (função completa já
existia em `modules/admin/backup/services/scheduled-backup.ts`, só faltava a
chamada — 1 linha). Faltavam mesmo 2:

- **`modules/chat/services/ttl-cron.ts`** ← `cron/chatTtlCron.ts`, porte
  verbatim (apaga mensagens de chat + áudio em disco após `CHAT_MESSAGE_TTL_MS`,
  varredura de órfãos, emite `chat:ttl_purge`). `getStackIo()` do legado vira
  `getSocketIo()` (`core/socket/client.ts`), mesmo singleton já usado por
  `POST /api/chat/audio` (item #46) — nenhuma peça nova de infra.
- **`modules/email-campaigns/services/cron.ts`** ← `cron/emailCampaignCron.ts`,
  porte verbatim (lote diário às 09:00 UTC por default, configurável via
  `EMAIL_CAMPAIGN_CRON_HOUR`).

Refatoração consciente **não feita**: `scheduled-backup.ts` (hora local) e o
novo `email-campaigns/services/cron.ts` (hora UTC) têm a mesma forma —
"calcula ms até HH:MM, `setTimeout`, reagenda" — candidato óbvio a um
`shared/utils/daily-scheduler.ts` genérico. Decisão: **não** extrair agora.
`scheduled-backup.ts` já está testado e em produção-de-fato (é o único dos
dois com uso real esperado no curto prazo); mexer nele só para eliminar ~15
linhas de duplicação com um cron novo não compensa o risco de regressão
numa rotina de backup. Sinalizado aqui para quando um terceiro cron
"diário-a-uma-hora" aparecer — aí sim a duplicação tripla justifica a
extração.

`bootstrap/app.ts`: `buildApp()` passou a devolver `{ app, deps }` em vez de
só `app` — `bootstrap/server.ts` precisava de `deps.uploadsDir` pro
`ChatTtlCron` sem reconstruir `AppDeps` do zero (`buildAppDeps()` de novo
seria trabalho duplicado — rate limiters, bcrypt, etc., tudo de novo — e viola
o próprio princípio documentado em `deps.ts`, "tudo nasce aqui", uma vez só).
Único ponto de wiring novo em `bootstrap/server.ts`: as 4 chamadas de
`start*Cron()`/`start*Backups()` seguidas, cada uma com o próprio
kill-switch/checagem de ambiente interna (nenhuma lógica de scheduling nova
no bootstrap em si).

10 testes novos (5 `cron.test.ts` do email-campaigns — cálculo de delay UTC,
start/stop via spy de `setTimeout`/`clearTimeout`; 5 `ttl-cron.test.ts` do
chat — agendamento via `setInterval`, purge com áudio + emissão de evento,
varredura de órfãos por mtime, falha não propaga). Boot real
(`dist/bootstrap/server.js`) confirmado: os 4 crons aparecem agendados no
arranque, servidor escuta normalmente, primeira falha de cada cron é só
`ECONNREFUSED` (sem Postgres no sandbox), no lugar esperado. tsc×2/ESLint/
1867 testes totais continuam limpos.

### Correção ao item #47: faltava o gate `WORKER_ROLE`/`RUN_SCHEDULERS`

O dono do projeto pegou o erro na hora ("o que tu tá metendo em server.ts?").
A leva original do item #47 ligou os 4 `start*Cron()` incondicionalmente em
`bootstrap/server.ts`. O legado (`server.ts:2104-2117`) sempre envolveu essa
mesma chamada num gate: `RUN_SCHEDULERS = WORKER_ROLE ∈ {BACKGROUND, ALL,
SCHEDULER} && SCHEDULER_ENABLED != '0'` — pensado pra deploy em cluster/várias
réplicas, onde normalmente sobem réplicas `WORKER_ROLE=API` (só servem HTTP)
e uma única réplica `BACKGROUND`/`ALL`/`SCHEDULER` cuida dos crons. Sem o
gate, **cada réplica `API` também dispararia os crons** — o mais grave:
`startEmailCampaignCron` não tem nenhum lock (ao contrário do backup
automático, que já usa `pg_try_advisory_lock`), então N réplicas mandariam a
mesma campanha de email N vezes pra cada destinatário.

Fix: `shouldRunSchedulers()` adicionada a `bootstrap/server.ts`, mesmo cálculo
do legado, envolvendo as 4 chamadas de cron. `startMiningYieldCron` já tinha
checagem própria de `WORKER_ROLE` internamente (por isso não quebrou nada
antes da correção) — mantida como defesa em profundidade, igual ao legado,
que também chama `startMiningYieldCron` dentro do mesmo bloco `RUN_SCHEDULERS`
apesar da função já se auto-proteger.

Sem testes automatizados novos — nenhum ficheiro de `bootstrap/` tem testes
(padrão já estabelecido: `startServer()` executa no escopo do módulo ao
importar, então a verificação sempre foi via boot real, não `vitest`).
Confirmado com boot real duplo: `WORKER_ROLE=API` → `[Cron] não agendados`,
sem nenhuma das 4 mensagens de agendamento; default (`ALL`) → os 4 crons
aparecem agendados, igual a antes da correção. tsc×2/ESLint/1867 testes
continuam limpos (nenhum teste tocava nisso, então nenhum quebrou).

## 48. CRUD admin de salas + pacotes + editor da roleta + ranking admin/"minha posição"

Resto da leva fácil pedida pelo dono do projeto (item #47 fez o cron
scheduler; este fecha o restante: `rooms`, `upgrades`, `wheel`, `ranking`).

**`modules/rooms/`** — `POST /api/rig-rooms` (novo `services/rooms-admin.ts`,
`upsertRigRoomsCatalog`). Porte verbatim do upsert em lote + `DELETE` condicional
(sala fora do payload só é apagada se não estiver referenciada por
`user_rig_rooms`/`placed_racks`, incluindo o caso especial de `room_initial`
cobrir `room_id` nulo/vazio/`'main'`).

**`modules/upgrades/`** — `POST`/`DELETE /api/admin-upgrades` (novo
`services/admin-crud.ts`). **Corrige um achado ao portar**: o `DELETE` legado
limpava 4 tabelas-filha (`items`/`boxes`/`passes`/`coins`) mas esquecia
`admin_upgrade_visibility` — ficava linha órfã pra trás (sem FK a impedir,
não dava erro, só lixo). Aqui limpa as 5. `passes` (schema exige `qty NOT NULL`,
nunca lida no grant real — `services/grant.ts` só usa `pass_id`) aceita tanto
`string[]` (ids, como o legado mandava) quanto `{passId, qty}[]`, default
`qty: 1`. Erros agora sempre JSON via `HttpControlledError` (legado
respondia texto plano em alguns casos — `res.status(400).send('...')`).

**`modules/wheel/`** — `/api/admin/wheel/{config,runtime-config,players}`
(novo `services/admin.ts`). Porte verbatim das 3 sub-áreas do editor: catálogo
completo de prémios (sem o filtro de `tier` do sorteio real — `services/prizes.ts`
continua sendo só a versão filtrada, elegível pro giro), config de
preço/limites (`wheel_config`, chão de 0.10 USDC), lista de jogadores com
acesso liberado.

**`modules/ranking/`** — 3 rotas novas (`GET /api/ranking/public`,
`GET /api/ranking/me`, `GET /api/admin/ranking`) + 2 achados reais corrigidos:

1. `startPublicMiningRankingRefreshLoop()` (o job de fundo que mantém o
   snapshot do Redis quente a cada 5min) **nunca tinha sido chamado em
   lugar nenhum** — só existia a função, documentada como "chamar uma vez no
   bootstrap", mas o bootstrap ainda não existia quando o módulo foi portado
   e ninguém voltou pra ligar depois. Não era catastrófico (`getPublicMiningRankingPayload`
   já degrada bem — cai pro cálculo ao vivo com fallback local de 10s — mas
   sem o job o "modo normal" documentado no item #8 do DECISIONS nunca rodava
   de verdade). Ligado agora em `bootstrap/server.ts`, sob o mesmo gate
   `shouldRunSchedulers()` do item #47.
2. `getAdminMiningRankingPayload` e `computePublicMiningRankingPayloadUncached`
   duplicavam quase toda a varredura pesada (moedas/upgrades/salas
   NFT/utilizadores elegíveis/racks/slots) — o legado tinha as duas funções
   quase inteiras repetidas lado a lado no mesmo arquivo. Extraída
   `loadRankingScanData()`, reusada pelas duas; `accumulateRankingPowerFromRacks`
   generalizada (`<T extends PublicRankingUser>`) pra aceitar tanto o mapa
   público quanto o admin (que acrescenta `balances`) sem duplicar o loop de
   crédito de H/s.

`getMyGlobalMiningRank` replica o cache dedicado de baixo TTL do legado
(`MY_RANK_CACHE_TTL_MS`, 5–60s, default 10s) por cima do já-cacheado
`getPublicMiningRankingPayload()` — `{fresh:true}` só ignora essa camada
dedicada, não o cache subjacente do payload público (mesmo comportamento do
legado; documentado no teste que verificava isso pra não parecer bug).

37 testes novos (9 `rooms-admin`; 9 `wheel/admin` + 8 no controller; 9
`upgrades/admin-crud` + 6 no controller; 16 em `mining-ranking` — admin
payload, "minha posição", cache dedicado — + 7 no novo controller de
ranking). Boot real confirmado: `startPublicMiningRankingRefreshLoop` agora
aparece disparando no arranque e falhando no lugar certo (`DATABASE_URL`
ausente no sandbox — mesmo padrão dos outros crons, capturado e logado, não
derruba o processo). tsc×2/ESLint/1928 testes totais continuam limpos.

## 49. Economia de referral — crédito ao indicador na confirmação de e-mail

Primeiro item da leva "média" pedida pelo dono do projeto (dinheiro real, mas
pequeno e autocontido). TODO espalhado em 3 arquivos desde a migração inicial
de `auth`/`profile` — `register.controller.ts`, `email-verification.ts`,
`referral-bind.ts` — todos apontando pra mesma peça nunca portada:
`executeUserPutCoreTransaction` (legado, `models/userPutCoreTransaction.ts`,
890 linhas misturando cadastro/wallet/access-level/economia de referral).

Em vez de portar essa função monolítica inteira, extraída só a parte de
referral pra `modules/profile/services/referral-credit.ts`, com 2 funções:

- **`bindReferralAndAccrueClaim`** — chamada no registo E no
  `bindProfileReferralCode` (mesmo momento que grava `users.referred_by`).
  Cria a linha em `referrals` (idempotente — `findFirst` antes do `create`,
  já que `referrals(user_id, referred_username)` não tem `@@unique` declarada
  no schema Prisma de `current/`, embora o legado confiasse num `catch` de
  `P2002` que implica uma constraint na BD real não reflectida aqui — decisão:
  não migrar schema sem confirmar, resolver a nível de aplicação) + soma 1 em
  `claimed_referrals` do indicador. **Não paga USDC ainda.**
- **`creditReferralBonusOnEmailVerified`** — chamada só na confirmação de
  e-mail (achado real ao portar: é **aqui**, não no registo, que o legado
  credita o USDC — `modules/auth/services/email-verification.ts`). Só paga se
  a linha em `referrals` existir de facto (criada pela função acima) e o
  indicado ainda não tiver `referral_bonus_claimed=1`. Valor vem de
  `referral_models` por `access_level_id` do indicador, com fallback pro
  default de 1 USDC quando não há modelo activo — mesma lógica do legado.

**Cortes conscientes, documentados em cada chamador**:
- O "rebind"/troca de `referred_by` (des-vincular o referral antigo,
  decrementar `claimed_referrals`, limpar `referral_bonus_claimed`) do legado
  — parte de `executeUserPutCoreTransaction` pensada pro `PUT /api/user`
  genérico (edição de perfil por admin) — não portado. `register.controller.ts`
  só credita se o utilizador ainda não tinha `referred_by` (`referralAlreadyBound`,
  mesmo guard do legado); `referral-bind.ts` já bloqueava rebind por completo
  com 409 antes deste item, então nunca precisou dessa lógica.
- Histórico de troca de carteira Polygon (`appendUserWalletHistory`, também
  dentro de `executeUserPutCoreTransaction`) — concern separado, cada
  chamador já tinha a própria lógica de wallet portada antes (`modules/wallet`,
  `modules/profile/services/wallet-history.ts`).
- `clientIpReferral` — parâmetro do legado nunca lido de facto (confirmado
  por busca no código-fonte legado), não existe no novo desenho.

25 testes novos (11 do serviço `referral-credit` — idempotência do vínculo,
todos os guards de `creditReferralBonusOnEmailVerified` incluindo modelo
custom/zero/ausente; 3 no registo — vínculo válido, auto-indicação, código
inexistente; 1 no `referral-bind`; os 2 arquivos de teste pré-existentes
ajustados pro novo `prisma.$transaction`). Boot real confirmado: servidor
sobe normal, nada quebrou nas rotas de registo/verificação (só tocam BD por
request, não no arranque). tsc×2/ESLint/1942 testes totais continuam limpos.

## 50. Motor de ASIC lease temporizado — os 2 últimos consumidores ligados

Segundo item da leva média. Achado ao investigar: o motor completo
(`createAsicLeasesOnPurchase`/`syncTimedAsicStockForItem`/`reconcileTimedAsicStockLeases`/
etc.) **já estava inteiro portado** desde o item #38 (reversão de
batteries/servers) — os 2 cortes documentados (`checkin`/`shop`) só
precisavam ser religados, não reimplementados. Nenhum código novo de
domínio, só 2 chamadores reais.

- **`modules/checkin/services/reward.ts`** — `grantCheckinStreakTemporaryItem`
  (prémio de 7 dias seguidos) deixou de devolver sempre "não concedido".
  Porte verbatim do legado: valida `streakRewardEnabled`/item
  configurado/activo/`type='machine'`, cria 1 lease via
  `createAsicLeasesOnPurchase` + sincroniza stock, devolve
  `expiresAtMs`/`durationLabel` da lease criada.
- **`modules/shop/services/checkout.ts`** — item com `asic_duration_kind`/`asic_duration_amount`
  configurado deixou de ser recusado com 422 `ASIC_LEASE_NOT_SUPPORTED`.
  Porte verbatim: por linha do carrinho, se for ASIC com duração
  temporizada, cria leases em vez de creditar `stock` permanente (mesmo
  branch `timedAsic ? leases : stock` do legado).

Nenhum corte novo introduzido; nenhuma peça de infra faltando — só os 2
`if` que faltavam. 6 testes novos/reescritos (5 em `reward.test.ts` — troca
do stub "nunca concede" por cenários reais: desligado, item vazio,
ausente/inactivo, tipo errado, caminho feliz; 1 em `checkout.test.ts` —
troca da asserção de 422 por asserção de `INSERT INTO player_asic_leases`
+ saldo debitado normalmente). Boot real confirmado: nada quebrou (a
lógica só roda por request, não no arranque). tsc×2/ESLint/1946 testes
totais continuam limpos.

## 48. Painel admin de Partners YouTube — migrado (fecha o item #16)

Origem: `legacy/backend/controllers/partnerYoutubeController.ts` (parte
admin, ~577 linhas) + subconjunto admin de `legacy/backend/models/partnerYoutubeModel.ts`
+ `legacy/backend/modules/partners/partnersApply.service.ts` (metade admin:
`runPartnerYoutubeApplicationApprove`/`Reject`).

- Novos: `server/modules/partners/services/admin-model.ts` (acesso a dados
  admin-only: listar/aprovar/rejeitar/apagar submissões, listar parceiros,
  allowlist manual add/remove, lookup de utilizador por email/username,
  candidaturas), `server/modules/partners/services/admin-apply.ts`
  (`runPartnerYoutubeApplicationApprove`/`Reject`, `PartnerYoutubeApplyError`
  bespoke do legado virou `HttpControlledError`, igual ao resto do módulo),
  `server/modules/partners/controllers/partners-admin.controller.ts`
  (`registerPartnersAdminModuleRoutes(app, { isAdmin })`, 15 rotas).
- 15 rotas: `POST`/`DELETE /api/admin/partner-youtube-allowlist(/:userId)`,
  `GET /api/admin/partner-youtube-partners`,
  `POST /api/admin/partner-youtube-partners/:userId/deactivate-nft-room`,
  `GET /api/admin/streamer-room-users` + `POST .../:userId/deactivate`,
  `GET ['/api/admin/partner-videos', '/api/admin/partners/submissions']`,
  `POST` approve/reject de vídeo (aliases `/api/admin/partner-videos/:id/*`
  e `/api/admin/partners/videos/:id/*`), `DELETE`
  `['/api/admin/partner-videos/:id', '/api/admin/partners/videos/:id/archive']`,
  `GET`/`PUT /api/admin/partner-youtube-creators/:userId`,
  `GET /api/admin/partner-youtube-applications` + `.../:id/approve` +
  `.../:id/reject`.
- Reaproveitado sem duplicar: `loadUserPlacedRacksWithSlots`/
  `persistStockStoredBatteriesPlacedRacks` de `modules/batteries/services/persistence.ts`
  (motor de 852 linhas já portado pelo item #38) para
  `deactivateStreamerRoomForUser` (remove racks da Sala Streamer +
  revoga `user_rig_rooms`/`user_access_levels`); `NFT_AUTO_ROOM_ID` de
  `modules/mining-engine/services/nft-room-mining.ts` para
  `grantPartnerNftRoomAccess`. SQL bruta de compliance/streamer-room
  portada verbatim com `pg.Pool` parametrizado (nunca `$queryRawUnsafe`).
  `appendGameActivityLog` injetado do legado virou `appendGameActivityLogMongo`
  direto, igual ao padrão já usado em `modules/support`.
- Nenhum corte de escopo — tudo com dependência já portada.
- 40 testes novos (`tests/modules/partners/controllers/partners-admin.controller.test.ts`
  — 31, `tests/modules/partners/services/admin-apply.test.ts` — 9).

## 49. Painel admin de Support — migrado (fecha o item #21)

Origem: `legacy/backend/controllers/supportTicketController.ts` (parte
admin, ~207 linhas) + subconjunto admin de `legacy/backend/models/supportTicketModel.ts`.

- `server/modules/support/services/ticket-model.ts` estendido com as
  funções admin-only (`listTicketsForAdmin`, `getAdminTicketListRowById`,
  `listAdminRepliesForTicketIds`, `listPlayerRepliesForTicketIds`,
  `updateSupportTicketStatus`, `getTicketForAdminReply`,
  `insertSupportAdminReply`, `listUserSupportTicketHistorySummaries`,
  `getUserSupportTicketStats`) — mesmo arquivo do lado jogador, seguindo o
  padrão já estabelecido pelo próprio módulo (sem `models/` separado).
- Novo `server/modules/support/controllers/admin.controller.ts`
  (`registerSupportAdminModuleRoutes(app, { isAdmin, uploadsDir })`, 5
  rotas + instância `multer` própria pra anexos de resposta admin,
  prefixo `support-reply-`, reaproveitando `SUPPORT_ALLOWED_EXT`/
  `SUPPORT_UPLOAD_MAX_BYTES`/`SUPPORT_UPLOAD_MAX_FILES` de `services/limits.ts`
  e `buildAttachmentsFromFiles`/`sendSupportMulterError` de `services/attachments.ts`).
- 5 rotas: `GET /api/admin/support-tickets`,
  `GET /api/admin/support/user-history`,
  `GET /api/admin/support/tickets/:ticketId`,
  `POST /api/admin/support-tickets/status`,
  `POST /api/admin/support-tickets/reply`.
- Reaproveitado: `findUserByEmail` de `modules/auth/models/repository.ts`,
  `validateLoginEmail` de `modules/auth/services/login-validation.ts`,
  `appendGameActivityLogMongo` (substitui a injeção `AppendGameActivityLog`
  do legado).
- **Corte de escopo documentado**: o legado chama
  `compressUploadedMulterFiles(files)` (compressão de imagem *e vídeo* via
  ffmpeg, `lib/compressMediaAsset.ts`) antes de guardar os anexos da
  resposta admin. Só a variante imagem-only já tinha sido portada
  (`modules/admin/image-asset/services/compress-media.ts`,
  `compressMediaFileInPlace`, um ficheiro de cada vez, sem ramo de vídeo)
  — mesmo corte já documentado no item #44. Não foi ligada aqui para não
  duplicar a lógica de compressão "best effort" por uma única rota; anexos
  de resposta admin ficam sem compressão (mesma fidelidade visual, ficheiro
  maior que no legado). Nenhuma outra funcionalidade foi cortada.
- 20 testes novos (`tests/modules/support/controllers/admin.controller.test.ts`).

Ambos os painéis wireados em `server/bootstrap/routes.ts`
(`registerPartnersAdminModuleRoutes`/`registerSupportAdminModuleRoutes`).
Suite completa após o merge dos dois: `./node_modules/.bin/eslint server tests`
limpo, `tsc -p tsconfig.json --noEmit` limpo, `vitest run` → 220 arquivos,
2002 testes, todos passando.

## 50. Correções de segurança pós-migração em `security-bulk` e `suspicious-emails`

Revisão de qualidade/documentação de `modules/admin/security-bulk/` e
`modules/admin/suspicious-emails/` (ambos já migrados, itens #25/#31) achou
4 problemas reais de blast-radius alto — todos corrigidos, sem frontend
admin ainda montado pra essas telas (portanto sem cliente a quebrar hoje;
quando o frontend for construído, já nasce sabendo do contrato novo):

1. **`suspicious-emails::deactivateFilteredSuspiciousUsers` podia
   desactivar jogador que já minerou de verdade.** A listagem/contagem
   (`resolveSuspiciousUsersWorkingSet`) decide quem bate com filtros como
   `dead_account`/`never_mined` usando uma aproximação (saldo actual + rigs
   ligadas agora), sem consultar o hash real de mineração
   (`computePlayerGameHeaderSnapshot`) — caro demais pra rodar em toda a
   listagem. Um jogador que minerou no passado mas depois gastou o saldo e
   desligou as rigs aparecia como "morto" nessa aproximação. A acção
   destrutiva reusava essa mesma lista não-refinada pra decidir quem
   desactivar de facto — o `expectedCount` (dupla-checagem de contagem)
   não protegia contra isto porque os dois lados usavam a mesma aproximação.
   **Corrigido**: antes de desactivar, o lote final passa por
   `refineActiveCandidatesWithRealHash` (`services/report.ts`), que
   confirma cada candidato com hash real quando o filtro pedido depende de
   hash (`dead_account`, `never_mined`, `zero_hash`, `no_game_progress`,
   `referral_only`, `high_risk`) e exclui quem deixar de bater — nunca
   aumenta o lote, só reduz. Resposta ganhou `excludedByRealMining`. 2
   testes novos travando o cenário (`tests/.../services/report.test.ts`).
2. **`suspicious-emails::deactivate-filtered` não exigia super-admin.**
   Qualquer `isAdmin` comum podia disparar desactivação em massa; as rotas
   equivalentes de `security-bulk` já exigiam `req.isSuperAdmin`.
   Corrigido: agora exige super-admin também.
3. **`suspicious-emails::deactivate-filtered` não exigia frase de
   confirmação.** Diferente de `force-password-reset/apply` (exige
   `{ confirm: "REDEFINIR" }`), esta rota só checava `expectedCount`.
   Corrigido: exige `{ confirm: "DESATIVAR" }`.
4. **`security-bulk::blockInactiveUsersByDays` não invalidava sessão.**
   Marcava `is_blocked = 1` mas não apagava `sessions` — uma conta
   bloqueada por inatividade com sessão já aberta continuava a usar a app
   normalmente até a sessão expirar sozinha (`is_blocked` só é checado no
   login). Diferente de `forcePasswordResetForPlayers`, que já apagava
   sessões. Corrigido: `blockInactiveUsersByDays` agora chama
   `prisma.sessions.deleteMany` pros IDs bloqueados.
5. **`security-bulk::inactive-block/apply` não exigia frase de
   confirmação**, ao contrário de `force-password-reset/apply` (mesmo
   blast-radius — bloqueio em massa, e desde o item 4 acima também mata
   sessão). Corrigido: exige `{ confirm: "BLOQUEAR" }`.

Testes novos/ajustados nos dois módulos; suíte inteira validada depois:
`./node_modules/.bin/eslint` limpo, `tsc --noEmit` limpo, `vitest run` →
220 arquivos, 1998 testes, todos passando.

## 51. Correção de segurança em `modules/auth` — limite antifraude de cadastro por IP não pegava o caso mais óbvio

Revisão de qualidade/documentação de `modules/auth/` (item #25/#31 fecha a
migração original; auth em si é anterior) achou 1 bug real de blast-radius
alto — corrigido:

**`user-creation.ts::getUserIdByEmail` — limite de 3 cadastros/IP em 90 dias
não pegava contas nunca usadas.** O filtro usava `users.last_active_at`
como proxy de "conta criada recentemente a partir deste IP", mas
`last_active_at` só é preenchido quando o utilizador se autentica depois do
registo — nada no sistema o grava no momento do cadastro em si. Uma conta
criada e nunca usada ficava com `last_active_at = null`, e
`{ gte: windowStart }` nunca confere `null` — na prática o limite nunca
pegava o padrão de abuso mais óbvio (criar várias contas do mesmo IP e
nunca mais tocar nelas). Comportamento idêntico ao legado
(`legacy/backend/models/userModel.ts`), não introduzido na migração.

**Corrigido**: nova função `countRecentSignupsFromIp` usa
`game_states.start_time` como proxy de "quando a conta foi criada" — gravado
de forma síncrona e imutável no próprio fluxo de registo, já usado em outros
lugares do projeto (`modules/admin/user-audit`, `modules/admin/support`)
como "data de criação da conta". `JOIN` explícito em SQL (`$queryRaw`), sem
`@relation` Prisma, seguindo a convenção documentada no topo do
`prisma/schema.prisma`. 3 testes novos
(`tests/modules/auth/services/user-creation.test.ts`), incluindo o cenário
exato do bug (3 contas criadas e nunca usadas, ainda assim bloqueadas).

Nenhum outro achado de segurança na revisão de `modules/auth/` (21 arquivos,
2321 linhas) — comparação de senha/token tempo-constante correta em todo
lugar (`bcrypt.compare`, `crypto.timingSafeEqual`, com dummy-hash
anti-enumeration no login), guards de admin falham fechado, JWT com
algoritmo fixo (`HS256`) e claims validados, rotação de refresh token
atômica com `SELECT...FOR UPDATE`. Suíte validada:
`./node_modules/.bin/eslint`, `tsc --noEmit` e `vitest run` (221 arquivos,
2001 testes) — todos limpos.

## 52. Correções de integridade em `modules/batteries` — item perdido ao editar rig mantida + rastreio de referência órfã de catálogo

Revisão de qualidade/documentação de `modules/batteries/` (núcleo de
persistência de save-game/inventário) achou 2 problemas — ambos corrigidos:

1. **`persistence.ts::applyDismantledRacksStockRecoveryWhenStockOmitted` só
   recuperava rigs inteiramente removidas.** Quando o caller envia
   `placedRacks` sem `stock`, o servidor recupera automaticamente os
   componentes que "sumiram" comparando com a BD — mas só detectava id de
   rig ausente do novo array. Reduzir os slots de uma rig que **continua a
   existir** (ex.: tirar 1 de 2 GPUs, remover a fiação, remover um
   multiplicador) sem enviar `stock` fazia esses itens desaparecerem de
   vez: nem voltavam ao stock, nem ficavam na rig — o `DELETE`+`INSERT` de
   `rack_slots`/`rack_multiplier_slots` substitui o conjunto antigo pelo
   novo sem comparar item a item. Nenhum caller atual acionava isso
   (confirmado por grep), mas era um risco latente pra qualquer caller
   novo. **Corrigido**: a recuperação agora também compara, rig por rig
   mantida, a contagem de cada item nos slots/multiplicadores/fiação
   (BD vs payload novo) e devolve ao stock a diferença — mesma exclusão de
   ASICs com validade (tracked via lease, não stock comum) já aplicada ao
   caso de rig inteiramente removida. Bateria em rig mantida não precisou
   de tratamento — `stored_batteries` só é tocada se o caller enviar
   `storedBatteries` explicitamente, então uma troca/remoção de bateria
   sem isso não perde a instância (fica órfã de `placed_racks`, mas
   continua existindo em armazém). 2 testes novos
   (`tests/modules/batteries/services/persistence.test.ts`).
2. **`placed-racks-validate.ts` — referência a item fora do catálogo só
   gerava `console.warn`.** Mantida a tolerância deliberada (não bloqueia
   o save — dado legado/catálogo editado depois do item equipado não pode
   travar o jogador), mas agora também emite `orphan_risk_detected` via
   `appendGameActivityLogMongo` (throttled), mesmo padrão de auditoria já
   usado no mesmo arquivo pro scan de bateria UUID órfã — antes ficava só
   no log do processo, sem rastro consultável. 2 testes novos
   (`tests/modules/batteries/services/placed-racks-validate.test.ts`,
   arquivo novo — nenhum dos dois serviços tinha teste dedicado antes).

Suíte validada: `./node_modules/.bin/eslint`, `tsc --noEmit` e `vitest run`
(223 arquivos, 2005 testes) — todos limpos.

## 53. Revisão de `modules/black-market/` — bloqueio nas mutações, taxa, idempotência e SQL seguro

Revisão de qualidade (mesmo padrão da #52 em batteries) sobre o mercado P2P
já migrado (#34). Achados e correções:

1. **Mutações financeiras não checavam `is_blocked`.** Só `GET /state`
   rejeitava conta bloqueada. `authenticateToken` não consulta `is_blocked`
   (só o login), então um JWT ainda válido pós-bloqueio podia vender/comprar/
   liquidar/resgatar. **Corrigido**: helper `requireActiveUser` em todas as
   rotas de escrita (`sell`, `cancel`, `reserve`, `cancel-reserve`, `buy`,
   `claim`, `claim-all`, `claim-item`) + `state`.

2. **`POST /buy` devolvia `400` + `e.message` em erros inesperados** —
   tratava falha de BD como erro de negócio e vazava detalhe técnico ao
   cliente. **Corrigido**: passa pelo `sendInternalErrorSafeMessageOrPrisma`
   (500 + mensagem pública em production).

3. **`$executeRawUnsafe` em `clearExpiredReservations`** (listings) —
   último unsafe do módulo; convertido para tagged `$executeRaw`.

4. **`market_tax_percent` sem clamp** — valor > 100 na BD fazia
   `sellerReceive` negativo (crédito negativo no vendedor). Clamp a
   `[0, 100]` antes do cálculo.

5. **Corrida de `idempotencyKey` (P2002)** — segundo pedido paralelo com a
   mesma key falhava opaco. Agora lança `HttpControlledError 409
   IDEMPOTENCY_CONFLICT`; o controller re-lê o cache e devolve o resultado
   do vencedor (a tx perdedora reverte o débito).

6. **`runReferralCommissionOnTx` engolia erros dentro da mesma tx da
   compra** — comentário dizia que isso evitava reverter a compra, mas em
   Postgres uma query falhada aborta a tx (`25P02`); o catch só mascarava
   a causa. Removido o swallow: comissão ou compra fecham juntas, ou
   reverte tudo.

Nota (não alterado, paridade com legado): anúncios com `expires_at` no
passado somem das listagens mas o stock só volta ao vendedor via
`cancelListing` manual — não há cron de sweep.

Testes novos/ajustados em `tests/modules/black-market/` (controller +
mutations + listings). Suíte validada: eslint, `tsc --noEmit` (json +
build) e `vitest run` — **223 arquivos, 2011 testes**, todos limpos.

## 54. Revisão de `modules/checkin/` — bloqueio, qty honesta e docs do streak lease

Revisão de qualidade (mesmo padrão #52/#53) sobre o check-in já migrado.

1. **`POST /api/checkin` e `GET /status` não checavam `is_blocked`.**
   Conta bloqueada com JWT ainda válido podia farmar `checkin_bonus_hps` /
   baterias. **Corrigido**: `requireActiveUser` (404/403) nas duas rotas
   player-facing — mesmo padrão do black-market (#53).

2. **`grantCheckinInventoryItem` mentia `granted=qty` com 1 INSERT.** Com
   `dailyRewardAmount`/`weeklyRewardAmount` > 1 e tipo `battery`/`item`,
   gravava uma linha em `stored_batteries` e reportava N — cliente e
   auditoria viam recompensa maior do que o inventário real. **Corrigido**:
   valida o upgrade uma vez, insere N UUIDs, `granted` = contagem real de
   inserts. (Bug herdado do legado; corrigido na revisão.)

3. **Docs stale** em `index.ts` / cabeçalho de `checkin.ts` ainda diziam
   que `grantCheckinStreakTemporaryItem` "não concede de verdade" — mentira
   desde #50 (ASIC lease religado). Actualizado.

Nota mantida (paridade legado): prémio de streak 7/14/21… só no fluxo
diário; check-in premium por intervalo não recebe máquina temporária.
Tipos `battery` e `item` ambos usam `stored_batteries`.

Testes novos em controller (bloqueio) + reward (qty>1). Suíte checkin:
75/75; eslint/tsc limpos. Suíte global: **223 arquivos, 2014 testes**.

## 55. Revisão de `modules/dashboard/` — bloqueio, ranking top[-1], asset parceiros

Revisão de qualidade (mesmo padrão #52–#54) sobre o agregador da home.

1. **`GET /api/dashboard/state` não checava `is_blocked`.** Conta bloqueada
   com JWT ainda válido via hash/saldo/ranking. **Corrigido**:
   `requireActiveUser` (404/403) — mesmo padrão checkin/black-market.

2. **Injecção do jogador fora do top 10 escrevia `top[top.length - 1]`**
   sem guardar `length === 0`. Em JS isso cria a propriedade `"-1"` sem
   alterar `length` — o `isMe` sumia do array serializado. **Corrigido**:
   `push` se top vazio/incompleto; só substitui o último quando o top
   está cheio (`RANKING_TOP_LIMIT`).

3. **`img/parceiros/blockminer.webp` não existia em `current/`** — cache-bust
   do banner BlockMiner nunca via ficheiro; URL caía no fallback sem `?v=`.
   Copiado de `legacy/backend/img/parceiros/`. Path resolve via `IMG_DIR`
   (mesmo env do bootstrap), não hardcode `img/` relativo ao cwd Docker
   antigo.

4. **Query `users` duplicada** por request (username + access_level) —
   consolidada num único `findUnique`; `buildMinerStateForDashboard` recebe
   `accessLevelId`. Comentário de “energia proxy” alinhado com a realidade
   (sempre `null` — baterias UUID infinitas).

5. **`system_news` engolia erros em silêncio** — passou a `console.warn`,
   igual às outras falhas best-effort do módulo.

Testes novos: bloqueio no controller; ranking fora do top 10 no service.
Suíte dashboard 13/13; eslint/tsc limpos. Global: **223 arquivos, 2017 testes**.

## 56. Remoção de `modules/email-campaigns/`

Pedido explícito do dono do projeto: tirar campanhas de e-mail em massa
de `current/`. Removido por completo:

- `server/modules/email-campaigns/` (controller, campaigns, cron, index)
- `tests/modules/email-campaigns/`
- montagem em `bootstrap/routes.ts` (`registerEmailCampaignsModuleRoutes`)
- `startEmailCampaignCron()` em `bootstrap/server.ts`
- menções em `ESTRUTURA.txt`, `PROJECT_OVERVIEW.md`, inventário de módulos,
  `MIGRATION_TRACKER.md`

O item #13 (migração original) e o wiring de cron no #47 ficam como
histórico; este módulo **não** volta a ser montado. Tabelas Prisma
`email_campaigns` / `email_campaign_deliveries` não foram dropadas — só
deixam de ter consumidor em `current/` (podem limpar-se numa migração
DDL futura se quiserem). `email-verification` (registo) mantém-se.

## 57. Revisão de `modules/guide/` — validação, reorder atómico e erros controlados

Revisão de qualidade (mesmo padrão #52–#55) sobre o guia CMS já migrado.
Sem mutações player-facing — `is_blocked` não se aplica (só `isAdmin` no
CRUD; GET público). Achados e correções:

1. **`reorderGuideCategories` / `reorderGuidePages` fora de transação** —
   UPDATE sequencial: id inexistente a meio deixava ordenação parcial.
   **Corrigido**: `$transaction` (mesmo padrão do roadmap). Rotas de
   reorder passaram a ter `try/catch` (antes falha Prisma podia ficar
   sem resposta HTTP bem formada).

2. **Update aceitava título vazio** — `create` exigia título; `update` com
   `title: "  "` gravava string vazia. **Corrigido**: `requireNonEmptyTitle`
   via `HttpControlledError 400 VALIDATION`.

3. **`updateGuidePage` / reorder de páginas sem validar categoria** —
   `categoryId` fantasma ou vazio ia direto ao UPDATE (FK/P2003 ou
   `category_id=""`). **Corrigido**: `requireCategory` no create/update/
   reorder de páginas; reorder exige `categoryId` não vazio.

4. **Validação via `throw new Error` + controller a devolver `400 +
   e.message`** — misturava erro de negócio com 500 Prisma. **Corrigido**:
   `HttpControlledError` + `respondIfHttpControlledError` (padrão
   roadmap/checkin). Deletes admin também ganharam `try/catch`.

Nota mantida (paridade legado): sanitização HTML continua básica
(regex scripts/handlers/`javascript:`) — não é um sanitizer HTML
completo; conteúdo é trust-admin. Defaults assimétricos mantidos:
categoria nasce publicada; página nasce rascunho.

Testes novos/ajustados em `tests/modules/guide/`. Suíte guide: 32/32;
eslint/`tsc` limpos. Global: **220 arquivos, 1984 testes**.

## 58. Revisão de `modules/roadmap/` — título no update e PUT controlado

Revisão de qualidade (mesmo padrão #57 guide) sobre o CMS de roadmap.
Reorder em `$transaction` e `HttpControlledError` no create já existiam
(paridade prévia com o roadmap legacy melhorado). Achados e correções:

1. **Update aceitava título vazio** — `create` exigia título; `update` com
   `title: "  "` gravava string vazia. **Corrigido**: `requireNonEmptyTitle`
   via `HttpControlledError 400 VALIDATION` (igual ao guide #57).

2. **PUT admin sem `respondIfHttpControlledError`** — validação no update
   caía no 500 Prisma-safe. **Corrigido**: mesmo ramo do create.

Nota: sem mutações player-facing (`is_blocked` N/A). Flags `ACTIVE_FLAG`/
`INACTIVE_FLAG` nas queries e writes.

Testes novos/ajustados em `tests/modules/roadmap/`. Suíte roadmap: 24/24;
eslint/`tsc` limpos. Global: **220 arquivos, 1986 testes**.

## 59. `in-app-announcements` → `announcements` + revisão (bloqueio)

O nome `in-app-announcements` era verboso e feio; o módulo só faz avisos
popup no jogo + Mini Blog. **Renomeado** para `modules/announcements/`:

- Pastas `server/modules/announcements/` e `tests/modules/announcements/`
- Símbolos: `registerAnnouncementsModuleRoutes`, `AnnouncementDto`,
  `AnnouncementValidationError`, etc.
- Paths canónicos: `/api/announcements/pending`,
  `/api/announcements/:id/dismiss`, `/api/admin/announcements`
- **Aliases** `/api/in-app-announcements/*` e
  `/api/admin/in-app-announcements` mantidos (frontend legado / clientes
  antigos). Allowlist do account-manager e `admin-route-auth` aceitam os
  dois. `legacy/frontend/services/api.ts` passou aos paths novos.
- Tabelas Prisma `in_app_announcements*` **não** renomeadas (DDL).

Revisão de qualidade no mesmo passe:

1. **Rotas jogador sem `is_blocked`** — JWT pós-bloqueio ainda lia/dismissava
   avisos. **Corrigido**: `requireActiveUser` em pending, mini-blog e dismiss
   (padrão #53–#55).

2. Flags `ACTIVE_FLAG`/`INACTIVE_FLAG` nas queries/writes (sem magic `1`/`0`
   soltos no service).

Nota: sanitização de link/imagem/texto da validation mantém-se; Mini Blog
continua em `/api/mini-blog`.

Testes novos/ajustados em `tests/modules/announcements/`. eslint/`tsc`
limpos. Global: **220 arquivos, 1988 testes**.

## 60. Revisão de `modules/inventory/` — `/me` religado + higiene

Revisão de qualidade sobre o snapshot de inventário (#18/#24). Achados:

1. **`GET /api/inventory/me` não estava portado** — o frontend usa
   `getPlayerInventoryMe()` como **fallback** quando `/state` falha
   (`App.tsx`). O corte do #18 dizia "nenhum consumidor"; havia. O service
   `loadPlayerInventorySnapshot` já existia sem rota. **Corrigido**: rota
   no mesmo controller, com bloqueio/`AUTH_REQUIRED` e o contrato
   `{ ok, stock, storedBatteries, serverUpdatedAt }`.

2. **Rate-limit por IP só** — partilhado atrás de NAT. **Corrigido**:
   `keyGenerator` por `userId` (fallback IP), janela via `MS_PER_MINUTE`
   partilhado.

3. Allowlist do account-manager documentava só `/inventory(/snapshot)` —
   actualizada para `/state|/me|/snapshot` (GETs não-admin já passavam
   todos; alinhamento documental).

Já OK desde a migração: `is_blocked` em `/state`, tick best-effort, filtro
de baterias montadas via invariante.

Testes novos em controller (+ guard). eslint/`tsc` limpos. Global:
**220 arquivos, 1991 testes**.

## 61. Revisão de `modules/lucky-boxes/` — bloqueio nas mutações + SQL seguro

Revisão de qualidade (padrão #53 black-market) sobre as Caixas da Sorte.

1. **Só `GET /state` checava `is_blocked`.** Shop/inventory/history/
   openings + mutações (`purchase`, `open`, `discard`, `promocodes/redeem`)
   deixavam JWT pós-bloqueio comprar/abrir/resgatar. **Corrigido**:
   `requireActiveUser` em todas as rotas jogador (antes do replay de
   idempotência nas mutações).

2. **`$executeRawUnsafe` em `executeLootBoxOpenInTransaction`** (`SET LOCAL
   lock_timeout`) — último unsafe do módulo. **Corrigido**:
   `tx.$executeRaw(Prisma.raw(...))`, igual ao black-market (#53).

3. Rate-limit por `userId` + `MS_PER_MINUTE` partilhado (antes IP + magic
   `60_000`).

Nota: CRUD admin `/api/loot-boxes` legado continua fora de escopo (#19).

Testes novos em controller (bloqueio purchase/open/shop). eslint/`tsc`
limpos. Global: **220 arquivos, 1994 testes**.

## 62. Revisão de `modules/merge/` — bloqueio + lock_timeout

Revisão de qualidade (padrão #53/#61) sobre a Merge Station.

1. **Nenhuma rota jogador checava `is_blocked`.** JWT pós-bloqueio ainda
   lia inventário/histórico e executava merge (consome stock + USDC).
   **Corrigido**: `requireActiveUser` em inventory, history e execute
   (config pública mantém-se só com auth — sem dados de conta).

2. **Tx de `executeMerge` sem `lock_timeout`** — `FOR UPDATE` em stock/
   game_states podia esperar indefinido (504 no proxy). **Corrigido**:
   `SET LOCAL lock_timeout` após `BEGIN` (constante 45s, padrão
   lucky-boxes/black-market).

3. Rate-limit por `userId` + `MS_PER_MINUTE` partilhado.

Testes novos em controller (bloqueio) + assert de `lock_timeout`.
eslint/`tsc` limpos. Global: **220 arquivos, 1996 testes**.

## 63. Revisão de `modules/mining-engine/` — pool timeout + accrual SAVEPOINT

Revisão de qualidade (padrão #53/#62) sobre o motor de crédito
(`progress-computer` + `yield-cron` / leases / NFT). Já tinham
`is_blocked` (early-return + filtro no cron) e anti-corrida
(`FOR UPDATE` + ledger).

1. **`SET statement_timeout = '5s'` sem `LOCAL`** na tx de crédito —
   após COMMIT/ROLLBACK o timeout ficava na sessão e envenenava a
   conexão devolvida ao pool pg (queries seguintes de outros pedidos
   herdavam 5s). **Corrigido**: `SET LOCAL statement_timeout` +
   `SET LOCAL lock_timeout` (const `PROGRESS_TX_TIMEOUT_MS`).

2. **`accrueManagerMiningShare` engolia erro na mesma tx** — comentário
   “não bloqueia crédito”, mas em Postgres query falhada aborta a tx
   (`25P02`); o catch só mascarava e o COMMIT do crédito falhava.
   **Corrigido**: SAVEPOINT `mining_progress_accrual_sp` +
   `ROLLBACK TO SAVEPOINT` no catch (crédito do jogador continua;
   accrual do gerente é best-effort de verdade).

`yield-cron` / `asic-lease` / NFT: sem `queryRawUnsafe`; bloqueio e
grelha OK — sem mudança de lógica.

Testes novos em `progress-computer` (LOCAL timeouts + accrual SAVEPOINT).
eslint/`tsc` limpos. Global: **220 arquivos, 1997 testes**.

## 64. Revisão de `modules/partners/` — bloqueio, rate-limit e avatar path

Revisão de qualidade (padrão #53/#62) sobre Parceiros YouTube (jogador).

1. **Rotas autenticadas não checavam `is_blocked`.** JWT pós-bloqueio
   ainda enviava vídeos, candidaturas, upload de avatar e editava perfil
   (`my-submissions` incluído). **Corrigido**: `requireActiveUser` em todas
   as rotas autenticadas; em `avatar-upload` a checagem corre **antes** do
   multer (não grava ficheiro em disco se bloqueado).

2. **Rate-limit só por IP** em submit/apply. **Corrigido**: `keyGenerator`
   por `userId` (fallback IP); auth **antes** do limiter para a chave ter
   JWT resolvido. `MS_PER_MINUTE` partilhado.

3. **`sanitizePartnerCreatorAvatarUrl` aceitava `..` em path relativo**
   (`/img/../../...`). **Corrigido**: rejeita qualquer `..`.

4. `unlocked_slots: 4` no grant da Sala Streamer → constante nomeada.

Admin (`partners-admin`): já `isAdmin` + `HttpControlledError`; SQL tagged
Prisma — sem mudança.

Testes novos em controller (bloqueio) + helpers (`..`).
eslint/`tsc` limpos. Global: **220 arquivos, 2001 testes**.

## 65. Revisão de `modules/player-calculator/` — rate-limit + block_history por scope

Revisão de qualidade (padrão #53/#64) sobre `GET /api/calculator/me`.
Já rejeitava `is_blocked` e usava `HttpControlledError` / degrade `42P01`.

1. **Rate-limit só por IP.** **Corrigido**: `keyGenerator` por `userId`
   (fallback IP); auth **antes** do limiter; `MS_PER_MINUTE` +
   `BLOCKED_FLAG` / `requireActiveUser` (padrão merge/partners).

2. **`mining_block_history` sem filtro de sala** — com `scope=roomId`, o
   `LIMIT 120` era global; em contas multi-sala os blocos da sala pedida
   podiam ficar fora da janela. **Corrigido**: SQL filtra por room
   (NULL/''/`main` → `room_initial`, alinhado a `normalizePlacedRackRoomId`).

3. Constantes `ROOM_INITIAL_ID` / nome fallback (sem magic string solta).

Testes novos em snapshot (scope → param room na query).
eslint/`tsc` limpos. Global: **220 arquivos, 2002 testes**.

## 66. Revisão de `modules/profile/` — bloqueio + races de referral/wallet/username

Revisão de qualidade (padrão #53/#65) sobre perfil (identity/password/
wallet/referral). Rate-limit já por `userId`; SQL tagged OK.

1. **0/12 rotas autenticadas checavam `is_blocked`.** JWT pós-bloqueio
   lia/mutava perfil, carteira e referral. **Corrigido**:
   `requireActiveUser` partilhado (`services/require-active-user.ts`) em
   profile/wallet/referral controllers.

2. **`bindProfileReferralCode`**: check `referred_by` fora da tx → corrida
   2 códigos. **Corrigido**: `FOR UPDATE` + revalidação na tx +
   `SET LOCAL lock_timeout`.

3. **`creditReferralBonusOnEmailVerified`**: `referral_bonus_claimed` sem
   lock → USDC 2×. **Corrigido**: `SELECT … FOR UPDATE` em `game_states`.

4. **Wallet verify**: consume challenge sem row lock. **Corrigido**:
   `FOR UPDATE` + `lock_timeout`.

5. **Username** sem `@@unique`: TOCTOU → duplicados. **Corrigido**:
   `UPDATE` condicional (`NOT EXISTS` case-insensitive).

## 67. Revisão de `modules/quests/` — bloqueio, rate-limit, lock_timeout, premium gate

1. **`GET /state` + `POST /claim` sem `is_blocked`** (claim = USDC).
   **Corrigido**: `requireActiveUser`.

2. **Sem rate-limit.** **Corrigido**: limiter por `userId` +
   `MS_PER_MINUTE`.

3. **`BEGIN`/`FOR UPDATE` sem `lock_timeout`** (bump + claim).
   **Corrigido**: `SET LOCAL lock_timeout`.

4. **Premium check-in TOCTOU**: dois `getQuestsState` → weekly +2.
   **Corrigido**: gate `FOR UPDATE` + bump na mesma tx.

5. Admin title `"  "` → vazio. **Corrigido**: rejeita title vazio.

## 68. Revisão de `modules/ranking/` — bloqueio + rate-limit

1. **`/public` e `/me` sem `is_blocked`.** **Corrigido**:
   `requireActiveUser` (public também exige uid activo).

2. **Sem rate-limit** (polling header). **Corrigido**: limiter por
   `userId`. Scan já filtrava `is_blocked=0`.

Testes novos (bloqueio) nos 3 módulos.
eslint/`tsc` limpos. Global: **220 arquivos, 2009 testes**.

## 69. Revisão de `modules/roadmap/` — confirmada limpa

Revisão de qualidade (padrão #53/#58). Sem achados novos: CMS admin +
GET público; título vazio já rejeitado (#58); `HttpControlledError`; sem
raw unsafe; sem rotas jogador autenticadas (`requireActiveUser` N/A).

## 70. Revisão de `modules/rooms/` — bloqueio, rate-limit, LOCAL timeouts

1. **`POST /purchase-slot` sem `is_blocked`** (debita USDC). **Corrigido**:
   `requireActiveUser`.

2. **Sem rate-limit.** **Corrigido**: limiter por `userId` +
   `MS_PER_MINUTE`.

3. **`SET statement_timeout` sem `LOCAL`** + `FOR UPDATE` sem
   `lock_timeout`. **Corrigido**: `SET LOCAL` ambos (padrão #63/#62).

## 71. Revisão de `modules/servers/` — bloqueio, LOCAL timeouts, idempotência na tx

1. **0/9 rotas jogador sem `is_blocked`.** **Corrigido**:
   `requireActiveUser` em `runRackAuxMutation` + `GET /servers/state`.

2. **`SET statement_timeout` sem `LOCAL`** + sem `lock_timeout` na tx de
   mutação. **Corrigido**: `SET LOCAL` ambos.

3. **Idempotency write após COMMIT** (swallow) — retry re-aplicava
   mutação. **Corrigido**: escrita na mesma tx via pg client (fail closed).

4. Rate-limit por `userId` nas mutações + state.

Testes ajustados/novos (bloqueio, timeouts).
eslint/`tsc` limpos. Global: **220 arquivos, 2010 testes**.

## 72. Revisão de `modules/shop/` — bloqueio, rate-limit, lock_timeout

1. **8/9 rotas sem `is_blocked`** (só `/state` tinha). **Corrigido**:
   `requireActiveUser` em todas.

2. Limiter IP-only + **antes** do auth. **Corrigido**: auth → limiter;
   `keyGenerator` por `userId`; `MS_PER_MINUTE`.

3. Checkout `FOR UPDATE` sem `lock_timeout`. **Corrigido**: `SET LOCAL`.

## 73. Revisão de `modules/support/` — bloqueio, rate-limit, HCE, lock_timeout

1. **0/7 rotas sem `is_blocked`.** **Corrigido**: `requireActiveUser`
   (antes do multer em create/reply).

2. Limiter antes do auth / só IP. **Corrigido**: auth → limiter;
   chave por `userId`.

3. `SupportMutationError` + `e.message`→400. **Corrigido**: estende
   `HttpControlledError` + `respondIfHttpControlledError`.

4. Advisory lock sem `lock_timeout`. **Corrigido**: `SET LOCAL` na tx.

## 74. Revisão de `modules/upgrades/` — bloqueio, rate-limit, saldo FOR UPDATE

1. **0/3 rotas jogador sem `is_blocked`.** **Corrigido**:
   `requireActiveUser` + rate-limit por `userId`.

2. Compra sem `lock_timeout`; USDC sem row lock. **Corrigido**:
   `SET LOCAL lock_timeout` + `SELECT … FOR UPDATE` em `game_states`.

Testes novos (bloqueio) nos 3 módulos.
eslint/`tsc` limpos. Global: **220 arquivos, 2014 testes**.

## 75. Revisão de `modules/wallet/` — bloqueio, rate-limit, lock_timeout, FOR UPDATE

1. **0/3 rotas sem `is_blocked`.** **Corrigido**: `requireActiveUser`.

2. **Sem rate-limit.** **Corrigido**: auth → limiter; `keyGenerator` por
   `userId`; `MS_PER_MINUTE`.

3. Liquidação: `FOR UPDATE`/`advisory` sem `lock_timeout`; crédito USDC sem
   row lock. **Corrigido**: `SET LOCAL lock_timeout` + `SELECT … FOR UPDATE`
   em `game_states`.

## 76. Revisão de `modules/wheel/` — bloqueio, rate-limit, lock_timeout

1. **0/8 rotas jogador sem `is_blocked`.** **Corrigido**: `requireActiveUser`
   + rate-limit por `userId` (auth antes).

2. Spin/roll/claim/redeem: `FOR UPDATE`/advisory sem `lock_timeout`.
   **Corrigido**: `SET LOCAL` no início de cada tx de mutação.

## 77. Revisão de `modules/zerads/` — bloqueio, rate-limit, crédito seguro

1. **`/me/token` e `/me/stats` sem `is_blocked`.** **Corrigido**:
   `requireActiveUser`.

2. Limiter de token **antes** do auth / só IP; stats sem limiter.
   **Corrigido**: auth → `meLimiter` por `userId`; `MS_PER_MINUTE`.

3. Callback creditava conta bloqueada. **Corrigido**: no-op `200 blocked`
   + log `status: blocked`.

4. Crédito sem `lock_timeout` / sem row lock em `game_states`. **Corrigido**:
   `SET LOCAL` + `SELECT … FOR UPDATE` antes do UPDATE.

**Follow-up pós-review:** wallet lock order `game_states`→coin + abort se
sem row; zerads exige row locked + `COALESCE(usdc,0)` + user em falta =
`unknown_user` (não credita).

Testes novos (bloqueio) nos 3 módulos.
eslint/`tsc` limpos. Global: **220 arquivos, 2024 testes**.

## 78. Varredura geral `modules/` — gaps residuais pós-#65–#77

Varredura completa de `server/modules/` (padrão #65–#77). Já limpos:
shop/support/upgrades/wallet/wheel/zerads/quests/ranking/rooms/
player-calculator/roadmap/guide/mining-engine/admin.

**Corrigido nesta leva:**

1. **black-market** — auth antes do limiter; `keyGenerator` userId;
   `MS_PER_MINUTE`; `requireActiveUser` nos GETs; `SET LOCAL lock_timeout`
   em sell/cancel/claim*.

2. **batteries** — `requireActiveUser` + rate-limit; `SET LOCAL`
   statement/lock_timeout.

3. **checkin** — rate-limit; `SET LOCAL` statement/lock_timeout.

4. **lucky-boxes** — auth antes do limiter; compra/open com
   `FOR UPDATE` em `game_states`; discard com `lock_timeout`.

5. **merge/inventory** — auth antes do limiter.

6. **dashboard** — rate-limit por userId.

7. **account-manager** — `requireActiveUser` + rate-limit; `lock_timeout`
   nas txs com `FOR UPDATE`.

8. **chat** — `requireActiveUser` + rate-limit; gate antes do multer
   no upload de áudio.

9. **profile/referral-credit** — `lock_timeout` + `FOR UPDATE` no
   referrer antes do incremento USDC.

**Residual (baixo / fora do núcleo money):** partners rotas sem
rate-limit pontual; `MergeError`/`LootBox*Error`/`AccountManagerError`
ainda não estendem `HttpControlledError` (mapeados no controller);
TOCTOU clássico de `is_blocked` fora da tx. → **fechado em #79**.

eslint/`tsc` limpos. Global: **220 arquivos, 2024 testes**.

## 79. Residual #78 — TOCTOU `is_blocked` na tx + HCE + rate-limit pontual

Fecha o residual documentado em #78.

1. **`assertActiveUserPg` / `assertActiveUserPrisma`**
   (`shared/security/assert-active-user-tx.ts`) — `SELECT is_blocked …
   FOR UPDATE` logo após `SET LOCAL lock_timeout` nas txs money:
   wallet liquidate, shop checkout, rooms slot, merge execute, wheel
   paid spin, upgrades purchase, lucky-boxes buy, black-market
   sell/cancel/buy/claim*, zerads credit.

2. **Bug fix black-market buy** — `assertActiveUserPrisma(tx, buyerId)`
   (não `userId` inexistente no scope).

3. **HCE** — `MergeError`, `LootBoxOpenError`/`BuyError`/`DiscardError`,
   `AccountManagerError` estendem `HttpControlledError`; controllers
   usam `respondIfHttpControlledError`.

4. **Rate-limit** — partners (`my-submissions` / avatar / profile);
   announcements read (`pending` / mini-blog).

5. **Testes** — mocks com row `users.is_blocked`; fakes HCE criadas
   **após** `vi.resetModules()` (mesma classe que
   `respondIfHttpControlledError`).

eslint/`tsc` limpos. Global: **220 arquivos, 2024 testes**.

## 80. Frontend — chrome pós-login extratado do monólito `App.tsx`

**Problema no legado:** navbar + sidebar do jogo não eram componentes.
Viviam inline em `legacy/frontend/App.tsx` (header ~2930, mobile drawer
~3148, aside ~3442, `gameNavItems` ~1254). Impossível portar ecrãs sem
carregar o monólito inteiro.

**Decisão:** extrair chrome para `current/client/src/features/game/` com
fidelidade visual; **não** portar ainda o estado do jogo (racks, WS,
saldos). Conteúdo por `currentView` = stub até a próxima leva.

**Layout:**

```
GameShell
  GameTopNav          — header (stats strip com placeholders)
  GameMobileDrawer    — menu < lg
  GameSidebar         — aside lg+ (expand LS `minestation.gameNavExpanded`)
  main                — stub por view
```

Nav items / estilos / labels: `nav/buildGameNavItems.ts` +
`shared/constants/gameNavLabels.ts` (cópia do legado).

**App.tsx:** views públicas mantêm `LandingHeader`; `view === 'game' &&
user` monta só `GameShell` (sem header público por cima).

**Cortes conscientes nesta leva:** URL sync (`/servers`…), labels do
servidor, allowlist via `accessLevels`, sidebar direita MiniBlog, admin
aside, strip com dados reais.

**Idle:** GameShell não faz fetch. Doc:
`docs/development/frontend/GAME_SHELL.md`.

## 81. Frontend — sala de mineração (`servers` / Mineração)

**Problema:** após #80 o shell existia mas `currentView === 'servers'`
era stub.

**Decisão:** portar o monólito UI `ServerRoom` (+ fx, modelos,
validação, tipos) para `current/client/src/features/servers/`, com
página fina `MiningPage` que:

1. Carrega só `GET /api/servers/state` (não o gameState completo).
2. Mutações autoritativas place/remove/miner/aux + room-coins.
3. Power/moeda por rack: estado local + `POST /api/game/save-servers`.

`GameShell` renderiza `MiningPage` em Mineração. Check-in banner,
Footer, bulk batteries e calculadora completa ficam para levas
seguintes.

Doc: `docs/development/frontend/GAME_SHELL.md` (secção Mineração).

## 82. Frontend Vite — proxy `/img` para o backend (URLs flat)

**Problema:** no dev, `public/img` → symlink a `current/img/` só serve
ficheiros no path exacto. ~700 assets estão em `img/uploads/` mas a BD
guarda URLs flat `/img/123_foo.webp`. O middleware
`mountImageStaticMiddleware` (já no backend #44) resolve isso; o Vite
sem proxy devolvia **HTML 200** (SPA fallback) → `<img>` partido na
sala/loja.

**Decisão:** `vite.config.ts` faz proxy de `/img` (e `/api`) para
`PORT` (default 3000). Não depender do symlink para URLs flat.

## 83. Assets de imagem em `storage/` (não `img/` na raiz)

**Problema:** no bootstrap local as imagens da VM foram parar em
`current/img/` (~450 MB), ignorando `ESTRUTURA.txt`:

```
storage/
  media-seed/   # era backend/img/* (catálogo)
  uploads/      # uploads runtime
  backups/
```

**Decisão:**

1. Conteúdo movido: pastas de catálogo → `storage/media-seed/`;
   `img/uploads/` → `storage/uploads/`.
2. `.env`: `IMG_DIR=storage/media-seed`,
   `IMG_UPLOADS_DIR=storage/uploads`.
3. Defaults em `bootstrap/deps.ts` alinhados.
4. Disco: `media-seed/uploads` → `../uploads` (URLs HTTP `/img/uploads/...`).
   O symlink `current/img` → `storage/media-seed` foi removido (2026-08-19):
   era compat de filesystem; o código usa só `IMG_DIR` / `IMG_UPLOADS_DIR`.
5. URL pública continua `/img/...` (proxy Vite #82 + middleware #44).
   `/img` é rota HTTP, não pasta na raiz do repo.

Não misturar assets de jogo com código em `img/` na raiz do repo.

## 84. `storage/media-seed` — subpastas canónicas em inglês

**Problema:** pastas PT (`baterias`, `carregadores`, `moedas`, `parceiros`)
e dump em `uploads/` misturavam suporte/racks/GPUs.

**Decisão — catálogo EN sob `storage/media-seed/`:**

| Pasta | Conteúdo |
|-------|----------|
| `miner` | GPUs / ASICs / default |
| `rack` | chassis / racks |
| `fan` | fans / cooling |
| `chip` | AI opt / multipliers |
| `battery` | baterias |
| `charger` | carregadores / circuitos |
| `coin` | ícones de moeda |
| `support` | anexos `support-*` |
| `partner` | parceiros |
| `favicon` / `landing` | chrome |

`classifyImageSubfolder` + `reclassifyFilesInDirectory` usam estas pastas.
Aliases PT (`baterias`→`battery`, …) ficam como **symlinks** para URLs
antigas. `uploads/` fica para ads / chat-audio / partner-avatars + resto.

## 85. Idioma padrão do jogador = inglês (admin fora)

**Decisão:** UI do **jogador** em `current/client` (home, auth, shell,
nav labels, sala de mineração) passa a ser **inglês**. `index.html`
`lang="en"`.

**Admin:** painel admin ainda não portado; quando for, permanece PT
(ou i18n separado). Erros devolvidos pela API em PT continuam a
mostrar-se tal como vêm até haver camada de i18n/mensagens EN no
backend para rotas de jogador.

Sem biblioteca i18n nesta leva — strings hardcoded EN (espelho do
legado PT).

## 86. Mensagens de erro da API do jogador = inglês

Complementa #85 (UI EN). Strings `error` / `message` / rate-limit
devolvidas ao **jogador** passam a inglês.

- Constantes partilhadas: `server/shared/i18n/player-messages.ts`
- Auth, servers, shop, wallet, etc. traduzidos in-place
- `server/modules/admin/**` e middlewares admin-only podem ficar em PT
- Testes de jogador atualizados para asserts EN

API ainda sem i18n runtime (sem Accept-Language) — EN é o default fixo.

## 87. Password reset por email (módulo auth)

**Problema:** a aba de recovery no `AuthPage` e os wrappers do client
já chamavam `POST /api/request-password-reset` e
`POST /api/reset-password-secure`, mas o server em `current` não
registava essas rotas (só body-limit + `sendResetEmail` órfão).

**Decisão:** portar o fluxo por email do legado para
`modules/auth` (`services/password-reset.ts` +
`controllers/password-reset.controller.ts`), montado em
`bootstrap/routes.ts`, com limiters dedicados em `bootstrap/deps.ts`.

- Token HMAC + hash SHA-256 de uso único em `users.password_reset_*`
- Resposta genérica no pedido (anti-enumeração)
- Mensagens e e-mail de reset em inglês (#85/#86)
- `POST /api/verify-recovery-wallet` **não** portado (legado; AuthPage não usa)

## 88. i18n do jogador: EN default + pt-BR + es

**Decisão:** UI do jogador em `current/client` usa i18n leve
(`shared/i18n`), sem i18next.

- **Default do site:** inglês (`en`) quando o browser não é pt/es
- **Auto:** `navigator.languages` → `pt*` → `pt-BR`, `es*` → `es`
- **Manual:** `LanguageSwitcher` (landing + game chrome); preferência em
  `localStorage` (`genesis.locale`)
- Catálogos: `locales/en.ts` (fonte), `pt-BR.ts`, `es.ts` (traduções
  geradas a partir do EN)
- `document.documentElement.lang` atualizado com o locale ativo
- API continua EN fixo (#86); ServerRoom detalhado ainda maioritariamente EN
  (chrome de mining load/error já traduzido)

Substitui a regra “só EN hardcoded” de #85 para a superfície portada.

## 89. IDs internos ocultos + salas ≠ níveis de acesso

**Problema:** o detalhe de item na sala mostrava `ID: …` (código de catálogo).
Apagar/renomear esses códigos no admin liga stock, racks, caixas e pacotes —
item some da conta ou vira legacy. Expor o id convida a mexer no sítio errado.

No domínio, **salas (`rig_rooms`) ≠ níveis de acesso (`access_levels`)**.
Níveis são membership; salas são pisos. O gate é `allowed_levels` (IDs de
membership), não “a sala é um nível”. Dados antigos até batizaram alguns
`access_levels.name` com nomes de sala (ex.: `nft_arbam` → “SALA DAS ASICS”)
— não confundir no código/UI.

**Decisão:**
- Player UI **nunca** mostra ids de upgrade/caixa/pacote/moeda (só nome/rótulo)
- Catálogo removido → `orphanCatalogUpgrade` / `status: legacy` (id interno
  mantido só para unequip/save)
- Mensagens de compra de sala falam em **room / plan / season pass**, não
  “your level” / “nível de acesso”
- API de salas: `allowedPlanIds` + `planIds` (não `allowedLevels`/`levelIds`);
  coluna SQL `allowed_levels` mantida por schema legado
- Caixas/pacotes (quando portados): mesma regra — delete de código → legacy,
  não wipe silencioso da conta

## 90. Portal de transparência (jogador)

**Problema:** nav `transparency` apontava para stub “migração pendente”.

**Decisão:** portar o painel público do legado:
- `GET /api/transparency` → `modules/transparency`
- `GET /api/web3-settings` (público, campos de depósito) → `modules/wallet`
- UI `features/transparency/TransparencyPage.tsx` + i18n EN/pt-BR/es
- `GameShell` renderiza a página em `currentView === 'transparency'`

Admin CRUD de transparência fica para o painel admin (ainda não portado).

## 91. Picker de bateria: inventário único (sem armazém vs estoque na UI)

**Problema:** modal de bateria listava «Warehouse» e «New stock» em secções
separadas — jogador vê a mesma Estelar duas vezes; chrome ainda EN fixo.

**Decisão:** na UI do jogador **armazém e estoque são a mesma coisa**.
`listBatteryPickerRows` agrupa por `itemId` e mostra **uma linha** com
`x` = instâncias UUID + qty de stock. Clique prefere UUID por baixo dos
panos (equip); rótulos «Armazém/Estoque» **não** aparecem. i18n em
`mining.inventory.*` / `mining.battery.unlimited`.

## 92. Mini Blog (jogador)

**Problema:** nav `mini_blog` apontava para stub “migração pendente”.

**Decisão:** portar o leitor do legado (avisos já lidos / arquivo pós-popup):
- API já existia: `GET /api/mini-blog` (`modules/announcements`)
- Client: `shared/api/mini-blog.ts` + `features/mini-blog/MiniBlogPage.tsx`
- Guards de link/imagem: `shared/utils/safe-https-link.ts`
- i18n EN/pt-BR/es (`miniBlog.*`); `GameShell` em `currentView === 'mini_blog'`

Coluna direita (variant `sidebar`): ver **#102**. Popup de anúncios no login
fica para levadas seguintes.

## 93. Sessão sobrevive a rebuild / reload

**Problema:** cada rebuild/HMR “expulsava” o jogador pro login.

**Causa:**
1. `GET /api/session` **não estava registado** no `current/` (404) — allowlist
   no account-manager existia, a rota não
2. `App.tsx` **nunca** restaurava sessão no boot (`user` só em memória React)

**Decisão:**
- Portar `GET /api/session` em `session.controller.ts` (JWT + `sid`, flags
  manager/impersonate)
- `App` chama `getSession()` no mount; ecrã “Loading…” até resolver
- `shared/api/http.ts`: `apiFetch` com refresh-on-401 + hint
  `genesis_has_session`; falha de rede **não** limpa a hint (rebuild do server)

## 94. Anti-fachada: rotas fantasma + USDC + auth/mailer

**Problema:** client chamava rotas inexistentes; navbar mentia `$0.00`;
`requireActiveUser` copiado; mailer em dev caía em SMTP de produção.

**Decisão (leva crítica):**
1. Portar `GET /api/my-rig-rooms/:email`, `POST /api/server-room/room-coins`,
   `POST /api/game/save-servers` (slice power+moeda; place/equip continuam nas
   rotas de intenção)
2. `requireActiveUser` único em `shared/auth/require-active-user.ts` (profile
   re-exporta; rooms/servers-state usam o partilhado)
3. Navbar USDC: `MiningPage.onUsdcChange` → `GameShell` → `GameTopNav` (sem
   valor falso; `—` até carregar)
4. `apiFetch` único (`shared/api/http.ts`) em auth/servers/transparency/mini-blog
5. Mailer: fora de produção **não** usa Hostinger/genesisdao.tech por default
6. `normalizePublicAssetUrl` canónico em `shared/utils/public-url.ts`

Ainda aberto (próximas levadas): i18n ServerRoom completo, API EN residual,
gods/kebab-case, testes client, stubs Hub.

## 95. Missões / Quests (jogador)

**Problema:** nav `quests` apontava para stub “migração pendente”.

**Decisão:** portar o ecrã do legado:
- API já existia: `GET /api/quests/state`, `POST /api/quests/claim` (+ ranking/me)
- Client: `shared/api/quests.ts` + `features/quests/` (`QuestsPage`, `components/`, `lib/`, `index.ts`)
- Layout/CSS alinhado ao legado (flat, sem HubPanel); grid 3 colunas no desktop
- i18n EN/pt-BR/es (`quests.*`); claim atualiza USDC no chrome via `onUsdcChange`
- `GameViewOutlet` em `quests`; botão leaderboard → view `ranking` (ainda stub)

Admin CRUD de quests permanece nas rotas admin (painel ainda não portado).

## 96. Suporte / Support (jogador)

**Problema:** nav `support` apontava para stub “migração pendente”.

**Decisão:** portar o ecrã do legado:
- API jogador já existia (state, create, reply, archive, reopen, download)
- Completar lacuna: `GET /api/support/tickets/:ticketId` + rewrite de anexos
  (`rewriteSupportAttachmentsForPlayerDownload`)
- Client: `shared/api/support.ts`, `supportAttachmentUrls.ts`,
  `features/support/` (`SupportPage` + list/detail/form/attachments + `lib/`)
- i18n EN/pt-BR/es (`support.*`); `HubPageFrame` + `HubPanel` sky
- `requireActiveUser` partilhado no controller de jogador

Admin de tickets já tinha rotas; painel admin UI ainda não portado.

## 97. Check-in diário (jogador)

**Problema:** mineração no `current` não tinha o banner de check-in (congelamento / streak / recompensa).

**Decisão:** portar o banner do legado sobre a view `servers` (não é `GameView` próprio):
- API já existia: `GET /api/checkin/status`, `POST /api/checkin` (+ quest bump)
- Client: `shared/api/checkin.ts` + `features/checkin/` (`DailyCheckinBanner` + `lib/`)
- i18n EN/pt-BR/es (`checkin.*`); `MiningPage` mostra o banner sticky após save loaded;
  recompensa item/bateria dispara `reloadNonce` do inventário/salas
- Admin policies já no server; painel admin UI ainda não portado

## 98. Estrutura escalável do client portado (Hub)

**Problema:** páginas Hub (quests, support, transparency, mini-blog) + check-in
cresciam monolíticas com helpers/locale/erro duplicados e `GameShell` com ternários longos.

**Decisão:**
- `GameViewOutlet` — mapa `GameView` → página (shell só orquestra chrome); imports via `features/*/index.ts`
- Feature layout: `<Name>Page` + `components/` + `lib/` + `index.ts`
- APIs HTTP em `shared/api/*` (não dentro da feature)
- Utilitários partilhados:
  - `shared/api/client-errors.ts` — códigos → i18n (`CLAIM_FAILED` → `.claimError`)
  - `shared/utils/locale-format.ts` — `dateLocaleFor`, `formatUsdcAmount`, `formatInstantMs`
  - `shared/utils/safe-https-link.ts` — `href` seguros
  - `shared/ui/HubPageFrame.tsx` / `HubPanel.tsx` — padding / chrome (support; mini-blog frame)
- Documentação viva: `docs/development/frontend/GAME_SHELL.md`

## 99. Parceria streamer / Partners (jogador)

**Problema:** nav `partners` apontava para stub “migração pendente”.

**Decisão:** portar o ecrã do legado:
- API já existia: `GET /api/partners/state`, apply, avatar-upload, submit, my-profile
- Client: `shared/api/partners.ts` + `features/partners/` (`PartnersPage`,
  `YoutubePartnerStudio`, cards, `lib/`)
- i18n EN/pt-BR/es (`partners.*`); layout alinhado ao legado (vitrine + studio)
- `GameViewOutlet` em `partners`; self-padded (`max-w-7xl`)

Admin de vídeos/parceiros permanece nas rotas admin (painel UI ainda não portado).

## 100. Offerwall / ZERads (jogador)

**Problema:** nav `offerwall` apontava para stub “migração pendente”.

**Decisão:** portar o ecrã do legado:
- API já existia: `GET /api/zerads/me/token`, `GET /api/zerads/me/stats` (+ callback PTC)
- Client: `shared/api/zerads.ts` + `features/offerwall/` (`OfferwallPage`, `ZeradsCard`)
- Catálogo de providers (ZERads live; AdGate/CPALead “soon”)
- i18n EN/pt-BR/es (`offerwall.*`); layout alinhado ao legado
- `GameViewOutlet` em `offerwall`

## 101. Arcade + Roleta (jogador)

**Problema:** nav `arcade` / `roleta` apontavam para stub “migração pendente”.

**Decisão:**
- **Arcade:** placeholder alinhado ao legado (`features/arcade`) até existirem jogos
- **Roleta:** port do legado — `RoletaPage` + `GameView` + `Wheel`;
  API client `shared/api/wheel.ts` (`/api/wheel/*`, `/api/roleta/*` já no server)
- **Prémios (código):** `getWheelState().prizes` — **não** usar `/api/wheel/config`
  (rota só no legado; em `current` só existe `/api/admin/wheel/config`)
- i18n `arcade.*` (EN/pt-BR/es); UI da roleta ainda com copy PT do legado (dívida)
- `GameViewOutlet`: `arcade` / `roleta`; seed USDC via `onUsdcChange` a partir de
  `getWheelState` (não depender da MiningPage)
- CTA «Caixas da Sorte» → `lucky_store` (ainda stub); `upgrades` / bootstrap caixa
  ficam para quando o inventário/lucky store existirem

## 102. Mini Blog rail na mineração (e outras views)

**Problema:** DECISIONS #92 portou só a página Hub; a coluna direita do legado
(`MiniBlog variant="sidebar"` ao lado da sala) faltava.

**Decisão:**
- `GameShell`: aside `xl+` com `MiniBlogPage variant="sidebar"`
- Oculto em: `dashboard` / `partners` / `mini_blog` (paridade com legado
  `App.tsx`; `partner_games` **não** esconde o rail)
- **Encolher:** botão no header + faixa estreita; LS
  `minestation.miniBlogExpanded` (`1`/`0`, default expandido)
- Feed ainda depende de entradas “lidas” (popup login #92 ainda por portar) —
  rail/página podem ficar vazios para users novos

## 103. Labels da nav em caixa alta

**Problema:** pedido de UX — itens Hub/Operação/Economia em uppercase.

**Decisão:** `uppercase` CSS nos spans de label em `GameSidebar` e
`GameMobileDrawer` (não alterar strings i18n). Secções já eram uppercase.

## 104. Operação — Perfil, Gestão, Inventário, Merge, Loja, Eventos

**Problema:** nav Operação apontava para stub “migração pendente” em seis views.

**Decisão:** port self-fetch (sem monólito `gameState` no App):

| View | Feature | API client |
|------|---------|------------|
| `inventory` | `features/inventory` | `shared/api/inventory` — `GET /api/inventory/state` |
| `management` | `features/account-manager` | `shared/api/account-manager` |
| `upgrade` | `features/upgrades` | `shared/api/upgrades` |
| `merge` | `features/merge` | `shared/api/merge` |
| `hardware_store` | `features/shop` | `shared/api/shop` |
| `profile` | `features/profile` | `shared/api/profile` |

- USDC: `onUsdcChange` (merge / shop / upgrades / roleta)
- Gestão enter: `onSessionRefresh` → `App.getSession()`
- Perfil: `onUserUpdate` (username / wallet); badges/bundle/news **não** no server
  atual — UI degrada (secções ocultas)
- Perfil oculto se `user.isManagingAccount`
- Copy PT do legado na 1ª leva (dívida i18n); `dompurify` para HTML de packages
- CTA depósito insuficiente → `wallet` stub; passes → `lucky_store` stub

## 105. Estelar / baterias infinitas — verificar no cutover produção (VM)

**Contexto (dev local, inventário jogador):** a mesma **Estelar** (e outras
`powerCapacity === -1`) aparecia **duas vezes**:
1. bloco **UUID** (`storedBatteries` — correcto para infinitas)
2. categoria **ENERGIA** empilhável (`stock` qty, ex. ×7) com label **«-1 Wh»**

Relacionado ao #91 (picker unificado) e à migração UUID
(`battery_uuids_and_purge_charging`): infinitas devem viver como instâncias
UUID; qty residual em `game_states.stock` pode ser legado/órfão.

**Mitigação (UI + server, #105/#106):**
- Client: `InventoryView` filtra empilháveis `powerCapacity === -1`
- Server inventário: mesmas linhas omitidas de `stackableCategories`
- Server equip: `from_stock` rejeitado se `powerCapacity === -1`
- **Não limpa dados na BD** — ver TODO cutover abaixo.

**TODO cutover produção / VM (obrigatório rever):**
1. Amostrar contas reais: `stock[estelar|id canónico]` vs `stored_batteries`
   do mesmo `item_id` — qty órfã? divergência?
2. Confirmar id canónico Estelar (`CANONICAL_1000WH_BATTERY_ID` /
   remap `PURGED_LEGACY_STOCK_REMAP_TO_ESTELAR` em `modules/inventory`)
3. Decidir: script one-shot de limpeza de stock infinito residual **ou**
   manter filtro UI + alerta admin
4. Re-testar inventário + picker de bateria na sala (#91) após restore do dump
5. Não assumir que o filtro UI resolve economia (shop/checkout/equip)

Quando for o deploy: checklist acima + smoke «Depósito de peças» com conta
que tenha Estelar.

## 106. Mitigações cutover — flags, stubs, USDC, Estelar server, session fail-closed

**Problema:** riscos de produção pós-Operação (#104/#105): nav assumia Gestão/Merge
ligados; wallet/lucky/P2P/ranking na allowlist com SPA stub; USDC no topo `—`
até uma página seedar; enter gestor com soft refresh; `from_stock` de infinitas
ainda possível; heurística «insuficiente» ignorava EN.

**Decisão:**
1. `GET /api/session` passa `accountManagerEnabled` + `mergeEnabled` (mesma regra
   do bootstrap legado). Client: Gestão só se `=== true`; Merge off se `=== false`.
2. Views stub (wallet / lucky / P2P / ranking) **permanecem na nav** — stub
   no outlet até port; CTAs wallet/lucky restaurados.
3. `GameShell` seeda USDC via `GET /api/wallet/state` no mount e após troca de
   conta (user id / manager flags).
4. `onSessionRefresh` fail-closed: sem sessão → `location.reload()`; limpa USDC
   e re-seed após enter/leave.
5. Server: `applyRackAuxEquip` rejeita `from_stock` se `powerCapacity === -1`;
   inventário omite infinitas das categorias empilháveis (stock raw intacto na BD).
6. `looksLikeInsufficientUsdcMessage` aceita EN (`insufficient` / `balance`).

**Ainda aberto:** limpeza one-shot de stock órfão (#105 VM); port UI wallet /
lucky / P2P / ranking / admin; bootstrap lite completo.

## 107. Economia — P2P, Caixas, Carteira, Ranking, Calculadora

**Problema:** nav Economia apontava para stub nas cinco views pedidas.

**Decisão:** port self-fetch (padrão #104):

| View | Feature | API client | Notas |
|------|---------|------------|-------|
| `black_market` | `features/black-market` | `shared/api/black-market` | `/api/black-market/*` |
| `lucky_store` | `features/lucky-boxes` | `shared/api/lucky-boxes` | promo → Roleta via `ROLETA_PREFILL_CODE_SS` |
| `wallet` | `features/wallet` | `shared/api/wallet` | liquidate + state; depósito/saque **degradados** (rotas player ainda não no server) |
| `ranking` | `features/ranking` | `shared/api/ranking` | público only |
| `calculator` | `features/calculator` | `shared/api/calculator` | `GET /api/calculator/me` |

- Wire em `GameViewOutlet`; CTAs wallet/lucky já existiam
- Copy PT do legado na 1ª leva (dívida i18n)
- Históricos deposit/withdrawal continuam stub se navegados da carteira

## 109. Históricos depósito / saque (player)

**Problema:** CTAs da carteira iam para stub; tabelas já existiam na BD.

**Decisão:**
- `GET /api/withdrawals/history` + `GET /api/deposits/history` (shapes legado)
- UI: `WithdrawalHistoryPage` / `DepositHistoryPage` importadas do legado
- Wire em `GameViewOutlet`; depósito/saque **mutações** on-chain ainda fora

## 110. Strip do GameTopNav — Tokens / USDC / Hash / Ranking

**Problema:** o chrome já desenhava o strip (legado App.tsx), mas Tokens / Hash /
Ranking ficavam em `—` (placeholders). USDC só vinha de seed leve da carteira.

**Decisão:**
- `GET /api/player-game/header` — mesma fonte do snapshot legado
  (`computePlayerGameHeaderSnapshot`) + catálogo `mining_coins` activos.
  Client: **fetch sob pedido** (mount / refresh de sessão) — **sem** `setInterval`.
- `GET /api/ranking/me` — uma vez no mount; refresh só se o hash local mudar
  (debounce 1,2s), sem poll periódico.
- UI Tokens: expand/collapse + H/s por moeda (layout legado).
- Formatters `formatTokenAmount` / `formatHashTotal` em `locale-format.ts`.

**Fora de escopo:** WebSocket `/ws/player-game` e qualquer poll periódico do strip.

## 111. Admin — Dashboard (1ª aba do AdminPanel)

**Problema:** conta admin abria stub; precisava do Dashboard legado (KPIs, últimos
registos, top miners/depósitos/saques).

**Decisão:**
- Server: `modules/admin/dashboard` — `GET /api/admin/dashboard-stats` (SQL legado +
  cache 10s), `POST /api/admin/ranking-exclusion`, `GET /api/admin/users/map` (mapa leve).
- Client: `features/admin` — `AdminShell` (header + footer) + `AdminPanel` (sidebar
  legado; outras abas stub) + `AdminDashboard` (layout legado; **fetch sob pedido**,
  sem poll).
- Conta admin continua a abrir `/admin/dashboard` directo (#110 sessão).

**Ainda aberto:** depósitos on-chain (Etherscan treasury); restantes abas do
AdminPanel.

**Fora de escopo:** WebSocket `/ws/admin-dashboard` e poll periódico do dashboard.

## 112. Hardening — dashboard SQL, header poll/cache, testes

**Problema:** (1) `topWithdrawalsByCoin` fazia N queries (uma por moeda);
(2) poll do strip / admin dashboard martelava o server à escala;
(3) rotas novas (#109–#111) sem testes de controller.

**Decisão:**
1. Uma query `ROW_NUMBER() … PARTITION BY coin_id` + agrupamento em JS.
2. **Sem** poll periódico no client: header e ranking = mount (+ evento);
   admin dashboard = mount + botão «Atualizar» + pós-exclusão.
3. Cache server curto (~2,5s) no header só para leituras repetidas no mesmo
   segundo — não substitui push.
4. Testes: admin dashboard (3 rotas) + `dashboard-stats` window +
   `player-game/header` (incl. cache) + `withdrawals/deposits/history`.
5. Doc: `docs/development/frontend/ADMIN_SHELL.md`.
6. `POST /api/admin/ranking-exclusion` grava `admin_ranking_exclusion` no feed
   Mongo do jogador-alvo — **só** no clique admin.

**Fora de escopo (explícito):** `/ws/player-game`, `/ws/admin-dashboard`, e
qualquer `setInterval` a pedir métricas em loop.

## 108. Caixas da Sorte — crédito inventário + fallbacks pós-compra

**Problema:** após comprar/abrir, jogador às vezes não via caixas em «Meu inventário»
nem itens no Inventário (baterias infinitas iam para `stock` e a UI filtrava #105;
refresh `/state` falhava e o client apagava o state).

**Decisão:**
1. `creditCatalogItemQtyInTx` — baterias `powerCapacity === -1` → `stored_batteries`
   UUID; resto → `stock`. Usado em abertura de caixa + grants de pacotes/pass.
2. `POST /purchase` devolve `inventory` fresco (+ `boxId`).
3. Client: parse `/state` mais tolerante; refresh com retry + fallback
   `GET /inventory`; merge otimista pós-compra; não limpar state antigo se refresh falhar;
   aviso explícito se caixa não aparecer; modal de prémios aponta para Inventário.

## 113. Admin — Usuários (2ª aba do AdminPanel)

**Problema:** a aba Usuários do AdminPanel era só stub (“Migration pending”).

**Decisão:**
1. `GET /api/users` paginado (search / sort / status / nível / sala / só admins) —
   SQL do legado; params com cap (limit 200, search 120).
2. `PUT /api/users/block` `{ email, blocked }`.
3. Client: lista + sub-aba Admins + bloqueio (row e em massa). Sem poll / WS.
4. Fora desta fatia: editor completo, impersonate, permissões, presente/apagar,
   níveis, upgrades, indicação, ranking, dormentes, UI de emails suspeitos.

**Fora de escopo:** WebSocket e timers a recarregar a lista.

## 114. Admin — restantes abas (template legado 1:1)

**Problema:** só dashboard + users estavam ligados; o resto era stub.

**Decisão:**
1. Copiar o JSX das abas do legado (`AdminEditor`, lojas, caixas, web3, settings,
   reports, games, security, support, partners, email, backup, transparency,
   news, merge, passes, guide, roadmap, etc.). **Chrome/classNames iguais.**
2. Wiring via `shared/api/admin-legacy.ts` (cliente HTTP do legado). APIs em
   falta falham fechado (alerta legado), sem inventar UI.
3. **Não** portar o poll de 5s das news nem WS. Users **não** espera `userMap`
   vazio para renderizar (lista própria `GET /api/users`).
4. Shell atual (`AdminShell` + sidebar h-full) mantém-se; só o outlet das abas
   deixa de ser stub.

**Ainda aberto:** rotas GET/POST que ainda 404 no server `current`.

**Fora de escopo:** WebSocket; `setInterval` de métricas/news.

## Batteries inventory = stock-only (no warehouse UI)

Player-facing battery inventory is **stock qty only** (including infinite/Estelar).  
`placed_racks.battery_id` keeps a UUID while mounted; unequip/bulk unload increments stock and does **not** re-list loose `stored_batteries` as warehouse inventory.  
Table `stored_batteries` remains for mounted/save-guard technical use. Legacy loose warehouse rows are folded into stock on inventory snapshot / warehouse-delete.


## 115. Domínio Gerente — pasta `gerente`, sem teto de contas, week em shared

**Problema:** o módulo vivia como `account-manager` (legado e `current/`), com util de semana UTC no domínio e um teto de contas geridas (cap 5) que a UI/API ainda sugeriam.

**Decisão:**
1. Pasta de domínio: `server/modules/gerente` + `client/src/features/gerente` (API em `features/gerente/api`). Export canónico `registerGerenteModuleRoutes` — sem shim permanente `registerAccountManagerModuleRoutes`.
2. Remoção do teto de contas geridas (cap 5): um gerente pode ter N contratos ativos; a UI não inventa fallback de teto.
3. `utcWeekStartMs` / `previousUtcWeekStartMs` em `server/shared/utils/utc-week.ts` (partilhado com quests); testes em `tests/shared/utils/utc-week.test.ts`.
4. HTTP e Prisma inalterados: rotas `/api/account-manager/*`, tabelas `account_manager_*`, kill-switch `ACCOUNT_MANAGER_ENABLED`.

**Fora de escopo:** rename da URL pública; alargar payout cron.

## 116. Offerwall — rename módulo `zerads` → `offerwall` + constants

**Problema:** o domínio de produto chama-se Offerwall, mas o módulo server vivia em `modules/zerads/`; números mágicos espalhados; docs/comentários Prisma falavam idempotência de 5 min enquanto o código usa 60 min; client tinha API duplicada em `admin-legacy` e ExternalLink enganador em cards "soon".

**Decisão:**
1. Pasta server: `server/modules/offerwall/` (HTTP `/zeradsptc.php` + `/api/zerads/*` inalterado).
2. `services/constants.ts` com valores existentes; `MS_PER_MINUTE` de `server/shared/utils/time`.
3. Idempotência documentada como **60 min** (não reverter código para 5).
4. Remover branch morta `zerads_credit` nos activity formatters (sem writers).
5. Client: catálogo em `features/offerwall/lib/providers.ts`; API canónica `shared/api/zerads.ts`; `DEFAULT_ALLOWED_PAGES` + nav `has('offerwall')`.
6. Sem AdGate/CPALead server; sem rename de URL para `/api/offerwall`.

**Fora de escopo:** novos providers server-side; admin panel offerwall.

## 117. Kafka — invalidação do strip navbar (USDC / H/s)

**Problema:** cache curto de `GET /api/player-game/header` e futuras réplicas
precisam de sinal quando mining/economia mudam saldos ou hash; sem reabrir
`/ws/player-game` nem poll (#112).

**Decisão:**
1. `server/core/kafka/` + `kafkajs`, opt-in `KAFKA_ENABLED=1` + `KAFKA_BROKERS`.
2. Tópicos `genesis.mining.progress` / `genesis.economy.ledger`; producer após
   progress mining, liquidate exchange, depósito creditado; invalidate local
   imediato + publish para outras réplicas.
3. Consumer group `genesis-app-header-cache` → `invalidatePlayerGameHeaderCache`.
4. Client: soft-refresh do header no `onUsdcChange` do `GameShell` (sem poll).
5. Compose profile `kafka`; overlay `deploy/k8s/overlays/with-kafka/` — sem
   apply Contabo automático.

**Fora de escopo:** ranking Redis → Kafka; Strimzi HA; cliente Kafka no browser.

## 118. Menu do jogo (sidebar) — domínio Rust + API nav

**Problema:** a allowlist/ordem/filtros do Menu do jogo (Hub / Operação / Economia)
viviam só no client (`buildGameNavItems`); queríamos a mesma fatia pura em Rust
como calculator/auth, com testes em `tests/` e flag opt-in.

**Decisão:**
1. `genesis-core/src/game_nav/` — catálogo + `resolve_allowed_pages` + filtros
   (gerência, merge, AM, roleta, admin operador).
2. NAPI `game_nav_build_json`; Node `GET /api/player-game/nav` em
   `server/modules/game-nav/` com bridge `GENESIS_NAV_RUST=1` e fallback TS.
3. Client hidrata ícones/i18n via `decorateGameNavFromServer`; fallback local
   `buildGameNavItems` se a API falhar.
4. Roleta: `ui_display_labels.nav.roleta_tab_visible` (igual bootstrap/client).
5. Rate-limit alinhado ao header (`MS_PER_MINUTE`, max 120).

**Fora de escopo:** mover Lucide/CSS/i18n para Rust; poll/WS do menu.
## 119. Assets envenenados em cache — selo de build + época de nomes

**Problema:** durante um deploy quebrado o catch-all do SPA devolveu `index.html`
em `/assets/*.css`. Servidos com `immutable` de 1 ano, esses URLs ficaram gravados
na Cloudflare e no disco dos browsers: páginas sem estilo mesmo depois de o
servidor voltar ao normal. Browser com `immutable` não revalida, logo nem purga
do CDN resolve. Em paralelo, estado de build antiga em `localStorage`
(`genesis_has_session`) fazia o client assumir sessão viva e disparar 401 em
cascata pós-deploy.

**Decisão:**
1. `/assets/*` inexistente → 404 `text/plain`; nunca `index.html` (corta a origem).
2. `client/asset-epoch.ts` — `ASSET_EPOCH` no nome do ficheiro
   (`index-<hash>.e1.css`). Bumpar abandona URLs já envenenados; extensão fica no
   fim para o content-type continuar correto.
3. `server/bootstrap/spa-build-stamp.ts` — `<meta name="genesis-build">` derivado
   do próprio `index.html` (já embute os hashes). `index.html` deixa de sair por
   `express.static` (`index: false`) e passa por handler com `no-store`.
4. `client/src/shared/runtime/build-reset.ts` — no boot, selo diferente do
   guardado limpa `localStorage` volátil + `sessionStorage`. Preferência de
   idioma preservada.
5. Selo vem do bundle e não do instante do deploy: restart do contentor não
   deslogar ninguém.

**Fora de escopo:** purga automática da Cloudflare (falta `CLOUDFLARE_API_TOKEN`
na VM — `scripts/deploy/purge-cloudflare-cache.sh` avisa e sai).

## 120. Wallet desk helpers → Rust (`GENESIS_WALLET_RUST`)

Desk percent (10/50/100) + fraction gates (`desk_shortcuts` / `legacy`) vivem em `genesis-core::wallet` via `wallet-rust-bridge`. Deposits / on-chain RPC continuam Node.

## 121. Gerente — accrual no mining worker + payout cron catch-up

**Problema:** em produção `ACCOUNT_MANAGER_ENABLED=1` mas (1) o worker Rust
só logava `gerente accrual skipped (not ported)` — accrual só no path TS
`progress-computer`; (2) o cron semanal de payout nunca migrou para
`startBackgroundSchedulers`. O job legado pagava só a semana anterior ~Monday
00:05; ticks falhados (ex. Aug 10/24/31) deixavam semanas fechadas unpaid para
sempre (último ledger 2026-08-17).

**Decisão:**

1. Portar accrual no worker (`progress.rs` SAVEPOINT `mining_progress_accrual_sp`,
   mesma SQL que `accrual.ts`); week math em `genesis-core::utc_week`; flag
   `ACCOUNT_MANAGER_ENABLED` com o mesmo parser TS (`1|true|yes|on`).
2. Restaurar payout em Node: `payClosedManagerWeeks` + cron horário
   (`MS_PER_HOUR`) que liquida **todas** as semanas UTC fechadas unpaid
   (catch-up). Manter chave de idempotência de prod
   `am_payout:{contractId}:{coinId}:{weekStart}`.
3. Wire em `startBackgroundSchedulers`; lock Redis `jobGerentePayout`.

**Fora de escopo:** hire/fire/enter/leave/guard/HTTP/UI.

## 122. Lojinha nunca lista `merge_*`; herança admin não propaga sell flags

**Problema:** resultados de merge (ex. "Merged KRYPTO REACTOR", id `merge_*`)
apareciam na Lojinha Miner. Causa: no save admin, campos partilhados root →
merge herdavam `sellInHardwareMarket` / `sellInBlackMarket`; o filtro da loja
só olhava esse flag e não excluía o prefixo `merge_`.

**Decisão:**

1. Constante `MERGE_CATALOG_ID_PREFIX` / `isMergeCatalogId` em
   `server/modules/merge/services/constants.ts`.
2. `loadHardwareShopProducts` e `filterProductsForMinerShop` excluem `merge_*`
   para todos (jogador e admin na vista da loja).
3. `assertMinerShopProductQuantity` rejeita `merge_*` com 422 cedo (sem BD).
4. Herança root→merge (client `upgradeCatalogIds` + server
   `upgrade-infrastructure-shared-fields`) deixa de propagar sell flags.
   INSERT de merge já escrevia `sell_in_hardware_market=0` — intacto.

**Fora de escopo:** limpeza SQL de flags já gravados em prod (ops/parent);
redesign do black-market.

## 123. Chat TTL purge + Partners YouTube approve — I/O Rust (fail-closed)

**Problema:** `purgeExpiredChatMessages` era DELETE em lote no processo Node;
aprovação de vídeo Partners era `updateMany` Prisma. Support submit/reply
(advisory + idempotency + anexos) continua demasiado acoplado a Prisma.

**Decisão:**

1. **Chat TTL SQL** → `genesis-mining-worker` `POST /v1/chat/purge-expired`.
   Node `ttl-cron` mantém Redis lock, unlink de áudio e `chat:ttl_purge`.
   Sem `GENESIS_MINING_WORKER_URL` → erro (fail-closed; cron já é best-effort).
2. **Partners video approve** → `genesis-wallet`
   `POST /v1/partners/youtube/submissions/approve` (UPDATE pending→approved).
   Sem `GENESIS_WALLET_URL` → throw. Admin auth continua no Express.
3. **Support mutations** — não portadas nesta fatia (Prisma + idempotency +
   attachments). Documentado como adiado.

**Fora de escopo:** socket chat, multer áudio, application approve multi-step
(allowlist/NFT room), reject/delete de vídeos.

## 124. Distribuição de mineração por orçamento USD mensal (por moeda)

**Problema:** `mining_coins.block_reward / block_time / network_hashrate` são
knobs indiretos — o USD pago por moeda deriva e desvia conforme o hashrate muda
(medido: GHO_nft ~3,4%/mês vs ~240%/mês pela fórmula ingênua). Admin não consegue
dizer "distribui $X este mês nesta moeda".

**Decisão:** nova coluna `mining_coins.distribution_mode` (`legacy` | `usd_month`)
+ `distribution_usd_month` (Float). No modo `usd_month`:

```
budget_per_sec_coins = distribution_usd_month / SECONDS_PER_MONTH(2_592_000) / max(price_usd, 1)
divisor              = max(real_active_hashrate, DIST_MIN_HASHRATE = 10)
yield_per_hash        = 0 se real_active_hashrate <= MIN_NETWORK_HASHRATE(1)
                      = budget_per_sec_coins / divisor caso contrário
```

- **Taxa perpétua, não pote:** paga ~$X a cada 30 dias corridos até o admin mudar.
  Sem ledger. Mudança vale a partir do próximo boundary.
- **Spike-guard = clamp do divisor** (não cap no yield): mantém a identidade
  `yield * network_hashrate ≈ reward_per_sec` (guarda `block_reward =
  budget_per_sec_coins`, `network_hashrate = divisor`), então
  `assert_tick_history_matches_economy` não muda. Abaixo do piso só sub-distribui.
- Vale para **todas as moedas** (GPU/ASIC/NFT). No modo `usd_month` a distinção
  competitivo vs pool-independente é irrelevante — sempre divide pelo hash ativo
  real (`real_network_by_coin` do tick, já computado para todo tipo de moeda).
- **Único ponto de mudança no pipeline:** `build_yield_history_rows_for_boundary`
  (`rust/genesis-core/src/mining/yield_boundary.rs`, fn `usd_month_yield`). Grade
  de 10 min, `mining_yield_history`, integração e crédito por usuário intactos.
- Preview admin: `POST /api/admin/economy/distribution-preview` (Super) →
  `run_distribution_preview` no worker, usando `app_cache.network_stats` (mesmo
  hashrate que o boundary usa). Editor de moedas em `AdminReports.tsx` ganha
  toggle Legado/USD-mensal + painel de preview ao vivo (debounced).
- Migração: `scripts/ops/distribution-usd-month-seed-20260908{,-preview}.sql` —
  semeia `distribution_usd_month` com a emissão real de 30d de
  `mining_block_history.amount_usd`. Reversível: `distribution_mode='legacy'`
  (knobs legados nunca são tocados).

**Fora de escopo:** ledger de "saldo restante"; remover `target_daily_usd` (fica
morto no DB, some só da UI); consolidar `AdminEconomy.tsx` no editor principal.
**Caveat:** não re-rodar `scripts/ops/fix-gho-nft-network-floor-20260831.sql`
contra moedas em `usd_month`.
