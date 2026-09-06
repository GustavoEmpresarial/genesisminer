#!/usr/bin/env python3
"""
Deploy Genesis Miner (current/) para a VM de teste via zip + SSH.

Envia o código, preserva deploy/.env e storage/, e corre scripts/deploy/deploy.sh
com SKIP_GIT=1 (sem git pull na VM).

Usage (from current/):
  ./deploy.sh
  VM_PASSWORD='...' ./deploy.sh
  ./deploy.sh --host 161.97.176.125 --password '...'

Credentials: scripts/deploy/vm_config_secret.py (gitignored) or VM_IP / VM_PASSWORD.
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import shlex
import sys
import time
from pathlib import Path

try:
    import paramiko
except ImportError as e:
    print("Install paramiko: pip install paramiko", file=sys.stderr)
    raise SystemExit(1) from e

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
SECRET = SCRIPT_DIR / "vm_config_secret.py"
DEFAULT_APP_ROOT = "/root/genesis-current"


def load_secret(
    host_override: str = "", password_override: str = "", user_override: str = "", port_override: int = 0
) -> tuple[str, str, str, int]:
    if host_override:
        pw = password_override or (os.environ.get("VM_PASSWORD") or "").strip()
        if not pw:
            raise SystemExit("--host requires --password or VM_PASSWORD")
        port = port_override or int(os.environ.get("VM_PORT") or "22")
        return host_override, (user_override or "root"), pw, port
    if SECRET.exists():
        spec = importlib.util.spec_from_file_location("vm_config_secret", SECRET)
        if spec is None or spec.loader is None:
            raise RuntimeError("Cannot load vm_config_secret.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        ip = str(getattr(mod, "IP", "") or "").strip()
        login = str(getattr(mod, "LOGIN", "root") or "root").strip()
        pw = str(getattr(mod, "ROOT_PASSWORD", "") or "").strip()
        port_raw = getattr(mod, "PORT", None)
        port = int(port_raw) if port_raw not in (None, "") else int(os.environ.get("VM_PORT") or "22")
        if ip and login and pw:
            return ip, login, pw, port
    ip = (os.environ.get("VM_IP") or "161.97.176.125").strip()
    login = (os.environ.get("VM_USER") or "root").strip()
    pw = (os.environ.get("VM_PASSWORD") or "").strip()
    port = int(os.environ.get("VM_PORT") or "22")
    if not (ip and pw):
        raise SystemExit(
            "Missing credentials: copy scripts/deploy/vm_config_secret.example.py to vm_config_secret.py "
            "or set VM_IP and VM_PASSWORD."
        )
    return ip, login, pw, port


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Deploy minestation current/ to VM over SSH")
    p.add_argument("--zip", metavar="PATH", required=True, help="Local zip of current/ tree")
    p.add_argument("--host", default="", help="Target VM IP")
    p.add_argument("--password", default="", help="Root password")
    p.add_argument("--user", default="", help="SSH user (default root)")
    p.add_argument("--port", type=int, default=0, help="SSH port (default 22 or VM_PORT)")
    return p.parse_args(argv)


def _resolve_zip_path(raw: str) -> Path:
    z = Path(raw).expanduser()
    if not z.is_absolute():
        z = (REPO_ROOT / z).resolve()
    if not z.is_file():
        raise SystemExit(f"ZIP not found: {z}")
    return z


def _remote_script(app_root: str, archive_basename: str) -> str:
    remote_arc = f"/tmp/{archive_basename}"
    no_cache = os.environ.get("GENESIS_DOCKER_BUILD_NO_CACHE", "").strip().lower() in ("1", "true", "yes", "y", "on")
    no_cache_export = "export GENESIS_DOCKER_BUILD_NO_CACHE=1\n" if no_cache else ""
    return f"""set -euo pipefail
{no_cache_export}APP_ROOT={shlex.quote(app_root)}
REMOTE_ARC={shlex.quote(remote_arc)}
command -v unzip >/dev/null 2>&1 || {{ apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip; }}
ENV_BACKUP="$(mktemp -d /tmp/genesis-env-XXXXXX)"
for f in deploy/.env; do
  if [[ -f "$APP_ROOT/$f" ]]; then cp -a "$APP_ROOT/$f" "$ENV_BACKUP/"; fi
done
mkdir -p "$APP_ROOT"
# unzip -o não apaga ficheiros que já não vêm no zip (órfãos de deploys
# anteriores rebentam o tsc). Lista o arquivo, extrai, e remove .ts/.tsx
# em server/ e client/src/ que não estão no zip.
ZIP_LIST="$(mktemp)"
DISK_LIST="$(mktemp)"
unzip -Z -1 "$REMOTE_ARC" | sed 's#^\\./##' | sort -u > "$ZIP_LIST"
unzip -o -q "$REMOTE_ARC" -d "$APP_ROOT"
rm -f "$REMOTE_ARC"
for tree in server client/src; do
  if [[ -d "$APP_ROOT/$tree" ]]; then
    find "$APP_ROOT/$tree" -type f \\( -name '*.ts' -o -name '*.tsx' \\) -printf '%P\\n' \
      | sed "s#^#$tree/#" | sort -u > "$DISK_LIST"
    comm -23 "$DISK_LIST" "$ZIP_LIST" | while IFS= read -r rel; do
      [[ -n "$rel" ]] || continue
      echo "[prune] $rel"
      rm -f "$APP_ROOT/$rel"
    done
  fi
done
rm -f "$ZIP_LIST" "$DISK_LIST"
if [[ -f "$ENV_BACKUP/.env" ]]; then cp -a "$ENV_BACKUP/.env" "$APP_ROOT/deploy/.env"; fi
rm -rf "$ENV_BACKUP"
for d in storage/media-seed storage/uploads; do
  [[ -d "$APP_ROOT/$d" ]] || {{ echo "missing $APP_ROOT/$d"; exit 1; }}
  [[ -n "$(ls -A "$APP_ROOT/$d" 2>/dev/null)" ]] || {{ echo "empty $APP_ROOT/$d"; exit 1; }}
done
cd "$APP_ROOT"
SKIP_GIT=1 bash scripts/deploy/deploy.sh
echo "[vm] deploy finished"
"""


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv if argv is not None else sys.argv[1:])
    archive = _resolve_zip_path(args.zip)
    remote_name = archive.name
    remote_path = f"/tmp/{remote_name}"
    host, user, password, port = load_secret(args.host, args.password, args.user, args.port)
    app_root = (os.environ.get("VM_APP_ROOT") or DEFAULT_APP_ROOT).strip()
    print(f"[deploy] target: {user}@{host}:{port} -> {app_root}", flush=True)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        host,
        port=port,
        username=user,
        password=password,
        timeout=120,
        banner_timeout=120,
        auth_timeout=120,
        look_for_keys=False,
        allow_agent=False,
    )

    size = archive.stat().st_size
    t0 = time.monotonic()
    sftp = client.open_sftp()
    print(f"[sftp] {archive.name} ({size} bytes)", flush=True)
    last = [0]

    def progress(done: int, total: int) -> None:
        if total <= 0:
            return
        step = 5 * 1024 * 1024
        if done == total or done - last[0] >= step:
            last[0] = done
            print(f"[sftp] {100.0 * done / total:.0f}%", flush=True)

    sftp.put(str(archive), remote_path, callback=progress)
    sftp.close()
    print(f"[sftp] upload done in {time.monotonic() - t0:.1f}s", flush=True)

    stdin, stdout, stderr = client.exec_command("bash -s", get_pty=False)
    stdin.write(_remote_script(app_root, archive_basename=remote_name))
    stdin.close()
    ch = stdout.channel
    while True:
        if ch.recv_ready():
            chunk = ch.recv(65536)
            if chunk:
                os.write(1, chunk)
        if ch.recv_stderr_ready():
            chunk = ch.recv_stderr(65536)
            if chunk:
                os.write(2, chunk)
        if ch.exit_status_ready():
            break
        time.sleep(0.25)
    code = ch.recv_exit_status()
    client.close()
    return int(code)


if __name__ == "__main__":
    raise SystemExit(main())
