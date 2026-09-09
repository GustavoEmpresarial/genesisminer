# current/ — Genesis Miner (Express + Prisma + Vite + Rust native + mining worker)
# NÃO corre `prisma migrate deploy`: o schema vem do dump Postgres restaurado.
FROM rust:bookworm AS rust-builder
WORKDIR /build
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    cmake g++ pkg-config libssl-dev zlib1g-dev python3 libcurl4-openssl-dev \
  && rm -rf /var/lib/apt/lists/*
ENV CMAKE_ARGS="-DWITH_CURL=OFF -DWITH_SASL=OFF"
COPY rust/Cargo.toml rust/Cargo.lock ./
COPY rust/genesis-core ./genesis-core
COPY rust/genesis-node ./genesis-node
COPY rust/genesis-mining-worker ./genesis-mining-worker
COPY rust/genesis-hardware ./genesis-hardware
COPY rust/genesis-auth ./genesis-auth
COPY rust/genesis-wallet ./genesis-wallet
COPY rust/genesis-api ./genesis-api
RUN cargo build --release -p genesis-node -p genesis-mining-worker -p genesis-hardware -p genesis-auth -p genesis-wallet -p genesis-api \
  && test -f target/release/libgenesis_node.so \
  && test -f target/release/genesis-mining-worker \
  && test -f target/release/genesis-hardware \
  && test -f target/release/genesis-auth \
  && test -f target/release/genesis-wallet \
  && test -f target/release/genesis-api

# Binário 100% Rust — yield cron + progress HTTP (Compose target: mining-worker).
# Port default: MINING_WORKER_DEFAULT_PORT (8091) — ver mining-worker-client.ts / config.rs.
FROM debian:bookworm-slim AS mining-worker
# postgresql-client-16 (matches the prod Postgres 16 server) → pg_dump / pg_restore
# for the DB backup loop + admin endpoint. Debian ships v15, so add the PGDG repo.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg libssl3 zlib1g \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSo /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-16 \
  && apt-get purge -y --auto-remove gnupg \
  && rm -rf /var/lib/apt/lists/*
COPY --from=rust-builder /build/target/release/genesis-mining-worker /usr/local/bin/genesis-mining-worker
ENV GENESIS_MINING_WORKER=1
ENV MINING_WORKER_PORT=8091
EXPOSE 8091
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=6 \
  CMD curl -fsS "http://127.0.0.1:${MINING_WORKER_PORT}/health" || exit 1
CMD ["genesis-mining-worker"]

# Binário 100% Rust — stock / racks persist + intent HTTP (Compose target: hardware).
# Port default: same MINING_WORKER_DEFAULT_PORT (8091) — isolated container.
FROM debian:bookworm-slim AS hardware
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libssl3 zlib1g \
  && rm -rf /var/lib/apt/lists/*
COPY --from=rust-builder /build/target/release/genesis-hardware /usr/local/bin/genesis-hardware
ENV MINING_WORKER_PORT=8091
EXPOSE 8091
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=6 \
  CMD curl -fsS "http://127.0.0.1:${MINING_WORKER_PORT}/health" || exit 1
CMD ["genesis-hardware"]

# Binário 100% Rust — bcrypt + access JWT crypto (Compose target: auth).
# Port default: AUTH_WORKER_DEFAULT_PORT (8091) — isolated container, no host publish.
FROM debian:bookworm-slim AS auth
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libssl3 zlib1g \
  && rm -rf /var/lib/apt/lists/*
COPY --from=rust-builder /build/target/release/genesis-auth /usr/local/bin/genesis-auth
ENV AUTH_WORKER_PORT=8091
EXPOSE 8091
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=6 \
  CMD curl -fsS "http://127.0.0.1:${AUTH_WORKER_PORT}/health" || exit 1
CMD ["genesis-auth"]

# Binário 100% Rust — wallet money TXs (Compose target: wallet).
# Port default: WALLET_WORKER_DEFAULT_PORT (8091) — isolated container, no host publish.
FROM debian:bookworm-slim AS wallet
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libssl3 zlib1g \
  && rm -rf /var/lib/apt/lists/*
COPY --from=rust-builder /build/target/release/genesis-wallet /usr/local/bin/genesis-wallet
ENV WALLET_WORKER_PORT=8091
EXPOSE 8091
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=6 \
  CMD curl -fsS "http://127.0.0.1:${WALLET_WORKER_PORT}/health" || exit 1
CMD ["genesis-wallet"]

FROM node:26-bookworm-slim AS client-builder
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Public game HTTP — SPA + /img + player facades; admin proxies to Express.
# Port default: API_PORT 3000 — nginx `proxy_pass http://app:3000`.
FROM debian:bookworm-slim AS api
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libssl3 zlib1g \
  && rm -rf /var/lib/apt/lists/*
COPY --from=rust-builder /build/target/release/genesis-api /usr/local/bin/genesis-api
COPY --from=client-builder /app/client/dist /app/client/dist
ENV API_PORT=3000
ENV CLIENT_DIST=/app/client/dist
ENV IMG_DIR=/app/storage/media-seed
ENV IMG_UPLOADS_DIR=/app/storage/uploads
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=6 \
  CMD curl -fsS "http://127.0.0.1:${API_PORT}/health" || exit 1
CMD ["genesis-api"]

FROM node:26-bookworm-slim AS server-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY tsconfig.json tsconfig.build.json ./
COPY server ./server
RUN npx prisma generate && npm run build

FROM node:26-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV BACKUP_DIR=/app/storage/backups
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=server-builder /app/dist ./dist
COPY --from=client-builder /app/client/dist ./client/dist
COPY --from=rust-builder /build/target/release/libgenesis_node.so ./native/genesis.node
EXPOSE 3001
CMD ["node", "dist/bootstrap/server.js"]
