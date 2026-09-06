-- Per-unit item identity. stock.qty stays denormalized count.
-- Provider: PostgreSQL. No FKs (merge_* / temp catalog keys exist).
-- code = catalog_item_id (max 200) + ':' + hyphenated UUID (36) = VARCHAR(237).

CREATE TABLE IF NOT EXISTS "item_instances" (
  "id" UUID NOT NULL,
  "code" VARCHAR(237) NOT NULL,
  "catalog_item_id" VARCHAR(200) NOT NULL,
  "user_id" INTEGER NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "rack_id" VARCHAR(120),
  "slot_index" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "item_instances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "item_instances_code_key"
  ON "item_instances" ("code");

CREATE INDEX IF NOT EXISTS "item_instances_user_item_status_idx"
  ON "item_instances" ("user_id", "catalog_item_id", "status");

CREATE INDEX IF NOT EXISTS "item_instances_user_status_idx"
  ON "item_instances" ("user_id", "status");

-- 1) Timed ASICs: reuse lease UUID (no double-count later).
-- acquired_at is unix milliseconds (repo pattern: to_timestamp(ms / 1000.0)).
-- code = item_id || ':' || lease id (hyphenated UUID text).
INSERT INTO "item_instances" (
  "id", "code", "catalog_item_id", "user_id", "status", "rack_id", "slot_index", "created_at"
)
SELECT
  l.id,
  l.item_id || ':' || l.id::text,
  l.item_id,
  l.user_id,
  l.status,
  l.rack_id,
  l.slot_index,
  to_timestamp(l.acquired_at::double precision / 1000.0)
FROM "player_asic_leases" l
ON CONFLICT ("id") DO NOTHING;

-- 2) Permanent stock: mint one UUID per missing warehouse unit.
-- gen_random_uuid() lives inside the generate_series LATERAL so the planner
-- cannot fold it to a single value (CROSS JOIN LATERAL (SELECT uuid) did).
-- Skip SKUs that have any lease (those units already copied in step 1).
INSERT INTO "item_instances" ("id", "code", "catalog_item_id", "user_id", "status")
SELECT
  u.id,
  s.item_id || ':' || u.id::text,
  s.item_id,
  s.user_id,
  'stock'
FROM "stock" s
JOIN LATERAL (
  SELECT gen_random_uuid() AS id
  FROM generate_series(
    1,
    GREATEST(
      s.qty - COALESCE((
        SELECT COUNT(*)::int
        FROM "item_instances" i
        WHERE i.user_id = s.user_id
          AND i.catalog_item_id = s.item_id
          AND i.status = 'stock'
      ), 0),
      0
    )
  ) AS g(n)
) u ON true
WHERE s.qty > 0
  AND btrim(s.item_id) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM player_asic_leases l
    WHERE l.user_id = s.user_id AND l.item_id = s.item_id
  )
ON CONFLICT ("id") DO NOTHING;
