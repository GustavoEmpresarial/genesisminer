# Kafka — runbook

Fonte: [`deploy/kafka/`](../../deploy/kafka/), cliente Node: `server/core/kafka/`.

## Estado

| Peça | Estado |
|------|--------|
| Compose Hostinger (`deploy/docker-compose.yml`) | Kafka + topics-init + `KAFKA_ENABLED=1` |
| Cliente `kafkajs` | activo com brokers `kafka:9092` |
| Hostinger / `kubectl apply` | **não** — sem cluster K8s nesta VM |

## Lab compose

```bash
cd /root/genesis-current
docker compose -f deploy/docker-compose.yml up -d
```

Brokers na app: `KAFKA_BROKERS=kafka:9092`.

Lab isolado (só broker, localhost): `deploy/kafka/docker-compose.kafka.yml`.

## K8s overlay

```bash
# kubectl apply -k deploy/k8s/overlays/with-kafka/
```

Bootstrap: `genesis-kafka-bootstrap.genesis.svc.cluster.local:9092`.

## Integração app (navbar)

Tópicos: `genesis.mining.progress`, `genesis.economy.ledger` ([topics.md](../../deploy/kafka/topics.md)).

- Progress mining / liquidate / depósito → `notify*` invalida cache local + publish.
- Consumer group `genesis-app-header-cache` → `invalidatePlayerGameHeaderCache` (réplicas).
- Strip UI: HTTP on-demand (#112); soft-refresh após `onUsdcChange` no `GameShell`.

| Variável | Default |
|----------|---------|
| `KAFKA_ENABLED` | `0` |
| `KAFKA_BROKERS` | CSV host:port |
| `KAFKA_CLIENT_ID` | `genesis-app` |
