#!/usr/bin/env bash
#
# Deploy do `current/` na VM de teste, puxando o código do Git e reconstruindo
# a imagem sem cache.
#
# CORRE NA VM (root@161.97.176.125), não na máquina de dev:
#   bash scripts/deploy/deploy.sh
# ou, na primeira vez, a partir de qualquer sítio:
#   curl -fsSL <raw-url>/scripts/deploy/deploy.sh | bash
#
# Substitui o `rsync` do runbook (docs/operations/TEST-VPS-CUTOVER.md) pelo pull
# de Git. O que o Git NÃO traz continua a ter de existir na VM:
#
#   storage/media-seed  (~391 MB)  imagens do catálogo   -> IMG_DIR
#   storage/uploads     (~64 MB)   ficheiros de jogadores -> IMG_UPLOADS_DIR
#   deploy/.env                    segredos (JWT, mail, RPC, POSTGRES_PASSWORD)
#
# Estes estão em .gitignore de propósito (o dump e os uploads têm dados de
# jogadores e o repositório não é sítio para eles). O compose faz bind-mount
# destas pastas: se estiverem vazias, o jogo fica sem imagens. Por isso o script
# verifica-as ANTES de tocar em qualquer coisa e recusa-se a continuar sem elas.
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/Mine-Station/minestation.git}"
BRANCH="${BRANCH:-main}"
REMOTE_DIR="${REMOTE_DIR:-/root/genesis-current}"
COMPOSE_FILE="$REMOTE_DIR/deploy/docker-compose.yml"

# Fonte de verdade do serviço, não valores inventados aqui: o healthcheck e a
# porta vêm do próprio compose / da imagem construída (lidos em runtime abaixo).
SERVICE_NAME="genesisminer-app"
# Nome antigo do contentor Node (antes do rename genesisminer-*). Só para
# rollback/imagem na 1ª troca e para remover o órfão após o up.
LEGACY_SERVICE_NAME="app"
NS_PER_S=1000000000            # docker inspect devolve durações em nanossegundos
HEALTH_POLL_MARGIN_S=15        # folga sobre o pior caso do próprio healthcheck
HEALTH_PATH="/health/ready"    # mesmo endpoint que o healthcheck do compose usa
HTTP_OK=200
LOG_TAIL_LINES=40
MIN_POLL_INTERVAL_S=1          # piso: nunca fazer busy-loop se o interval vier 0

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mXX  %s\033[0m\n' "$*" >&2; exit 1; }

trap 'die "Falhou na linha $LINENO. Nada foi trocado se ainda não chegou ao passo 5."' ERR

# ---------------------------------------------------------------- 1. pré-voo
log "1/7  Verificações de pré-voo"

[ "$(id -u)" -eq 0 ] || warn "Não estás como root — o compose pode falhar."
command -v docker >/dev/null || die "docker não encontrado."
docker compose version >/dev/null 2>&1 || die "plugin 'docker compose' não encontrado."
command -v git >/dev/null || die "git não encontrado."

[ -d "$REMOTE_DIR" ] || die "$REMOTE_DIR não existe. Faz o cutover inicial primeiro (docs/operations/TEST-VPS-CUTOVER.md)."

# Os dados que o Git não traz. Falhar aqui é barato; falhar depois do build não é.
for d in storage/media-seed storage/uploads; do
  p="$REMOTE_DIR/$d"
  [ -d "$p" ] || die "$p não existe. O Git não traz esta pasta — recupera-a por rsync antes de continuar."
  if [ -z "$(ls -A "$p" 2>/dev/null)" ]; then
    die "$p está VAZIA. Continuar deixaria o jogo sem imagens. Recupera por rsync:
    rsync -a --delete storage/$(basename "$d")/ root@<vm>:$p/"
  fi
  printf '    ok  %-22s %s\n' "$d" "$(du -sh "$p" 2>/dev/null | cut -f1)"
done

[ -s "$REMOTE_DIR/deploy/.env" ] || die "$REMOTE_DIR/deploy/.env em falta ou vazio (segredos). Ver TEST-VPS-CUTOVER.md."
grep -q '^POSTGRES_PASSWORD=' "$REMOTE_DIR/deploy/.env" || die "deploy/.env sem POSTGRES_PASSWORD."
printf '    ok  %-22s %s\n' "deploy/.env" "$(wc -l < "$REMOTE_DIR/deploy/.env") linhas"

docker network inspect app_production_default >/dev/null 2>&1 \
  || die "rede 'app_production_default' não existe. A stack app_production tem de estar de pé."
printf '    ok  %-22s\n' "rede app_production_default"

# ------------------------------------------------------- 2. estado anterior
log "2/7  A registar estado actual (para rollback)"

PREV_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$SERVICE_NAME" 2>/dev/null || echo '')"
if [ -z "$PREV_IMAGE_ID" ]; then
  PREV_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$LEGACY_SERVICE_NAME" 2>/dev/null || echo '')"
fi
if [ -n "$PREV_IMAGE_ID" ]; then
  echo "    imagem actual (rollback): $PREV_IMAGE_ID"
  echo "$PREV_IMAGE_ID" > "$REMOTE_DIR/.last-deployed-image"
else
  warn "nem '$SERVICE_NAME' nem '$LEGACY_SERVICE_NAME' a correr — primeiro arranque?"
fi

# ------------------------------------------------------------- 3. git pull
cd "$REMOTE_DIR"

# Modo zip: o código já foi extraído aqui, não há nada para puxar. Serve quando
# a VM não tem credenciais para o repositório privado.
if [ "${SKIP_GIT:-0}" = "1" ]; then
  log "3/7  SKIP_GIT=1 — a usar o código já presente em $REMOTE_DIR"
  if [ -d .git ]; then
    NEW_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 'sem-git')"
  else
    NEW_SHA="$(cat .deployed-sha 2>/dev/null || echo 'zip')"
  fi
  echo "    versão -> $NEW_SHA"
  [ -f package.json ] && [ -d server ] && [ -f Dockerfile ] \
    || die "$REMOTE_DIR não parece conter o projecto (falta package.json, server/ ou Dockerfile). Extraíste o zip no sítio certo?"
else

log "3/7  A puxar código de $REPO_URL ($BRANCH)"

if [ ! -d .git ]; then
  # Directório veio de rsync: converte em clone SEM apagar o que não é do Git.
  # `checkout -f` sobrepõe ficheiros versionados mas não toca em ignorados
  # (storage/, deploy/.env) nem em não-versionados.
  warn "Sem .git — a converter directório rsync em clone (storage/ e deploy/.env preservados)"
  git init -q
  git remote add origin "$REPO_URL"
fi

git remote set-url origin "$REPO_URL"
git fetch --prune origin "$BRANCH"
git checkout -f -B "$BRANCH" "origin/$BRANCH"

NEW_SHA="$(git rev-parse --short HEAD)"
echo "    HEAD -> $NEW_SHA  $(git log -1 --format='%s')"

fi  # fim do modo git

# Confirma que nada pisou os dados. Se pisou, parar antes do build.
for d in storage/media-seed storage/uploads; do
  [ -n "$(ls -A "$REMOTE_DIR/$d" 2>/dev/null)" ] || die "$d ficou vazia depois do checkout. ABORTAR."
done
[ -s "$REMOTE_DIR/deploy/.env" ] || die "deploy/.env desapareceu no checkout. ABORTAR."
echo "    ok  storage/ e deploy/.env intactos"

# ---------------------------------------------------------- 4. build limpo
log "4/7  Build da imagem SEM CACHE (demora — Dockerfile tem 3 estágios)"

docker compose -f "$COMPOSE_FILE" build --no-cache --pull

# ------------------------------------------------------------- 5. arranque
log "5/7  A trocar o contentor"

# Se ainda existir o contentor legado `app`, remove-o antes do up para libertar
# o alias DNS `app` na rede (nginx → app:3000).
if docker ps -a --format '{{.Names}}' | grep -qx "$LEGACY_SERVICE_NAME"; then
  warn "a remover contentor legado '$LEGACY_SERVICE_NAME' (renomeado para '$SERVICE_NAME')"
  docker stop "$LEGACY_SERVICE_NAME" >/dev/null 2>&1 || true
  docker rm "$LEGACY_SERVICE_NAME" >/dev/null 2>&1 || true
fi

docker compose -f "$COMPOSE_FILE" up -d --force-recreate

# --------------------------------------------------------------- 6. health
# O orçamento de espera NÃO é um número escolhido à mão: é o pior caso do
# healthcheck que o próprio contentor declara — start_period + interval*retries
# — lido de `docker inspect`, mais uma folga fixa. Assim, mudar o healthcheck no
# compose ajusta esta espera sozinho, em vez de a deixar dessincronizada.
# `docker inspect --format` renderiza estes campos pelo String() de time.Duration
# ("1m30s", "10s") e NÃO como nanossegundos — foi o que rebentou a aritmética na
# primeira execução real. Pedir JSON devolve o inteiro em nanossegundos.
read -r hc_start hc_interval hc_retries < <(
  docker inspect --format \
    '{{json .Config.Healthcheck.StartPeriod}} {{json .Config.Healthcheck.Interval}} {{json .Config.Healthcheck.Retries}}' \
    "$SERVICE_NAME" 2>/dev/null || echo "0 0 0"
)
# `null` (healthcheck ausente) ou lixo -> 0, para o guarda abaixo apanhar.
for v in hc_start hc_interval hc_retries; do
  case "${!v}" in
    ''|*[!0-9]*) printf -v "$v" '%s' 0 ;;
  esac
done

health_budget_s=$(( (hc_start + hc_interval * hc_retries) / NS_PER_S + HEALTH_POLL_MARGIN_S ))
poll_interval_s=$(( hc_interval / NS_PER_S ))
[ "$poll_interval_s" -ge "$MIN_POLL_INTERVAL_S" ] || poll_interval_s="$MIN_POLL_INTERVAL_S"
[ "$health_budget_s" -gt "$HEALTH_POLL_MARGIN_S" ] \
  || die "Não consegui ler o healthcheck de '$SERVICE_NAME'. Sem fonte de verdade para a espera, não vou adivinhar."

log "6/7  À espera do health check (orçamento ${health_budget_s}s, derivado do healthcheck do contentor)"

deadline=$(( $(date +%s) + health_budget_s ))
healthy=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  st="$(docker inspect --format '{{.State.Health.Status}}' "$SERVICE_NAME" 2>/dev/null || echo unknown)"
  if [ "$st" = "healthy" ]; then healthy=1; break; fi
  if [ "$st" = "unhealthy" ]; then break; fi
  printf '    ... %s\n' "$st"
  sleep "$poll_interval_s"
done

if [ "$healthy" -ne 1 ]; then
  warn "NÃO ficou saudável. Últimas linhas de log:"
  docker logs --tail "$LOG_TAIL_LINES" "$SERVICE_NAME" 2>&1 | sed 's/^/    /'
  die "Deploy falhou no health check. Rollback:
    docker compose -f $COMPOSE_FILE down
    docker run -d --name genesisminer-app --network app_production_default \\
      --env-file $REMOTE_DIR/deploy/.env \$(cat $REMOTE_DIR/.last-deployed-image)
  ou repor a stack antiga: cd /root/minestation/app_production && docker compose up -d app"
fi

echo "    healthy"

# --------------------------------------------------------------- 7. remate
log "7/7  Verificação final"

# A porta vem do ambiente do próprio contentor (definida no compose), não daqui.
app_port="$(docker exec "$SERVICE_NAME" printenv PORT 2>/dev/null || true)"
if [ -n "$app_port" ]; then
  health_url="http://127.0.0.1:${app_port}${HEALTH_PATH}"
  docker exec "$SERVICE_NAME" node -e "
    require('http').get('${health_url}', r => process.exit(r.statusCode === ${HTTP_OK} ? 0 : 1))
      .on('error', () => process.exit(1));
  " >/dev/null 2>&1 \
    && echo "    ok  $health_url responde dentro do contentor" \
    || warn "$health_url não respondeu"
else
  warn "não consegui ler PORT do contentor — verificação de endpoint saltada"
fi

# O nginx resolve `app` só no arranque; IP novo => recarregar.
if docker ps --format '{{.Names}}' | grep -qx app_nginx; then
  docker exec app_nginx nginx -s reload 2>/dev/null \
    && echo "    ok  nginx recarregado" \
    || warn "falhou o reload do nginx — reinicia à mão: docker restart app_nginx"
fi

docker image prune -f >/dev/null 2>&1 || true

log "Deploy concluído — $NEW_SHA"
docker compose -f "$COMPOSE_FILE" ps
