-- Natal 3 ficou no id aposentado `nft_pool_v3_incomum` (prefixo nft_).
-- O picker trata `nft_*` como colecionável e esconde a GPU nas salas normais.
-- Copia o catálogo vivo para `gpu_natal_3` e move só o estoque atual
-- (stock + leases/instances status stock + recompensas que ainda entregam o item).
-- Leases expired/consumed e o mint map do pool v3 ficam no id antigo.
-- 2026-10-06

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _natal ON COMMIT DROP AS
SELECT * FROM upgrades WHERE id = 'nft_pool_v3_incomum';

UPDATE _natal SET id = 'gpu_natal_3';

INSERT INTO upgrades
SELECT * FROM _natal;

INSERT INTO upgrade_compat_racks (upgrade_id, rack_id)
SELECT 'gpu_natal_3', rack_id
FROM upgrade_compat_racks
WHERE upgrade_id = 'nft_pool_v3_incomum';

UPDATE stock
SET item_id = 'gpu_natal_3'
WHERE item_id = 'nft_pool_v3_incomum';

UPDATE player_asic_leases
SET item_id = 'gpu_natal_3'
WHERE item_id = 'nft_pool_v3_incomum'
  AND status = 'stock';

UPDATE item_instances
SET catalog_item_id = 'gpu_natal_3',
    code = replace(code, 'nft_pool_v3_incomum:', 'gpu_natal_3:')
WHERE catalog_item_id = 'nft_pool_v3_incomum'
  AND status = 'stock';

UPDATE admin_upgrade_items
SET item_id = 'gpu_natal_3'
WHERE item_id = 'nft_pool_v3_incomum';

UPDATE loot_box_items
SET item_id = 'gpu_natal_3'
WHERE item_id = 'nft_pool_v3_incomum';

DELETE FROM upgrade_compat_racks
WHERE upgrade_id = 'nft_pool_v3_incomum';

UPDATE upgrades
SET is_active = 0,
    status = 'retired',
    name = 'POOL V3 INCOMUM'
WHERE id = 'nft_pool_v3_incomum';

UPDATE game_states gs
SET inventory_version = inventory_version + 1,
    server_updated_at = (extract(epoch from now()) * 1000)::bigint
FROM stock s
WHERE s.item_id = 'gpu_natal_3'
  AND gs.user_id = s.user_id;

UPDATE upgrades_catalog_meta
SET revision = revision + 1
WHERE id = 1;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM stock WHERE item_id = 'nft_pool_v3_incomum';
  IF n <> 0 THEN RAISE EXCEPTION 'stock ainda no id antigo: %', n; END IF;

  SELECT count(*) INTO n FROM stock WHERE item_id = 'gpu_natal_3';
  IF n <> 2 THEN RAISE EXCEPTION 'stock gpu_natal_3: esperado 2, veio %', n; END IF;

  SELECT coalesce(sum(qty), 0) INTO n FROM stock WHERE item_id = 'gpu_natal_3';
  IF n <> 7 THEN RAISE EXCEPTION 'qty gpu_natal_3: esperado 7, veio %', n; END IF;

  SELECT count(*) INTO n FROM player_asic_leases WHERE item_id = 'gpu_natal_3' AND status = 'stock';
  IF n <> 7 THEN RAISE EXCEPTION 'leases stock: esperado 7, veio %', n; END IF;

  SELECT count(*) INTO n FROM player_asic_leases WHERE item_id = 'nft_pool_v3_incomum' AND status = 'stock';
  IF n <> 0 THEN RAISE EXCEPTION 'leases stock no id antigo'; END IF;

  SELECT count(*) INTO n FROM player_asic_leases WHERE item_id = 'nft_pool_v3_incomum' AND status = 'expired';
  IF n <> 70 THEN RAISE EXCEPTION 'leases expired do pool mudaram: %', n; END IF;

  SELECT count(*) INTO n FROM item_instances WHERE catalog_item_id = 'gpu_natal_3' AND status = 'stock';
  IF n <> 7 THEN RAISE EXCEPTION 'instances stock: esperado 7, veio %', n; END IF;

  SELECT count(*) INTO n FROM upgrade_compat_racks WHERE upgrade_id = 'gpu_natal_3';
  IF n <> 12 THEN RAISE EXCEPTION 'compat racks: esperado 12, veio %', n; END IF;

  SELECT count(*) INTO n FROM upgrade_compat_racks WHERE upgrade_id = 'nft_pool_v3_incomum';
  IF n <> 0 THEN RAISE EXCEPTION 'compat ainda no id antigo'; END IF;

  SELECT count(*) INTO n
  FROM upgrades
  WHERE id = 'gpu_natal_3' AND name = 'Natal 3' AND category = 'GPU' AND is_active = 1;
  IF n <> 1 THEN RAISE EXCEPTION 'catalogo gpu_natal_3 invalido'; END IF;

  SELECT count(*) INTO n
  FROM upgrades
  WHERE id = 'nft_pool_v3_incomum' AND is_active = 0 AND status = 'retired';
  IF n <> 1 THEN RAISE EXCEPTION 'id antigo nao aposentado'; END IF;
END $$;

COMMIT;
