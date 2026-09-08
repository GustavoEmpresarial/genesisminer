-- Logo custom por moeda (URL de /api/admin/upload-image). Opcional — o front
-- cai no CDN cryptocurrency-icons pelo símbolo quando null.
ALTER TABLE "mining_coins"
  ADD COLUMN IF NOT EXISTS "icon_url" varchar(2048);
