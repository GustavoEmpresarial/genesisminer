-- Access levels catalog cleanup (2026-11-03).
-- KEEP (UPPERCASE names): normal, suporte, mod, founder, creator, vip_1, vip_gold, passe_premium
-- ADD: holder_nft
-- DELETE never-existed: Baleia, tester
-- DELETE retired: genesis, kraken, capitao_nemo, monte_olimpo, nautilos, full_baleia, partner
-- STREAMER (creator) = parceiro → migrate partner/partners → creator
--
-- Run on production Postgres (minestation). Review counts before COMMIT.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Migrate partner* → creator (STREAMER = parceiro)
-- ---------------------------------------------------------------------------
INSERT INTO user_access_levels (user_id, access_level_id, granted_at)
SELECT ual.user_id, 'creator', COALESCE(ual.granted_at, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
FROM user_access_levels ual
WHERE LOWER(BTRIM(ual.access_level_id)) IN ('partner', 'partners', 'parceiro', 'parceiros')
  AND NOT EXISTS (
    SELECT 1 FROM user_access_levels x
    WHERE x.user_id = ual.user_id AND x.access_level_id = 'creator'
  )
ON CONFLICT DO NOTHING;

UPDATE users
SET access_level_id = 'creator'
WHERE LOWER(BTRIM(access_level_id)) IN ('partner', 'partners', 'parceiro', 'parceiros');

DELETE FROM user_access_levels
WHERE LOWER(BTRIM(access_level_id)) IN ('partner', 'partners', 'parceiro', 'parceiros');

-- ---------------------------------------------------------------------------
-- 2) Levels to remove (after partner migration)
-- ---------------------------------------------------------------------------
-- Baleia, tester (never belonged) + retired season names + partner
CREATE TEMP TABLE _al_delete (id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _al_delete (id) VALUES
  ('Baleia'),
  ('tester'),
  ('genesis'),
  ('kraken'),
  ('capitao_nemo'),
  ('monte_olimpo'),
  ('nautilos'),
  ('full_baleia'),
  ('partner');

-- Kept membership priority for re-homing primary plan
CREATE TEMP TABLE _al_keep_priority (id text PRIMARY KEY, ord int NOT NULL) ON COMMIT DROP;
INSERT INTO _al_keep_priority (id, ord) VALUES
  ('founder', 10),
  ('passe_premium', 20),
  ('vip_gold', 30),
  ('vip_1', 40),
  ('creator', 50),
  ('suporte', 60),
  ('mod', 70),
  ('holder_nft', 80),
  ('normal', 90);

-- Primary plan: prefer another kept badge, else normal
UPDATE users u
SET access_level_id = COALESCE(
  (
    SELECT ual.access_level_id
    FROM user_access_levels ual
    JOIN _al_keep_priority kp ON kp.id = ual.access_level_id
    WHERE ual.user_id = u.id
    ORDER BY kp.ord ASC, ual.access_level_id ASC
    LIMIT 1
  ),
  'normal'
)
WHERE u.access_level_id IN (SELECT id FROM _al_delete)
   OR u.access_level_id IS NULL
   OR BTRIM(u.access_level_id) = '';

DELETE FROM user_access_levels
WHERE access_level_id IN (SELECT id FROM _al_delete);

-- Ensure every user still has at least one membership row
INSERT INTO user_access_levels (user_id, access_level_id, granted_at)
SELECT u.id, COALESCE(NULLIF(BTRIM(u.access_level_id), ''), 'normal'), (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM user_access_levels ual WHERE ual.user_id = u.id)
ON CONFLICT DO NOTHING;

-- Referral / pack grant leftovers
DELETE FROM access_level_referral_models
WHERE access_level_id IN (SELECT id FROM _al_delete);

UPDATE admin_upgrades
SET grant_access_level_id = NULL
WHERE grant_access_level_id IN (SELECT id FROM _al_delete);

DELETE FROM admin_upgrade_visibility
WHERE access_level_id IN (SELECT id FROM _al_delete);

DELETE FROM access_levels
WHERE id IN (SELECT id FROM _al_delete);

-- ---------------------------------------------------------------------------
-- 3) Upsert kept catalog (UPPERCASE names + descriptions) + HOLDER NFT
-- ---------------------------------------------------------------------------
INSERT INTO access_levels (
  id, name, description, is_default, is_active, price_usdc, contract_address,
  inactive_message, news_posting_enabled, allowed_pages
) VALUES
  ('normal', 'NORMAL', 'Acesso padrão gratuito.', 1, 1, NULL, NULL, NULL, 0, '[]'),
  ('suporte', 'SUPORTE', 'Análises/Testes', 0, 1, 0, NULL, NULL, 0, '[]'),
  ('mod', 'MODERADOR', 'Apoio do site', 0, 1, 0, NULL, NULL, 0, '[]'),
  ('founder', 'FUNDADOR', 'Todos com sala Fundador', 0, 1, 0, NULL, NULL, 0, '[]'),
  ('creator', 'STREAMER', 'É = parceiro', 0, 1, NULL, NULL, NULL, 0, '[]'),
  ('vip_1', 'VIP I', 'Tem sala VIP', 0, 1, 0, NULL, NULL, 0, '[]'),
  ('vip_gold', 'VIP GOLD', 'Tem sala Gold', 0, 1, 0, NULL, NULL, 0, '[]'),
  ('passe_premium', 'PREMIUM', 'Tem todas salas', 0, 1, 0, NULL, NULL, 0, '[]'),
  ('holder_nft', 'HOLDER NFT', 'Holders NFT', 0, 1, 0, NULL, NULL, 0, '[]')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_default = EXCLUDED.is_default,
  is_active = EXCLUDED.is_active,
  price_usdc = COALESCE(EXCLUDED.price_usdc, access_levels.price_usdc),
  news_posting_enabled = EXCLUDED.news_posting_enabled;

-- Clear is_default on anything else (should be none)
UPDATE access_levels SET is_default = 0 WHERE id <> 'normal';
UPDATE access_levels SET is_default = 1 WHERE id = 'normal';

COMMIT;

-- Verification
SELECT id, name, description, is_default, is_active FROM access_levels ORDER BY name;
SELECT access_level_id, COUNT(*) FROM user_access_levels GROUP BY 1 ORDER BY 1;
SELECT access_level_id, COUNT(*) FROM users WHERE access_level_id IS NOT NULL GROUP BY 1 ORDER BY 1;
