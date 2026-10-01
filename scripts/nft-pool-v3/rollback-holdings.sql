-- NFT Pool V3 consolidation — ROLLBACK pos-commit da migracao das posses.
-- Requer: *_bak_nftv3 (backup.sql) + nft_pool_v3_mint_map (criado no apply).
-- NAO desfaz o Estagio 1 (catalogo) nem o Estagio 3 (block_reward) — ver README.
\set ON_ERROR_STOP on
\timing on
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $rb$
DECLARE v_del_leases int; v_del_inst int; v_del_pm int; v_restored int;
BEGIN
  IF to_regclass('public.nft_pool_v3_mint_map') IS NULL
     OR to_regclass('public.player_asic_leases_bak_nftv3') IS NULL THEN
    RAISE EXCEPTION 'faltam nft_pool_v3_mint_map e/ou *_bak_nftv3';
  END IF;

  -- 1) apagar as unidades cunhadas (id no mint_map)
  DELETE FROM item_instances     WHERE id IN (SELECT new_id FROM nft_pool_v3_mint_map);
  GET DIAGNOSTICS v_del_inst = ROW_COUNT;
  DELETE FROM player_machines    WHERE id IN (SELECT new_id FROM nft_pool_v3_mint_map);
  GET DIAGNOSTICS v_del_pm = ROW_COUNT;
  DELETE FROM player_asic_leases WHERE id IN (SELECT new_id FROM nft_pool_v3_mint_map);
  GET DIAGNOSTICS v_del_leases = ROW_COUNT;

  -- 2) tirar do stock.qty a soma cunhada por usuario; apagar linha se zerar/negativar
  UPDATE stock s SET qty = s.qty - m.n
  FROM (SELECT user_id, count(*)::int n FROM nft_pool_v3_mint_map GROUP BY user_id) m
  WHERE s.user_id=m.user_id AND s.item_id='nft_pool_v3_comum';
  DELETE FROM stock WHERE item_id='nft_pool_v3_comum' AND qty <= 0;

  -- 3) restaurar as linhas dos 4 tiers a partir do backup
  DELETE FROM player_asic_leases WHERE item_id IN
    ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario');
  INSERT INTO player_asic_leases SELECT * FROM player_asic_leases_bak_nftv3
   WHERE item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario');
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  DELETE FROM item_instances WHERE catalog_item_id IN
    ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario');
  INSERT INTO item_instances SELECT * FROM item_instances_bak_nftv3
   WHERE catalog_item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario');

  DELETE FROM stock WHERE item_id IN
    ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario');
  INSERT INTO stock SELECT * FROM stock_bak_nftv3
   WHERE item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario');

  -- rack_slots: as linhas dos equipados foram DELETADAS na migracao -> re-INSERIR do backup
  DELETE FROM rack_slots rs USING rack_slots_bak_nftv3 b
   WHERE rs.rack_id=b.rack_id AND rs.slot_index=b.slot_index;
  INSERT INTO rack_slots (rack_id, slot_index, machine_item_id, machine_lease_id)
  SELECT rack_id, slot_index, machine_item_id, machine_lease_id FROM rack_slots_bak_nftv3;

  -- player_machines: restaurar linhas dos 4 tiers do backup
  DELETE FROM player_machines WHERE catalog_item_id IN
    ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario');
  INSERT INTO player_machines SELECT * FROM player_machines_bak_nftv3
   WHERE catalog_item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario');

  -- 4) limpar marcador + mapa
  DELETE FROM nft_pool_v3_migrations WHERE key='nft_pool_v3_consolidation_v1';
  DROP TABLE nft_pool_v3_mint_map;

  RAISE NOTICE 'rollback: del_leases=% del_inst=% del_pm=% restored_leases=%',
    v_del_leases, v_del_inst, v_del_pm, v_restored;
END $rb$;

\echo 'revise com: ./run.sh survey.sql -v phase=final   (deve voltar ao estado inicial)'
COMMIT;
