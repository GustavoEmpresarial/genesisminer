#!/usr/bin/env bash
set -euo pipefail
cd /root/genesis-current/deploy
echo "==> sequential compose build (no --no-cache) to dodge flaky apt"
for svc in mining-worker hardware wallet auth app express; do
  if ! grep -qE "^  ${svc}:" docker-compose.yml; then
    echo "skip missing svc $svc"
    continue
  fi
  echo "======== BUILD $svc ========"
  ok=0
  for attempt in 1 2 3 4 5; do
    echo "attempt $attempt for $svc"
    if docker compose build "$svc"; then
      ok=1
      break
    fi
    echo "build $svc failed attempt $attempt — sleep and retry"
    sleep 15
  done
  if [ "$ok" != 1 ]; then
    echo "FATAL: $svc build failed after retries"
    exit 1
  fi
done
echo "==> up -d --force-recreate"
docker compose up -d --force-recreate
echo "==> containers"
docker compose ps
echo "[vm] deploy finished (sequential)"
