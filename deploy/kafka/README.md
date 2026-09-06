# Kafka — MineStation / Genesis (scaffold)

Infra de mensageria **declarativa**. A app Node **ainda não** publica/consome
(evento `KAFKA_ENABLED=0` no ConfigMap). Objetivo: ter brokers + tópicos
prontos quando ligarmos o cliente (`kafkajs` / bridge Rust).

```bash
# NÃO executar agora:
# docker compose -f deploy/kafka/docker-compose.kafka.yml up -d
# kubectl apply -k deploy/kafka/k8s/
```

## Layout

| Path | Uso |
|------|-----|
| `docker-compose.kafka.yml` | Kafka KRaft 1 nó — **dev local / lab** (rede bridge) |
| `kafka.env.example` | Portas / IDs (sem secrets) |
| `k8s/` | StatefulSet KRaft + Service bootstrap no ns `genesis` |
| `k8s/topics.yaml` | Job one-shot que cria tópicos canónicos (quando aplicar) |
| `topics.md` | Contrato de nomes de tópicos |

## Tópicos canónicos (futuro)

Ver [`topics.md`](topics.md). Resumo:

- `genesis.auth.events` — login/register/reset (audit/async)
- `genesis.mining.progress` — progresso de mining
- `genesis.economy.ledger` — movimentos económicos
- `genesis.ops.deadletter` — falhas de consumo
- `genesis.ranking.snapshot` — snapshot ranking público (invalidate)
- `genesis.partner_games.session` — visit / heartbeat / stop (BlockMiner hub)
- `genesis.market.events` — P2P reserve / unreserve / buy / sell
- `genesis.lucky_box.open` — lucky-box open

## Relação com Redis / BullMQ

Redis continua locks/cache/Socket.IO. Kafka **não** substitui Redis.
BullMQ legado está fora do `current/` (DECISIONS #40). Kafka é o caminho
para eventos cross-serviço / outbox, não para jobs curtos in-process.

## Quando ligar a app

1. `npm i kafkajs` (ou cliente Rust) — **ainda não**.
2. `KAFKA_ENABLED=1` + `KAFKA_BROKERS=...`.
3. Producer no domínio (ex. auth audit) atrás de feature flag.
4. Consumer separado ou no mesmo processo com care (schedulers).

## Status

- Compose Hostinger: Kafka sobe com `deploy/docker-compose.yml` (`genesisminer-kafka`).
- Manifests K8s: scaffold para cluster futuro — **sem kubectl na Hostinger**.
- App: `KAFKA_ENABLED=1` + `KAFKA_BROKERS=kafka:9092` no compose.
