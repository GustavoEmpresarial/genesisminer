# Monitoramento

Nenhum stack de observabilidade (Prometheus/Grafana/Sentry) identificado
ainda no código legado — a confirmar. `backend/utils/securityThreatObserver.ts`
sugere alguma forma de detecção de ameaça/anomalia interna, não
necessariamente ligada a monitoramento de infra.

## Pendente
- [ ] Confirmar se há logging estruturado centralizado (candidato: `mongoLogs.ts`, `logThrottle.ts`).
- [ ] Confirmar se há healthcheck HTTP exposto pela API (além dos healthchecks de container no compose).
- [ ] Definir stack de monitoramento alvo para `current/` (equivalente ao `docs/architecture/services` + `shared/observability` do BlockMiner).
