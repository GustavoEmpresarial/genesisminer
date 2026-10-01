-- Admin-tunable knobs for the transparency health index ("Termómetro financeiro").
--
-- Why: the index summed published entries all-time while the on-chain cash flows were
-- windowed to the season (2026-09-01). One 2025-12 expense of $36.500 was charged against
-- a single month of deposits, pinning the public score at the floor forever.
--
-- period_scope DEFAULTS TO 'all_time' on purpose: this migration is a functional no-op.
-- Flipping to 'season' is a deliberate, reversible admin action, not a side effect of deploy.
--
-- Single row enforced by CHECK (id = 1). IF NOT EXISTS keeps it safe to re-run.
CREATE TABLE IF NOT EXISTS "transparency_health_settings" (
  "id"               integer PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "weight_inflow"    double precision NOT NULL DEFAULT 0.40 CHECK ("weight_inflow"  >= 0 AND "weight_inflow"  <= 1),
  "weight_rent"      double precision NOT NULL DEFAULT 0.35 CHECK ("weight_rent"    >= 0 AND "weight_rent"    <= 1),
  "weight_ledger"    double precision NOT NULL DEFAULT 0.25 CHECK ("weight_ledger"  >= 0 AND "weight_ledger"  <= 1),
  "floor_score"      integer NOT NULL DEFAULT 50 CHECK ("floor_score" >= 0 AND "floor_score" <= 100),
  "season_start_ms"  bigint  NOT NULL DEFAULT 1788220800000,
  "period_scope"     varchar(16) NOT NULL DEFAULT 'all_time'
                     CHECK ("period_scope" IN ('season', 'all_time', 'current_month')),
  "count_undated"    boolean NOT NULL DEFAULT true,
  "override_enabled" boolean NOT NULL DEFAULT false,
  "override_value"   integer CHECK ("override_value" IS NULL OR ("override_value" >= 0 AND "override_value" <= 100)),
  "updated_at"       bigint NOT NULL DEFAULT 0,
  "updated_by"       varchar(128)
);

INSERT INTO "transparency_health_settings" ("id", "updated_at")
VALUES (1, (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
ON CONFLICT ("id") DO NOTHING;

-- Who changed the public financial metric, when, and from what. Never shown to players;
-- exists so a manual score can always be traced back to an operator.
CREATE TABLE IF NOT EXISTS "transparency_health_settings_audit" (
  "id"          bigserial PRIMARY KEY,
  "changed_at"  bigint NOT NULL,
  "changed_by"  varchar(128),
  "before_json" jsonb NOT NULL,
  "after_json"  jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_transparency_health_audit_at"
  ON "transparency_health_settings_audit" ("changed_at" DESC);
