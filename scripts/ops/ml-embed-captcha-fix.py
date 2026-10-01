#!/usr/bin/env python3
"""Fix: Turnstile "dá pau" — captcha silenciosamente desligado fora do embed.

Bug
---
`TurnstileWidget.isGenesisEmbedHost()` tratava o *path* `/ml/` como prova de
embed. O SPA fallback do `masterlegends.online` serve a app em
`masterlegends.online/ml/login`, onde **não** existe o `X-ML-Embed-Bypass`
(esse header só é injetado pelo `location ^~ /ml/` do vhost genesisdao.tech).
Resultado: o widget esconde o Cloudflare Turnstile, manda o token dummy
`genesis-embed`, a API recusa com `AUTH_CAPTCHA_INVALID` (400) e o utilizador
fica sem captcha nenhum para resolver — login morto.

Correções
---------
1. web  — o bypass passa a depender **só do host** (`*.genesisdao.tech`).
2. nginx — `masterlegends.online/ml/*` deixa de servir o SPA: 301 para a rota
   canónica (`/ml/login` → `/login`).
3. nginx — `masterlegends.online` limpa `X-ML-Embed-Bypass` vindo do cliente
   (defesa em profundidade: segredo vazado != bypass global de captcha).
4. compose — `docker-compose.vm-online.yml` publicava `4000:15000`, mas a imagem
   online (`docker/Dockerfile.web-runtime-online` + `apps/web/nginx.vm-online.conf`)
   escuta em **4100**. A porta errada só explode quando a imagem é reconstruída
   -> 502 em masterlegends.online E no embed /ml/. Corrigido para `4000:4100`.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[2]
SECRET_MOD = ROOT / "scripts/deploy/vm_config_secret.py"

WIDGET_PATH = "/opt/mll/apps/web/src/components/auth/TurnstileWidget.tsx"
ML_VHOST = "/root/minestation/app_production/nginx/conf.d/masterlegends.online.conf"

EMBED_OLD = """/** Genesis Partner Games iframe is same-origin under /ml on genesisdao hosts. */
function isGenesisEmbedHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  if (host === 'genesisdao.tech' || host.endsWith('.genesisdao.tech')) return true;
  return window.location.pathname === '/ml' || window.location.pathname.startsWith('/ml/');
}"""

EMBED_NEW = """/**
 * Genesis Partner Games iframe is same-origin under /ml on genesisdao hosts.
 *
 * HOST-ONLY on purpose: only the genesisdao vhost injects `X-ML-Embed-Bypass`,
 * so only there may the widget skip Cloudflare. Trusting the `/ml/` *path*
 * turned `masterlegends.online/ml/login` into a dead login — captcha hidden,
 * dummy token sent, API answering 400 AUTH_CAPTCHA_INVALID.
 */
function isGenesisEmbedHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'genesisdao.tech' || host.endsWith('.genesisdao.tech');
}"""

NGINX_ANCHOR = """    location / {
        limit_req zone=perip burst=200 nodelay;"""

NGINX_ML_GUARD = """    # /ml/* é o path do embed no genesisdao.tech. Aqui o SPA fallback servia a app
    # sem o header de bypass -> captcha escondido + token dummy = login morto.
    location = /ml {
        return 301 https://masterlegends.online/;
    }

    location ^~ /ml/ {
        rewrite ^/ml/(.*)$ https://masterlegends.online/$1 permanent;
    }

"""


def load_vm():
    spec = importlib.util.spec_from_file_location("vm_config_secret", SECRET_MOD)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    mod = load_vm()
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(mod.IP, port=int(mod.PORT), username=mod.LOGIN, password=mod.ROOT_PASSWORD, timeout=30)
    sftp = c.open_sftp()

    def read(path: str) -> str:
        with sftp.file(path, "r") as f:
            data = f.read()
        return data.decode() if isinstance(data, bytes) else data

    def write(path: str, content: str) -> None:
        with sftp.file(path, "w") as f:
            f.write(content)

    # --- 1. web widget ---------------------------------------------------
    widget = read(WIDGET_PATH)
    if EMBED_OLD in widget:
        write(WIDGET_PATH, widget.replace(EMBED_OLD, EMBED_NEW, 1))
        print("[1/4] TurnstileWidget.tsx: bypass agora é host-only")
    elif "HOST-ONLY on purpose" in widget:
        print("[1/4] TurnstileWidget.tsx: já corrigido")
    else:
        print("FATAL: isGenesisEmbedHost() não bate com o esperado", file=sys.stderr)
        return 1

    # --- 2 + 3. vhost masterlegends.online -------------------------------
    vhost = read(ML_VHOST)
    changed = False
    if "location ^~ /ml/" not in vhost:
        if NGINX_ANCHOR not in vhost:
            print("FATAL: bloco `location /` do vhost ML não encontrado", file=sys.stderr)
            return 1
        vhost = vhost.replace(NGINX_ANCHOR, NGINX_ML_GUARD + NGINX_ANCHOR, 1)
        changed = True
        print("[2/4] masterlegends.online: /ml/* -> 301 rota canónica")
    else:
        print("[2/4] masterlegends.online: guard /ml/ já presente")

    if 'proxy_set_header X-ML-Embed-Bypass ""' not in vhost:
        needle = "        proxy_set_header Host $host;"
        if needle not in vhost:
            print("FATAL: proxy_set_header Host não encontrado no vhost ML", file=sys.stderr)
            return 1
        vhost = vhost.replace(
            needle,
            needle + '\n        # nunca aceitar bypass de captcha vindo do cliente\n'
            '        proxy_set_header X-ML-Embed-Bypass "";',
            1,  # só o `location /` (o de socket.io não fala com /auth)
        )
        changed = True
        print("[3/4] masterlegends.online: X-ML-Embed-Bypass do cliente limpo")
    else:
        print("[3/4] masterlegends.online: header já limpo")

    if changed:
        write(ML_VHOST, vhost)

    # --- 4. porta publicada do mll-web ------------------------------------
    compose = read("/opt/mll/docker-compose.vm-online.yml")
    if '"4000:15000"' in compose:
        write("/opt/mll/docker-compose.vm-online.yml", compose.replace('"4000:15000"', '"4000:4100"'))
        print("[4/4] compose online: porta publicada 4000:15000 -> 4000:4100")
    elif '"4000:4100"' in compose:
        print("[4/4] compose online: porta já correta")
    else:
        print("AVISO: mapeamento de porta do web não reconhecido", file=sys.stderr)

    sftp.close()

    # --- deploy ----------------------------------------------------------
    cmd = r"""
set -e
docker exec app_nginx nginx -t && docker exec app_nginx nginx -s reload
echo NGINX_RELOADED

cd /opt/mll
SITE_KEY=$(grep -E '^VITE_TURNSTILE_SITE_KEY=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
docker run --rm -v /opt/mll:/app -w /app \
  -e "VITE_TURNSTILE_SITE_KEY=${SITE_KEY}" \
  node:20-alpine sh -lc '
    set -e
    apk add --no-cache libc6-compat >/dev/null
    npm install -w @mll/web -w @mll/shared --ignore-scripts --include=dev
    npm run build -w @mll/web
  ' 2>&1 | tail -15

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.vm-infra.yml -f docker-compose.vm-online.yml)
"${COMPOSE[@]}" build web 2>&1 | tail -8
"${COMPOSE[@]}" up -d --force-recreate --no-deps web 2>&1 | tail -8
sleep 4
docker ps --format '{{.Names}} {{.Status}}' | grep mll-web
"""
    _, stdout, stderr = c.exec_command(cmd, timeout=1800)
    print(stdout.read().decode()[-4000:])
    err = stderr.read().decode()
    if err.strip():
        print("STDERR:", err[-1500:], file=sys.stderr)
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
