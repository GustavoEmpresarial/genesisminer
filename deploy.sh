#!/usr/bin/env bash
# Pack current/ and deploy to the Genesis test VM (161.97.176.125) over SSH.
#
# Usage:
#   VM_PASSWORD='...' ./deploy.sh
#   ./deploy.sh --host 161.97.176.125 --password '...'
#
# Requires: python3 + paramiko, zip.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required (apt install zip)" >&2
  exit 1
fi
if ! python3 -c "import paramiko" 2>/dev/null; then
  echo "paramiko missing — install with: python3 -m pip install --user --break-system-packages paramiko" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ZIP="/tmp/genesis-current-deploy-${STAMP}.zip"
echo "[local] packing $ROOT -> $ZIP (zip completo — sem git ls-files)"
rm -f "$ZIP"

# Zip da árvore inteira no disco (inclui ficheiros untracked). Não usar git ls-files:
# deploys anteriores falhavam ao referenciar módulos novos ainda não commitados.
zip -q -r "$ZIP" . \
  -x './.git/*' './.git/**/*' \
     '*/node_modules/*' '*/node_modules/**/*' \
     '*/dist/*' '*/dist/**/*' \
     './client/dist/*' './client/dist/**/*' \
     './storage/uploads/*' './storage/uploads/**/*' \
     './storage/backups/*' './storage/backups/**/*' \
     './scripts/deploy/vm_config_secret.py' \
     './.env' './.env.*' './deploy/.env' \
     '*.log' '*/__pycache__/*' '*/__pycache__/**/*' \
     '*/.venv/*' '*/.venv/**/*' '*.pyc' \
     './android/*' './android/**/*' \
     './native/*' './native/**/*' \
     './rust/target/*' './rust/target/**/*'

BYTES="$(wc -c < "$ZIP" | tr -d ' ')"
echo "[local] zip ready: $ZIP ($BYTES bytes)"

exec python3 "$ROOT/scripts/deploy/deploy.py" --zip "$ZIP" "$@"
