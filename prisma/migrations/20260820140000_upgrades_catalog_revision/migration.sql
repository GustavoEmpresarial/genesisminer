-- Singleton revision for upgrades catalog OCC (admin replace vs merge_*).
CREATE TABLE IF NOT EXISTS "upgrades_catalog_meta" (
  "id" INTEGER NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "upgrades_catalog_meta_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "upgrades_catalog_meta_singleton" CHECK ("id" = 1)
);

INSERT INTO "upgrades_catalog_meta" ("id", "revision")
VALUES (1, 0)
ON CONFLICT ("id") DO NOTHING;
