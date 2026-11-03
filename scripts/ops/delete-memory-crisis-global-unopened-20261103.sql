-- Remove orphan inventory boxes for deleted pack MEMORY CRISIS GLOBAL.
-- Upgrade id: 73ef0b0b-47c4-4f15-a9fd-10dd2525e977
-- Catalog pack already force-deleted 2026-09-10; unopened_boxes + inactive loot_boxes left.
-- Applied on prod 2026-11-03.
\set ON_ERROR_STOP on
BEGIN;

\set box_id 'upgrade_pkg_73ef0b0b-47c4-4f15-a9fd-10dd2525e977'

CREATE TABLE IF NOT EXISTS unopened_boxes_bak_memcrisis_20261103 AS
  SELECT * FROM unopened_boxes WHERE false;
CREATE TABLE IF NOT EXISTS loot_boxes_bak_memcrisis_20261103 AS
  SELECT * FROM loot_boxes WHERE false;
CREATE TABLE IF NOT EXISTS loot_box_items_bak_memcrisis_20261103 AS
  SELECT * FROM loot_box_items WHERE false;

INSERT INTO unopened_boxes_bak_memcrisis_20261103
SELECT ub.* FROM unopened_boxes ub
WHERE ub.box_id = :'box_id'
  AND NOT EXISTS (
    SELECT 1 FROM unopened_boxes_bak_memcrisis_20261103 b
    WHERE b.user_id = ub.user_id AND b.box_id = ub.box_id
  );

INSERT INTO loot_boxes_bak_memcrisis_20261103
SELECT lb.* FROM loot_boxes lb
WHERE lb.id = :'box_id'
  AND NOT EXISTS (SELECT 1 FROM loot_boxes_bak_memcrisis_20261103 b WHERE b.id = lb.id);

INSERT INTO loot_box_items_bak_memcrisis_20261103
SELECT i.* FROM loot_box_items i
WHERE i.box_id = :'box_id'
  AND NOT EXISTS (
    SELECT 1 FROM loot_box_items_bak_memcrisis_20261103 b WHERE b.id = i.id
  );

DELETE FROM unopened_boxes WHERE box_id = :'box_id';
DELETE FROM loot_box_items WHERE box_id = :'box_id';
DELETE FROM loot_boxes WHERE id = :'box_id';

COMMIT;
