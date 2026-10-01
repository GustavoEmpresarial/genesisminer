#!/usr/bin/env python3
"""Fix: imagens do Master Legends devolviam o HTML do Genesis dentro do iframe.

Bug
---
Parte do app do ML emite URLs de imagem absolutos (`/uploads/items/x.png`) sem o
prefixo `/ml`. Dentro do embed isso resolve contra `genesisdao.tech`, que não tem
`location /uploads/` e cai no fallback do SPA:

    genesisdao.tech/uploads/items/x.png    -> 200 text/html  (1.3 KB, SPA)
    genesisdao.tech/ml/uploads/items/x.png -> 200 image/png  (134 KB)

O `<img>` recebe HTML e não renderiza. Como o status é 200, não aparece como erro
em lado nenhum — só imagens partidas.

Correção
--------
`location ^~ /uploads/` no vhost do embed, a encaminhar para o backend do ML tal
como o `/ml/` faz. Seguro porque o Genesis serve as suas próprias imagens em
`/img/` (incl. `/img/uploads/...`) e nunca em `/uploads/` — verificado no cliente
e no `genesis-api`. Corrige também qualquer referência sem prefixo que apareça no
futuro, sem depender de `sub_filter` sobre JS minificado.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[2]
SECRET_MOD = ROOT / "scripts/deploy/vm_config_secret.py"
EMBED_INC = "/root/minestation/app_production/nginx/conf.d/masterlegends-embed.inc"

BLOCK = """# Imagens do ML referidas sem o prefixo /ml (o SPA do Genesis respondia HTML com 200).
# O Genesis serve as suas imagens em /img/, nunca em /uploads/ — sem colisão.
location ^~ /uploads/ {
    proxy_pass http://172.20.0.1:4000;
    proxy_http_version 1.1;
    proxy_connect_timeout 75s;
    proxy_read_timeout 120s;
    proxy_buffering on;

    proxy_set_header Host masterlegends.online;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # ficheiros estáticos não precisam do bypass de captcha; nunca o reencaminhar
    proxy_set_header X-ML-Embed-Bypass "";
    proxy_set_header Connection "";
}

"""

ANCHOR = "# Proxy same-origin do Master Legends para iframe em Partner Games (/ml/).\n"


def main() -> int:
    spec = importlib.util.spec_from_file_location("vm_config_secret", SECRET_MOD)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)

    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(mod.IP, port=int(mod.PORT), username=mod.LOGIN, password=mod.ROOT_PASSWORD, timeout=30)
    sftp = c.open_sftp()

    with sftp.file(EMBED_INC, "r") as f:
        inc = f.read()
    inc = inc.decode() if isinstance(inc, bytes) else inc

    if "location ^~ /uploads/" in inc:
        print("rota /uploads/ já presente")
    else:
        if ANCHOR not in inc:
            print("FATAL: cabeçalho do embed.inc não encontrado", file=sys.stderr)
            return 1
        inc = inc.replace(ANCHOR, BLOCK + ANCHOR, 1)
        with sftp.file(EMBED_INC, "w") as f:
            f.write(inc)
        print("rota /uploads/ adicionada ao embed.inc")
    sftp.close()

    _, out, err = c.exec_command(
        "docker exec app_nginx nginx -t && docker exec app_nginx nginx -s reload && echo RELOADED",
        timeout=120,
    )
    print(out.read().decode())
    e = err.read().decode()
    if e.strip():
        print(e[-800:], file=sys.stderr)
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
