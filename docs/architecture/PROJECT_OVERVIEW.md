# Project Overview — Genesis Miner / MineStation

## O que é

Jogo web de mineração simulada ("mining rig tycoon"): jogador compra
máquinas/racks, gerencia uma sala de servidores virtual (server room), minera
moedas simuladas, faz upgrade de equipamento, participa de eventos (roleta,
lucky boxes, check-in diário, quests, wheel), tem carteira interna com
depósito/saque, marketplace P2P (black market), sistema de parceiros
(partners/account-manager) e painel admin completo.

Domínios de produto identificados no código (`backend/modules/`):

| Domínio | Pasta | Resumo |
|---|---|---|
| Autenticação | `src/auth`, `login` | JWT + refresh token, cookies, login/registro |
| Perfil | `profile` | identidade, senha, wallet history, referral bind/overview |
| Sala de servidores | `servers` (+ `frontend/controllers/serverRoomController.ts`) | posicionamento de racks, snapshot, aux intents |
| Baterias | `batteries` | inventário/integridade de baterias dos racks |
| Inventário | `inventory` | snapshot e auditoria de itens do jogador |
| Loja | `shop` | catálogo, carrinho, checkout |
| Upgrades | `upgrades` | catálogo e compra de upgrades de rack |
| Mercado negro | `black-market` | listagens P2P, snapshot |
| Carteira | `wallet` | saque, exchange/liquidação, locks |
| Check-in | `checkin` | bônus diário, política premium |
| Quests | `quests` | missões por período |
| Lucky boxes | `lucky-boxes` | caixas de sorte, idempotência |
| Roleta | (models/controllers flat) `roletaModel`, `roletaController` | roleta de prêmios |
| Wheel | `wheel` | roda de prêmios (distinta da roleta) |
| Chat | `chat` | chat com socket.io |
| Suporte | `support` | tickets, anexos |
| Parceiros | `partners` | cadastro/perfil de parceiros, YouTube |
| Account Manager | `account-manager` | acúmulo/payout semanal de comissão |
| Dashboard | `dashboard` | dados agregados da home do jogador |
| Guia | `guide` | conteúdo de ajuda in-app |
| Roadmap | `roadmap` | roadmap público |
| Merge | `merge` | fusão de itens/estatísticas |
| Anúncios | `announcements` | modais/avisos |
| Email | `email-verification` | verificação de e-mail no registo |
| Admin | `modules/admin`, `controllers/admin*` | mineração, segurança, auditoria, backup |

## Stack

- **Backend**: Node.js + Express (TS compilado via `tsc` para `dist/` /
  `server.js`), Prisma (Postgres), MongoDB (driver nativo, só para logs),
  Redis (locks + BullMQ), Socket.IO (chat/tempo-real).
- **Frontend**: React + Vite + Tailwind.
- **Contratos**: nenhum encontrado nesta pasta (diferente do BlockMiner, que
  tem `contracts/` com Hardhat/Solidity) — a confirmar se existe on-chain
  neste projeto ou se é 100% off-chain/custodial.
- **Infra**: Docker Compose (dev e produção separados), Nginx + Certbot em
  produção.

## Fonte de verdade (resumo do `ESTRUTURA.md` legado)

- Código: `backend/` e `frontend/` na raiz do repo — não em
  `app_production/backend|frontend` (removidos por serem duplicata).
- Schema/migrations Postgres: só em `backend/prisma/`.
- Deploy/infra de produção: `app_production/`.

## Pendências de descoberta (marcar ao confirmar)

- [ ] Confirmar se há componente Web3/on-chain real (existe `frontend/components/web3/`,
      `Web3RiskPage.tsx`, `AdminWeb3Menu.tsx`, e RPCs no `.env.example` —
      `BASE_RPC`, `BNB_RPC`, `POLYGON_RPC`, `ETHERSCAN_API_KEY` — sugerindo
      integração com carteiras externas, mas sem pasta `contracts/`).
- [ ] Mapear todas as rotas admin (`controllers/admin*`, `modules/admin/`).
- [ ] Confirmar se `backend/lib/genesisStack` e `backend/lib/stack` são a
      mesma coisa duplicada ou coisas diferentes.
