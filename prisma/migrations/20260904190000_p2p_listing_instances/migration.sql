-- P2P listing ↔ physical unit join. No FKs (repo pattern).
-- listing_id is TEXT (same as player_listings.id). instance_id is UUID.

CREATE TABLE IF NOT EXISTS "player_listing_instances" (
  "listing_id" TEXT NOT NULL,
  "instance_id" UUID NOT NULL,
  CONSTRAINT "player_listing_instances_pkey" PRIMARY KEY ("listing_id", "instance_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "player_listing_instances_instance_id_key"
  ON "player_listing_instances" ("instance_id");

CREATE INDEX IF NOT EXISTS "player_listing_instances_listing_id_idx"
  ON "player_listing_instances" ("listing_id");

-- Open-book backfill only. Live-ad identity was consumed by adjust — new codes
-- for the open book. Never mint when missing qty <= 0.
-- effective qty = GREATEST(COALESCE(NULLIF(qty, 0), 1), 1)
-- code = item_id || ':' || id::text (same as 20260904180000).
WITH planned AS (
  SELECT
    l.id AS listing_id,
    l.user_id,
    l.item_id,
    gen_random_uuid() AS instance_id
  FROM "player_listings" l
  CROSS JOIN LATERAL generate_series(
    1,
    GREATEST(
      GREATEST(COALESCE(NULLIF(l.qty, 0), 1), 1)
      - COALESCE((
        SELECT COUNT(*)::int
        FROM "player_listing_instances" j
        WHERE j.listing_id = l.id
      ), 0),
      0
    )
  ) AS g(n)
  WHERE l.status IN ('active', 'awaiting_pickup')
    AND GREATEST(COALESCE(NULLIF(l.qty, 0), 1), 1) > 0
    AND btrim(COALESCE(l.item_id, '')) <> ''
),
ins_inst AS (
  INSERT INTO "item_instances" (
    "id", "code", "catalog_item_id", "user_id", "status"
  )
  SELECT
    p.instance_id,
    p.item_id || ':' || p.instance_id::text,
    p.item_id,
    p.user_id,
    'listed'
  FROM planned p
  ON CONFLICT ("id") DO NOTHING
  RETURNING id
)
INSERT INTO "player_listing_instances" ("listing_id", "instance_id")
SELECT p.listing_id, p.instance_id
FROM planned p
ON CONFLICT ("instance_id") DO NOTHING;
