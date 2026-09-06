# Partner Games (BlockMiner hub)

Thin HTTP + Kafka session tracking for the embedded BlockMiner partner hub.

**Embed path `/bm/`:** served by host nginx via `blockminer-embed.inc` on Hostinger. That include is **not** in this repo’s `deploy/nginx` tree — only the app’s `embedPath` config points at it.

## API (auth required)

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/api/partner-games/config` | — | `{ ok, embedPath, publicUrl, heartbeatIntervalMs, sessionKind, maintenance }` |
| `POST` | `/api/partner-games/visit` | — | `{ ok }` + Kafka `reason=visit` (or **503** `{ ok:false, error:'MAINTENANCE', maintenance:true }` when flag on) |
| `POST` | `/api/partner-games/heartbeat` | — | `{ ok, accepted, creditedMinutes, nextEligibleAtMs }` (+ Kafka if accepted); **503** when maintenance |
| `POST` | `/api/partner-games/stop` | — | `{ ok }` + Kafka `reason=stop` (no-op 200 under maintenance) |

Env `PARTNER_GAMES_MAINTENANCE=1|true` puts the Partner · Games tab and visit/heartbeat APIs in maintenance (compose prod defaults on); Rust session_config stays unchanged (flag is Node I/O only).

Domain math (config + heartbeat gate) lives in `genesis-core::partner_games`, opt-in via `GENESIS_PARTNER_GAMES_RUST=1`.

Kafka topic: `genesis.partner_games.session`.

**Not in scope:** quest rewards / `reward_usdc` / offerwall.
