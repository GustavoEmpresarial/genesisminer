# Variáveis de ambiente (legado)

Fonte: `legacy/.env.example` (raiz, 11KB — a maior parte é comentário
explicando cada variável; abaixo só as chaves).

| Variável | Uso provável |
|---|---|
| `NODE_ENV` | ambiente (`development`/`production`) |
| `PORT` | porta HTTP da API |
| `FRONTEND_URL` | origem do frontend (usado em CORS/redirects) |
| `CORS_ALLOWED_ORIGINS` | lista de origens CORS permitidas |
| `CORS_EXTRA_ORIGINS` | origens adicionais de CORS |
| `JWT_SECRET` | assinatura de JWT (auth) |
| `API_KEY` | chave de API genérica (a confirmar consumidor) |
| `POSTGRES_PASSWORD` | senha do Postgres (usada pelo compose) |
| `POLYGON_RPC` | RPC EVM Polygon |
| `BASE_RPC` | RPC EVM Base |
| `BNB_RPC` | RPC EVM BNB Chain |
| `ETHERSCAN_API_KEY` | consulta a explorer (verificação de tx/wallet) |

Variáveis de banco (`DATABASE_URL` do Postgres, Mongo, Redis) não aparecem
como chave solta no `.env.example` — prováveis defaults montados no
`docker-compose.yml` (ver `POSTGRES_PASSWORD` + nome fixo `minestation` do DB).
Confirmar ao migrar.

`app_production/.env` tem seu próprio conjunto (produção, não commitado) —
a documentar separadamente sem expor segredos reais.

## Pendente
- [ ] Confirmar se falta alguma env consumida no código mas não documentada no `.env.example` (grep por `process.env.` no backend).
