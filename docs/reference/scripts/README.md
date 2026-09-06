# Scripts (legado)

## Raiz
- `deploy_vps.py` — deploy para VPS (Python, a documentar em detalhe).

## `app_production/`
- `init-ssl.sh` — emissão inicial de certificado SSL (Certbot).
- `init-ssl-dev-genesisdao.sh` — variante para o subdomínio dev.
- `stack-up.sh` — sobe o stack de produção.
- `migrate-db.sh` — roda `prisma migrate deploy` em produção.

## `backend/scripts/`
- `migrateImgToWebp.mjs` — converte imagens existentes para WebP em lote.

## Pendente
- [ ] Documentar parâmetros/uso de cada script (`--help` ou leitura do source).
