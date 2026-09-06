# Storage — contrato de filesystem (`current/`)

URL pública `/img/...` ≠ pasta na raiz. Não existe `img/` no repo.

## Layout

```
storage/                         ~454 MiB  (sem duplicar)
├── media-seed/                  catálogo / seed          IMG_DIR
│   ├── miner/ rack/ fan/ chip/ battery/ charger/ coin/
│   ├── partner/ favicon/ landing/
│   ├── support/                 pasta canónica VAZIA (classificador)
│   ├── aliases PT/plural → pasta EN
│   └── uploads → ../uploads     URLs /img/uploads/…
├── uploads/                     runtime mutável          IMG_UPLOADS_DIR
│   ├── ad-*.webp                ads (URL /img/uploads/<file> ou /img/ad-…)
│   ├── support-* / support-reply-* / *.mp4 de tickets
│   ├── chat-audio/              URL /img/chat-audio/
│   ├── partner-avatars/         URL /img/partner-avatars/
│   └── support/                 vazio (multer grava na raiz)
└── backups/                     só .gitkeep
```

Não há `tmp/`: nenhum writer no código.

O nome `media-seed` mantém-se (é o default de `IMG_DIR` + compose da VM de teste).
Conceito = **catalog**. Não renomear só por estética.

## Responsabilidades

1. **media-seed = catalog** — assets de jogo/chrome, tratados como imutáveis no deploy. Read-only entre réplicas. Pode ir para object storage ou imagem Docker.
2. **uploads = runtime** — ads, chat, avatars, anexos de suporte. Mutável. PVC partilhado ou S3.
3. **backups** — `BACKUP_DIR` (Docker: `/app/storage/backups`) = `storage/backups`. Default de código: `cwd/storage/backups`. Não usar `/backups` nem `../backups`.
4. **tmp** — não criar até haver writer.
5. **`/img/`** — rota HTTP (Express + proxy Vite). Não é o nome do diretório físico.

## Quem lê / escreve

| Path | Lê | Escreve | URL |
|------|----|---------|-----|
| `IMG_DIR` | `mountImageStaticMiddleware`; dashboard `partner/blockminer.webp`; lookup flat | admin `assetFolder`; `organizeLooseFilesInImgRoot` se chamado | `/img/<pasta>/…` |
| `IMG_UPLOADS_DIR` | mesmo middleware; lookup flat | ads, upload admin sem folder, chat, avatars, support (raiz) | `/img/<file>`, `/img/uploads/`, `/img/chat-audio/`, `/img/partner-avatars/` |
| `storage/backups` | `getBackupDir()` (admin list/download) | `POST /api/admin/backup`; scheduler `createScheduledSqlBackupOnce` | só `/api/admin/backups*` (auth admin) |

ENV: `IMG_DIR` (default `storage/media-seed`), `IMG_UPLOADS_DIR` (default `storage/uploads`), `BACKUP_DIR` (Docker `/app/storage/backups`; default local `storage/backups`). Vite não lê disco.

## Prova suporte (2026-08-19)

Postgres local: **586** URLs em tickets/replies, **todas** `/img/support-*` ou `/img/support-reply-*`. Zero `/img/support/<file>`.

Código gera `url: '/img/' + filename` (`attachments.ts`). Disco: 582 ficheiros `support-*` estavam em `media-seed/support/` (classificação heurística). Movidos para `uploads/` (onde o multer já grava). Pasta `media-seed/support/` ficou vazia de propósito.

Efeito colateral: 4 `.mp4` com URL flat passam a ser encontrados por `express.static(uploadsDir)` (`.mp4` não entra no lookup flat de imagens).

`reclassifyFilesInDirectory` **não tem caller** em startup/runtime (só export). No-op se `sourceDir` for o uploads runtime **ou** estiver fora da árvore do catálogo — não volta a puxar `support-*` para `media-seed/support` por nome. Reclassificar *dentro* de `media-seed/miner/` etc. continua igual.

## Symlinks — não remover

| Origem | Destino | Motivo |
|--------|---------|--------|
| `media-seed/uploads` | `../uploads` | ads/anúncios usam `/img/uploads/<file>`; `static(uploadsDir)` procura `uploads/uploads/` |
| `baterias`/`batteries` → `battery` | URLs PT/plural | `IMG_LEGACY_FOLDER_ALIASES` |
| `carregadores`/`chargers` → `charger` | idem | idem |
| `moedas`/`coins` → `coin` | idem | idem |
| `parceiros`/`partners` → `partner` | idem | idem |

## Kubernetes (scaffold no repo — **sem deploy**)

Manifests: [`deploy/k8s/`](../../deploy/k8s/). Kafka: [`deploy/kafka/`](../../deploy/kafka/).
Runbook: [`KUBERNETES.md`](KUBERNETES.md), [`KAFKA.md`](KAFKA.md).

Proposta de montagem (nomes lógicos; físicos = `media-seed` / `uploads` / `backups`):

| Montagem | Disco actual | Modo | Object storage? |
|----------|--------------|------|-----------------|
| `/app/storage/media-seed` | `media-seed` | read-only, partilhável | sim (catálogo) |
| `/app/storage/uploads` | `uploads` | ReadWriteMany / S3 | sim (melhor que PVC local) |
| `/app/storage/backups` | `backups` + `BACKUP_DIR` apontando para aqui | volume separado | opcional |

Réplicas `app` **sem** volume em `uploads` = anexo noutra pod. Chat-audio: um só processo a fazer GC (scheduler).

Compose de teste monta os três dirs; `IMG_DIR` / `IMG_UPLOADS_DIR` / `BACKUP_DIR=/app/storage/backups` em `app`.
PVC `genesis-uploads` / `genesis-backups` no kustomize espelham o mesmo contrato.
**Não** correr `kubectl apply` até cutover explícito.

## BACKUP_DIR

| | |
|---|---|
| Quem lê/escreve | `getBackupDir()` / `ensureBackupDir()` em `backup-files.ts` |
| Callers | cron `startScheduledSqlBackups` (processo `app`); `GET/POST/DELETE /api/admin/backup*` |
| Default **sem** ENV | `cwd/storage/backups` (`/app/storage/backups` no Docker) |
| Docker | `ENV BACKUP_DIR=/app/storage/backups` (Dockerfile + compose `app` e `app_scheduler`) |
| Volume | o mesmo `../storage/backups:/app/storage/backups` (não há segundo volume) |

Dumps antigos que tenham ido para `/backups` (camada do contentor, pré-alinhamento) **não** são copiados automaticamente. Copiar à mão se existirem, depois de confirmar o volume.

## O que não fazer

- Renomear `media-seed` → `catalog/` (parte ENV + VM de teste).
- Criar `tmp/` sem writer.
- Recriar `img/` na raiz.
- Apagar aliases ou `media-seed/uploads`.
- Correr `reclassifyFilesInDirectory` sobre um dump **já copiado para dentro** de `media-seed/` (aí ainda classifica por nome). Uploads runtime e qualquer pasta irmã ficam protegidos.
- Apagar dumps em `/backups` (contentor) sem copiar primeiro se ainda forem precisos.
