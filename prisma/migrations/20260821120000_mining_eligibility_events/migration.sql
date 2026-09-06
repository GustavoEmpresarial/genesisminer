-- TAREFA 4C: verdade histórica de elegibilidade (append-only) + soft-expire de leases.
-- Provider: PostgreSQL.

-- Eventos económicos após cutover (sem backfill do passado).
CREATE TABLE IF NOT EXISTS "mining_eligibility_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "at_ms" BIGINT NOT NULL,
  "identity_kind" VARCHAR(32) NOT NULL,
  "lease_id" UUID,
  "rack_id" VARCHAR(120),
  "slot_index" INTEGER,
  "catalog_item_id" VARCHAR(200),
  "coin_id" VARCHAR(120),
  "payload" JSONB,
  "created_at" BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS "mining_eligibility_events_user_at_idx"
  ON "mining_eligibility_events" ("user_id", "at_ms");

CREATE INDEX IF NOT EXISTS "mining_eligibility_events_lease_at_idx"
  ON "mining_eligibility_events" ("lease_id", "at_ms");

CREATE INDEX IF NOT EXISTS "mining_eligibility_events_rack_at_idx"
  ON "mining_eligibility_events" ("rack_id", "at_ms");

-- Idempotência: no máximo um ASIC_EXPIRED por lease.
CREATE UNIQUE INDEX IF NOT EXISTS "mining_eligibility_events_asic_expired_lease_uidx"
  ON "mining_eligibility_events" ("lease_id")
  WHERE "event_type" = 'ASIC_EXPIRED' AND "lease_id" IS NOT NULL;

-- Soft-expire: status 'expired' usa a coluna text existente (sem enum DB).
-- Leases já apagadas no passado não são recuperáveis (cutover).
