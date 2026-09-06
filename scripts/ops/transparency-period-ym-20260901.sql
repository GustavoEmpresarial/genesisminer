-- Transparency monthly ledger: period_ym (YYYY-MM) or NULL = standing/general.
-- Safe to re-run.

ALTER TABLE transparency_entries
  ADD COLUMN IF NOT EXISTS period_ym text;

CREATE INDEX IF NOT EXISTS transparency_entries_period_ym_idx
  ON transparency_entries (period_ym);

-- Backfill from titles (PT month names) for known 2026 operational rows.
UPDATE transparency_entries
SET period_ym = '2026-07'
WHERE period_ym IS NULL
  AND (
    id = 19
    OR upper(title) ~ '\yJUL(HO)?\y'
  );

UPDATE transparency_entries
SET period_ym = '2026-08'
WHERE period_ym IS NULL
  AND (
    id IN (18, 20)
    OR upper(title) ~ '\yAGO(STO)?\y'
  );

UPDATE transparency_entries
SET period_ym = '2026-09'
WHERE period_ym IS NULL
  AND (
    id = 21
    OR upper(title) ~ '\ySET(EMBRO)?\y'
  );

-- Remaining rows stay NULL (= Geral / permanente).
