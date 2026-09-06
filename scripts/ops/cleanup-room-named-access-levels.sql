-- Cleanup: remove access_levels that were fake mining rooms (not membership plans).
-- Source of truth for rooms: rig_rooms (8 active). Run against minestation Postgres.
-- Already applied on prod VM 2026-08-31; keep for reproducibility.

BEGIN;

UPDATE users u
SET access_level_id = COALESCE(
  (
    SELECT ual.access_level_id
    FROM user_access_levels ual
    WHERE ual.user_id = u.id
      AND ual.access_level_id NOT IN ('sala_das_asics', 'one_click', 'sala_extra')
    ORDER BY CASE WHEN ual.access_level_id = 'normal' THEN 0 ELSE 1 END,
             ual.access_level_id
    LIMIT 1
  ),
  'normal'
)
WHERE u.access_level_id IN ('sala_das_asics', 'one_click', 'sala_extra');

DELETE FROM user_access_levels
WHERE access_level_id IN ('sala_das_asics', 'one_click', 'sala_extra');

INSERT INTO user_access_levels (user_id, access_level_id)
SELECT u.id, 'normal'
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM user_access_levels ual WHERE ual.user_id = u.id
)
ON CONFLICT DO NOTHING;

UPDATE admin_upgrades
SET grant_access_level_id = NULL
WHERE grant_access_level_id IN ('sala_das_asics', 'one_click', 'sala_extra');

DELETE FROM admin_upgrade_visibility
WHERE access_level_id IN ('sala_das_asics', 'one_click', 'sala_extra');

DELETE FROM access_level_referral_models
WHERE access_level_id IN ('sala_das_asics', 'one_click', 'sala_extra');

UPDATE rig_rooms
SET allowed_levels = COALESCE((
  SELECT jsonb_agg(to_jsonb(elem))
  FROM jsonb_array_elements_text(
    CASE
      WHEN allowed_levels IS NULL OR btrim(allowed_levels) = '' THEN '[]'::jsonb
      ELSE allowed_levels::jsonb
    END
  ) AS elem
  WHERE elem NOT IN ('sala_das_asics', 'one_click', 'sala_extra')
)::text, '[]');

DELETE FROM access_levels
WHERE id IN ('sala_das_asics', 'one_click', 'sala_extra');

COMMIT;
