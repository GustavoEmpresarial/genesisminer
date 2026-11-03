-- JulyaEmilly (#8415 / bernardesthayssa83@gmail.com)
-- 21 stock rows with UUID catalog keys (fora do catálogo / unknownCatalog)
-- had no upgrades name in any bak. Pattern = leaked instance ids in stock.
-- Convert 1:1 → battery_estelar (canonical infinite battery).
-- Applied on prod 2026-11-03. Backup: stock_bak_orphan_julya_20261103.
\set ON_ERROR_STOP on
BEGIN;
-- (see applied statements in agent session / inventory_movements admin_compensate
--  ops=20261103-julya-orphan-uuid-to-estelar)
COMMIT;
