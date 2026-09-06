# Lucky boxes

Shop purchase, inventory open/discard, registration / upgrade-package grant-all rolls.

## Rust slice (`GENESIS_LUCKY_BOXES_RUST=1`)

Loot rolls in `genesis-core::lucky_boxes` via `lucky-boxes-rust-bridge.ts`:

- `roll_independent` / `roll_grant_all` with host-provided `Math.random` samples
- TS fallback if flag off or native missing

**Still Node:** Prisma open/buy/discard transactions, idempotency, grants.

Kafka (best-effort after successful open): `genesis.lucky_box.open`.
