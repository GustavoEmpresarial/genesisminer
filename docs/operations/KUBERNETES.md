# Kubernetes — runbook (scaffold)

Fonte de manifests: [`deploy/k8s/`](../../deploy/k8s/).

## Estado actual

| Ambiente | Runtime |
|----------|---------|
| Contabo / `dev.genesisdao.tech` | Docker Compose (`deploy/docker-compose.yml`) |
| Produção (até cutover) | Compose legado `app_production` |
| Kubernetes | **Só manifests no git** — cluster ainda não é o target de deploy |

## O que está versionado

- Namespace `genesis`
- Deployment + Service `genesis-app`
- PVC uploads/backups
- ConfigMap (incl. `KAFKA_ENABLED=0`)
- Template de Secret
- Ingress exemplo (fora do kustomize)

## O que **não** fazer agora

- `kubectl apply -k deploy/k8s/`
- Apontar DNS Contabo para um Ingress K8s
- Remover o compose da VM
- Subir Postgres/Redis “dentro” deste kustomize sem Operator/plano

## Ordem futura (quando houver cluster)

1. StorageClass + secrets reais.
2. Imagem no registry (substituir `genesis-app:local`).
3. `kubectl apply -k deploy/k8s/` (sem Ingress).
4. Smoke `/health/ready` via port-forward.
5. Kafka: [`KAFKA.md`](KAFKA.md).
6. Ingress + cutover DNS.

Ver também: [STORAGE.md](STORAGE.md), [deployment/README.md](../deployment/README.md).
