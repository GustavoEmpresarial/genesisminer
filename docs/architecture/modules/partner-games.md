# Partner Games

Multi-game hub (official Genesis + partner titles). Catalog and session-by-slug
live in `genesis-core::partner_games`; I/O is `genesis-mining-worker` via
`genesis-api` facade.

**Embed paths:** same-origin nginx proxies — BlockMiner `/bm/` (`blockminer-embed.inc`
on Hostinger; not in this repo’s `deploy/nginx` tree) and Master Legends `/ml/`
(nginx proxy added on VM separately). Both games support iframe embed + heartbeat.

## Catalog (Rust)

Static games in `genesis-core::partner_games::catalog()` (official first):

| slug | name | section | embed | public URL |
|------|------|---------|-------|------------|
| `master-legends` | Master Legends | `official` | `/ml/` | `https://masterlegends.online/` |
| `blockminer` | BlockMiner | `partner` | `/bm/` | `https://blockminer.space/` |

Section values: `SECTION_OFFICIAL` (`"official"`) | `SECTION_PARTNER` (`"partner"`).

## API (auth required)

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/api/partner-games/config` | — | `{ ok, heartbeatIntervalMs, games[{ slug, name, publicUrl, embedPath, imageUrl, sessionKind, section }], maintenance }` |
| `POST` | `/api/partner-games/visit` | `{ slug }` | `{ ok }` + Kafka `reason=visit` (or **503** maintenance / **400** missing/unknown slug) |
| `POST` | `/api/partner-games/heartbeat` | `{ slug }` | `{ ok, accepted, creditedMinutes, nextEligibleAtMs }` — embed games only; no embed → **400** `HEARTBEAT_NOT_SUPPORTED` |
| `POST` | `/api/partner-games/stop` | `{ slug }` | `{ ok }` + Kafka `reason=stop` (no-op 200 under maintenance) |

Env `PARTNER_GAMES_MAINTENANCE=1|true` on **mining-worker** puts the Partner · Games
tab and visit/heartbeat APIs in maintenance.

Redis key: `partner_games:hb:{userId}:{slug}`.

Kafka topic: `genesis.partner_games.session` (`sessionKind` from the game).

Quest bumps: `partner_games_visit` (any game visit); `partner_games_playtime` (embed heartbeat).

**UI:** hub with official + partner sections at Partner · Games; player at `/partner_games/:slug` (iframe for both).

**Not in scope:** quest rewards / `reward_usdc` / offerwall.
