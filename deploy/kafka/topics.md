# Contrato de tópicos Kafka (Genesis)

Nomes estáveis. Partições/replication ajustáveis por ambiente.

| Tópico | Partições (lab) | Retention (lab) | Produtor previsto | Consumidor previsto |
|--------|-----------------|-----------------|-------------------|---------------------|
| `genesis.auth.events` | 3 | 7d | auth (login/signup/reset) | audit / risk |
| `genesis.mining.progress` | 6 | 3d | mining-engine | ranking / analytics |
| `genesis.economy.ledger` | 6 | 30d | wallet / economy | reconciler / ops |
| `genesis.ops.deadletter` | 1 | 14d | qualquer consumer | ops replay |
| `genesis.ranking.snapshot` | 3 | 3d | genesis-mining-worker | Node invalidate / analytics |
| `genesis.partner_games.session` | 3 | 3d | partner-games (visit/heartbeat/stop) | analytics / quests (futuro) |
| `genesis.market.events` | 3 | 3d | black-market (reserve/buy/sell) | analytics |
| `genesis.lucky_box.open` | 3 | 3d | lucky-boxes (open) | analytics |

Prefixo `genesis.` evita colisão com outros stacks no mesmo cluster.

Lab defaults (KRaft 1 broker): `replication.factor=1`.  
HA (futuro Strimzi ≥3 brokers): `replication.factor=3`, `min.insync.replicas=2`.
