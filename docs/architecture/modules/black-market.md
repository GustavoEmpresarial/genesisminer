# Black market (P2P)

Player-to-player listings: book query, reserve window, buy/sell, custody claim.

## Rust slice (`GENESIS_MARKET_RUST=1`)

Domain helpers in `genesis-core::market` via `black-market-rust-bridge.ts`:

- page clamps (`limit` / `offset`)
- tax percent clamp
- `MARKET_RESERVE_MS` / `computeReservedUntil` / `isReservationActive`
- P2P band reference USD

**Still Node:** Prisma mutations, listing I/O, WebSocket `emitMarketWs`.

Kafka (best-effort): `genesis.market.events` with reasons
`listing_reserved` | `listing_unreserved` | `listing_bought` | `listing_sold` (sell create).
