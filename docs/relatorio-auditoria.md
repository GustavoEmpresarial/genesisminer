# Relatório de Qualidade: MineStation / aba /upgrade e saneamento

## 1. Resumo executivo

- Veredito: 🟡 pronto com ressalvas
- A aba `/upgrade` foi redesenhada (foto pequena, descrição por baixo, o mesmo chrome do ranking) e o trabalho que estava por commitar entrou em commits por tema na branch `chore/saneamento-auditoria`.
- Código morto não foi apagado: a lista está abaixo e espera aprovação.
- Carga (k6) e Kali não correram. Esta máquina não é a VM de staging e produção não foi alvo.
- Deploy em produção não foi feito. Falta acesso de staging a partir daqui e a tua confirmação.

## 2. Estado verificado

| Verificação | Comando | Resultado |
|---|---|---|
| Lint (ficheiros da UI) | `eslint` nos paths de upgrades/i18n `--max-warnings=0` | ✅ |
| Typecheck client | `npm --prefix client run typecheck` | ✅ |
| Testes | `vitest` feature-catalogs + upgrades-preview + upgrades state | ✅ 31 a passar, 0 a falhar |
| Build | não corrido | não verificado nesta entrega |
| npm audit (raiz) | `npm audit --json` | ❌ 2 críticas, 8 altas, 7 moderadas |
| npm audit (client) | `npm --prefix client audit --json` | ❌ 1 alta, 1 moderada, 1 baixa |
| k6 / Kali | não executados | sem alvo local; produção excluída |
| Browser da aba /upgrade | sem ferramenta de browser nesta sessão | não verificado visualmente |

## 3. Achados (ordenados por severidade)

### [ALTO] SEC-001: preço do passe em `double precision`
- Categoria: lógica financeira / precisão (Anexo E.3)
- Evidência: `rust/genesis-hardware/src/upgrades/purchase.rs:74` lê `price_usdc::double precision`. O débito usa esse float (`SELECT_USDC_SQL` / `SET_USDC_SQL` nas linhas 99–101).
- Reprodução: inferido do SQL. O client não envia preço (`client/src/shared/api/upgrades.ts:125-129` manda só `packageId`, `idempotencyKey`, `clientPackageVersion`). O servidor é que cobra o valor da linha `admin_upgrades`.
- Impacto: arredondamento de USDC em compras concorrentes ou valores fracionários pode divergir do cêntimo. Não foi explorado com teste de concorrência nesta entrega.
- Correção: decimal/inteiro na menor unidade, com teste de concorrência. Não aplicada: muda dinheiro em produção e precisa de decisão.
- Status: ❓ precisa de decisão

### [ALTO] SEC-002: dependências com advisory alto/crítico
- Categoria: supply chain
- Evidência: `npm audit` na raiz — críticas `vitest` (UI server lê/executa ficheiro arbitrário) e `@vitest/coverage-v8`; altas incluem `vite`, `multer`, `prisma`, `sharp`, `engine.io`. No client, `vite` alta (path traversal em deps otimizadas `.map`).
- Reprodução: `npm audit` e `npm --prefix client audit` a 2026-10-01, exit code 1.
- Impacto: `vitest` é de desenvolvimento. `vite` afeta o build do client. Não foi confirmado se o servidor de UI do Vitest ou o modo dev do Vite estão expostos em produção.
- Correção: atualizar com lockfile revisto, sem `npm audit fix --force` cego.
- Status: ⏳ proposto

### [MÉDIO] SEC-003: script local de bypass do Turnstile ficou de fora do git
- Categoria: autenticação / bypass de captcha
- Evidência: `scripts/ops/ml-embed-turnstile-bypass.py` continua untracked. Não foi commitado. O script descreve um header de bypass para o embed `/ml/`.
- Reprodução: o ficheiro está no disco de trabalho; não está no commit `f69ff86` nem nos seguintes.
- Impacto: se for aplicado na VM, o captcha do embed deixa de ser uma barreira. Não foi executado.
- Correção: não versionar e não correr. Rotacionar o segredo do header se alguma vez foi instalado na VM.
- Status: ⏳ proposto

### [BAIXO] SEC-004: compra de passe exige sessão e ignora preço do body
- Categoria: autorização
- Evidência: `rust/genesis-api/src/player.rs:3276` chama `require_player` e substitui o user id (`merge_user_id`) antes de `forward_hardware` para `/v1/upgrades/purchase` (linha 3280). Rotas do client `GET /api/upgrades/state` e `POST /api/upgrades/purchase` existem em `player.rs:372` e `player.rs:496`.
- Reprodução: leitura estática. Não houve pedido HTTP contra staging nem produção.
- Impacto: um jogador autenticado não escolhe o preço no payload. `GET /api/upgrades/purchases` existe no servidor e o client atual não o chama; isso não é chamada órfã.
- Correção: nenhuma nesta entrega.
- Status: ✅ verificado por leitura, sem teste de IDOR novo

## 4. Fases pedidas

### Fase 1 — código morto
`knip`, `ts-prune` e `depcheck` não estão no repositório. Não foram instalados (instalação nova precisa de aprovação). Nada foi apagado.

Lista à espera de aprovação (motivo):

| Item | Motivo |
|---|---|
| `.cursor/ml-login-verify.png`, `.cursor/ml-login-verify2.png` | capturas de debug, não são código da app |
| `scripts/ops/_debug_ml_*.py` | probes de reprodução do embed, não são o produto |
| `scripts/ops/ml-embed-turnstile-bypass.py` | bypass de captcha; não deve entrar no git |
| `scripts/nft-pool-v3/out/*.txt` | saída de um levantamento já corrido, não é o script |

### Fase 2 — duplicação
`jscpd` não está instalado e não foi adicionado. Não houve consolidação, logo o comportamento não mudou. Duplicação já conhecida, não fundida: `server/modules/upgrades/services/purchase.ts` e `rust/genesis-hardware/src/upgrades/purchase.rs` (o Rust diz que espelha o Node). Fundir agora arrisca a compra em produção.

### Fase 3 — client e servidor (passes)
Chamadas do client de upgrades têm rota:

- `GET /api/upgrades/state` → `player.rs` `upgrades_state`
- `POST /api/upgrades/purchase` → `player.rs` `upgrades_purchase`

O body não leva preço. Não foi gerado OpenAPI do monólito inteiro.

### Fase 4 — documentação
Rollback desta branch acrescentado em `docs/deployment/README.md`. Não há Swagger novo.

### Fase 5 — testes
Corridos os testes do catálogo i18n, do preview de upgrades e do state. Não há meta de 100% no projeto. Não há teste de browser nem de concorrência da compra.

### Fase 6 — carga
`k6` está em `~/.local/bin/k6`. Não foi lançado: não há servidor local desta app nesta máquina (`hostname` `gustavo-LOQ-15IAX9E`, sem `/root/genesis-current`) e o alvo de produção está proibido. Sem tabela p50/p95/p99.

### Fase 7 — segurança ativa
Contentor Kali, nmap, nikto, sqlmap, ZAP e ffuf não foram corridos. `npm audit` sim (SEC-002). Nenhum payload foi enviado a `genesisdao.tech`.

### Fase 8 — correções
Nenhuma correção de severidade alta foi aplicada. SEC-001 muda o tipo do dinheiro e SEC-002 mexe em lockfiles de build. As duas ficam para decisão. Não houve re-run de carga nem de DAST.

## 5. Testes adicionados/alterados

| Arquivo | Tipo | O que prova | Visto falhando antes? |
|---|---|---|---|
| `tests/client/i18n/feature-catalogs.test.ts` | unitário | chaves `upgrades.*` iguais em en / pt-BR / es, incluindo `upgrades.title` | não (paridade nova; a suíte ficou verde à primeira) |
| `client/src/shared/i18n/locales/features/upgrades.ts` | catálogo | textos da aba | n/a |

## 6. Observabilidade

Não foi alterada. A compra de passe continua a depender do erro que o hardware devolve (`error` / `missing`). Não há `error_id` no contrato desta rota. Fora do escopo desta entrega.

## 7. Plano priorizado (o que não foi feito)

| Prioridade | Item | Esforço | Por quê |
|---|---|---|---|
| P0 | Deploy só depois de staging | M | esta máquina não chega à VM |
| P0 | Não migrar produção sem aprovação | P | o backfill de check-in premium altera jogadores reais |
| P1 | Preço USDC fora de float | G | SEC-001 |
| P1 | Triagem do `npm audit` | M | SEC-002 |
| P2 | knip/jscpd depois de aprovares a dependência | M | Fase 1 e 2 ficaram sem ferramenta |
| P2 | k6 e ZAP contra staging | M | sem alvo local |

## 8. Decisões pendentes para o humano

1. Apagar os ficheiros da Fase 1 (debug, bypass, dumps `out/`)? Recomendação: apagar só no disco local, não os commit. O bypass não deve ir para o git.
2. Instalar `knip` e `jscpd` para um segundo passe? Recomendação: sim, numa fase só de relatório, ainda sem apagar código.
3. Confirmar deploy de produção de `chore/saneamento-auditoria`? Recomendação: não, até haver smoke em `dev.genesisdao.tech`.
4. Aplicar as duas migrations em produção? Recomendação: rever o backfill de `checkin_premium_unlocked` antes; a de transparência nasce em `all_time` e não muda o score sozinha.

## 9. Limitações desta análise

- Sem browser: o layout novo não foi clicado em desktop nem em mobile.
- Sem VM: não houve deploy, smoke HTTP, k6 nem Kali.
- Sem `knip`/`jscpd`: a lista de código morto é só o que ficou de propósito fora do git, não um varrimento do monólito.
- `npm audit` não distingue o que está realmente exposto em produção.

## Rollback

Ver `docs/deployment/README.md`, secção "Rollback desta branch". Commit de UI: `b864628`. Commit anterior ao saneamento, ainda em `feat/mining-usd-month-distribution`: `14af59c`.
