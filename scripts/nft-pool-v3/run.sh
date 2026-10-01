#!/usr/bin/env bash
# Run a .sql file against the production DB (container postgres_app / DB minestation) on the VM.
#
#   ./run.sh survey.sql -v phase=initial
#   ./run.sh migrate-holdings.sql -v dry_run=1
#
# Extra args after the filename are passed straight to psql.
# VM creds read from ../../vm-credentials.txt (host / porta / senha lines).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cred="$here/../../vm-credentials.txt"
[[ -f "$cred" ]] || { echo "faltou $cred" >&2; exit 1; }

vm_host="$(grep -oE '177\.[0-9.]+' "$cred" | head -1)"
vm_port="$(grep -iE 'Porta SSH' "$cred" | grep -oE '[0-9]+' | head -1)"
vm_pass="$(grep -iE '^Senha' "$cred" | sed -E 's/^[^:]*:[[:space:]]*//')"
: "${vm_host:?}" "${vm_port:?}" "${vm_pass:?}"

sql_file="${1:?uso: ./run.sh <arquivo.sql> [args psql...]}"; shift
[[ -f "$here/$sql_file" ]] || { echo "nao achei $here/$sql_file" >&2; exit 1; }

export SSHPASS="$vm_pass"
sshpass -e ssh -p "$vm_port" -o StrictHostKeyChecking=no "root@$vm_host" \
  "docker exec -i postgres_app psql -U postgres -d minestation -v ON_ERROR_STOP=1 -P pager=off $* -f -" \
  < "$here/$sql_file"
