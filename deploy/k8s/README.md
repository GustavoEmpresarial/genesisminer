# Kubernetes — MineStation / Genesis (scaffold)

Manifests **declarativos** para migrar a app `current/` de Docker Compose (VM Contabo)
para Kubernetes. **Não aplicar em produção/teste sem runbook explícito.**

```bash
# NÃO executar agora — só referência:
# kubectl apply -k deploy/k8s/
# kubectl apply -k deploy/kafka/k8s/
```

## Layout

| Ficheiro | Função |
|----------|--------|
| `namespace.yaml` | Namespace `genesis` |
| `configmap-app.yaml` | Env não-secreta (PORT, paths, flags) |
| `secret-app.example.yaml` | Template de secrets (copiar → `secret-app.yaml` **gitignored**) |
| `deployment-app.yaml` | Deployment Node (`dist/bootstrap/server.js`) |
| `service-app.yaml` | ClusterIP `:3000` (nginx/Ingress → aqui) |
| `pvc-uploads.yaml` / `pvc-backups.yaml` | Volumes mutáveis (ver STORAGE.md) |
| `ingress.example.yaml` | Ingress TLS exemplo (desligado por default) |
| `kustomization.yaml` | Bundle `kubectl apply -k` |

Postgres e Redis **não** estão neste kustomize: na VM actual vivem em
`app_production` (`postgres_app` / `redis_app`). Em K8s, apontar
`DATABASE_URL` / `REDIS_URL` para Services externos ou Operators à parte.

Kafka: ver [`../kafka/`](../kafka/).

## Pré-requisitos (quando for a hora)

1. Cluster acessível (`kubectl cluster-info`).
2. StorageClass com ReadWriteMany **ou** S3 para `uploads` (réplicas > 1).
3. Secrets reais a partir de `secret-app.example.yaml` (nunca commitados).
4. Imagem app no registry (hoje o compose faz `build:` local).

## Relação com o compose actual

| Compose (`deploy/docker-compose.yml`) | K8s |
|---------------------------------------|-----|
| `container_name: app` | Deployment `genesis-app` |
| rede `app_production_default` | Service DNS `genesis-app.genesis.svc` |
| volumes `storage/*` | PVC + `IMG_*` / `BACKUP_DIR` |
| health `/health/ready` | `readinessProbe` / `livenessProbe` |

Kafka: ver [`../kafka/`](../kafka/) e overlay [`overlays/with-kafka/`](overlays/with-kafka/).

## Status

- Scaffold versionado no repo.
- Cliente Node + invalidação header: ver `docs/operations/KAFKA.md` / DECISIONS #117.
- **Deploy Contabo: não** — sem `kubectl apply` automático.
