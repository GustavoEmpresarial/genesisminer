-- Force-delete listed admin shop packs (admin_upgrades).
-- Pedido 2026-09-10: pacotes com compras — a UI/API bloqueia, mas delete NÃO cascadeia
-- para stock/placed_racks. Removemos o ledger `admin_upgrade_purchases` (com bak)
-- só para satisfazer a FK, depois a receita + o pacote.
--
-- NÃO inclui COLEÇÃO GATOS.
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _del_pack_ids AS
  SELECT id, name FROM admin_upgrades WHERE name IN (
    'SALA DÓLAR/NFT INICIANTES',
    'SALA OLYIMPIA (Monte Olimpo upgrade)',
    'SALA SHARK-TANK (Upgrade)',
    'PASSE DE TEMPORADA GÊNESIS',
    'PASSE Gênesis Vip I',
    'SALA GOLD II',
    'SALA VIP I',
    'COM BUG SALA GOLD',
    'COM BUG NÃO USAR SALA VIP',
    'bugada SALA ONE CLICK',
    'COM BUG',
    'MEMORY CRISIS GLOBAL',
    'COM BUG PASSE GENESIS DAO UPGRADE',
    'SALA MONTE OLIMPO',
    'SALA PREMIUM',
    'FÊNIX',
    'COM BUG NAUTILOS',
    'NÊMESIS',
    'KRAKEN',
    'COM BUG SHARK',
    'Fundador'
  );

CREATE TABLE IF NOT EXISTS admin_upgrades_bak_force_delete_20260910 AS
  SELECT * FROM admin_upgrades WHERE false;
CREATE TABLE IF NOT EXISTS admin_upgrade_purchases_bak_force_delete_20260910 AS
  SELECT * FROM admin_upgrade_purchases WHERE false;
CREATE TABLE IF NOT EXISTS admin_upgrade_items_bak_force_delete_20260910 AS
  SELECT * FROM admin_upgrade_items WHERE false;
CREATE TABLE IF NOT EXISTS admin_upgrade_boxes_bak_force_delete_20260910 AS
  SELECT * FROM admin_upgrade_boxes WHERE false;
CREATE TABLE IF NOT EXISTS admin_upgrade_passes_bak_force_delete_20260910 AS
  SELECT * FROM admin_upgrade_passes WHERE false;
CREATE TABLE IF NOT EXISTS admin_upgrade_coins_bak_force_delete_20260910 AS
  SELECT * FROM admin_upgrade_coins WHERE false;
CREATE TABLE IF NOT EXISTS admin_upgrade_visibility_bak_force_delete_20260910 AS
  SELECT * FROM admin_upgrade_visibility WHERE false;

INSERT INTO admin_upgrades_bak_force_delete_20260910
  SELECT a.* FROM admin_upgrades a
  JOIN _del_pack_ids d ON d.id = a.id
  WHERE NOT EXISTS (
    SELECT 1 FROM admin_upgrades_bak_force_delete_20260910 b WHERE b.id = a.id
  );

INSERT INTO admin_upgrade_purchases_bak_force_delete_20260910
  SELECT p.* FROM admin_upgrade_purchases p
  JOIN _del_pack_ids d ON d.id = p.upgrade_id
  WHERE NOT EXISTS (
    SELECT 1 FROM admin_upgrade_purchases_bak_force_delete_20260910 b WHERE b.id = p.id
  );

INSERT INTO admin_upgrade_items_bak_force_delete_20260910
  SELECT i.* FROM admin_upgrade_items i JOIN _del_pack_ids d ON d.id = i.upgrade_id;
INSERT INTO admin_upgrade_boxes_bak_force_delete_20260910
  SELECT i.* FROM admin_upgrade_boxes i JOIN _del_pack_ids d ON d.id = i.upgrade_id;
INSERT INTO admin_upgrade_passes_bak_force_delete_20260910
  SELECT i.* FROM admin_upgrade_passes i JOIN _del_pack_ids d ON d.id = i.upgrade_id;
INSERT INTO admin_upgrade_coins_bak_force_delete_20260910
  SELECT i.* FROM admin_upgrade_coins i JOIN _del_pack_ids d ON d.id = i.upgrade_id;
INSERT INTO admin_upgrade_visibility_bak_force_delete_20260910
  SELECT i.* FROM admin_upgrade_visibility i JOIN _del_pack_ids d ON d.id = i.upgrade_id;

DELETE FROM admin_upgrade_purchases p USING _del_pack_ids d WHERE p.upgrade_id = d.id;
DELETE FROM admin_upgrade_items i USING _del_pack_ids d WHERE i.upgrade_id = d.id;
DELETE FROM admin_upgrade_boxes i USING _del_pack_ids d WHERE i.upgrade_id = d.id;
DELETE FROM admin_upgrade_passes i USING _del_pack_ids d WHERE i.upgrade_id = d.id;
DELETE FROM admin_upgrade_coins i USING _del_pack_ids d WHERE i.upgrade_id = d.id;
DELETE FROM admin_upgrade_visibility i USING _del_pack_ids d WHERE i.upgrade_id = d.id;
DELETE FROM admin_upgrades a USING _del_pack_ids d WHERE a.id = d.id;

COMMIT;

-- rollback (ledger + packs): restore from *_bak_force_delete_20260910 if needed.
