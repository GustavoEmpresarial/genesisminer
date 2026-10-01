-- NFT Pool V3 consolidation — MIGRACAO DAS POSSES.
--   dry-run:  ./run.sh migrate-holdings.sql -v dry_run=1
--   aplicar:  ./run.sh migrate-holdings.sql -v dry_run=0
--
-- Converte incomum/raro/epico/lendario -> nft_pool_v3_comum, multiplicador = base_cost/10.
-- Ordem: desequipa da sala -> cunha N unidades SOLTAS (stock) -> tombstone das origens.
-- NAO reequipa (fica no inventario). Idempotente via marcador nft_pool_v3_migrations.
--
-- Autoritativo: player_asic_leases (+ item_instances espelho, mesmo uuid) + stock (qty solta)
-- + rack_slots (equipado). player_machines = sync best-effort.
\set ON_ERROR_STOP on
\if :{?dry_run}
\else
  \echo 'ERRO: passe -v dry_run=1 (teste) ou -v dry_run=0 (aplicar)'
  \q
\endif
\timing on

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';
SELECT set_config('nftv3.dry_run', :'dry_run', true);

DO $mig$
DECLARE
  c_dry          boolean := current_setting('nftv3.dry_run', true) = '1';
  c_now_ms       bigint := (extract(epoch from now())*1000)::bigint;
  c_four_years   bigint := 126144000000;   -- ms; sentinela expires_at das leases permanentes
  v_applied      boolean := false;
  v_src_leases   int;
  v_units        int;
  v_users        int;
  v_unequipped   int;
  v_stock_groups int;
  v_tomb_leases  int;
  v_tomb_inst    int;
  v_pm_tomb      int;
BEGIN
  IF to_regclass('public.nft_pool_v3_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM nft_pool_v3_migrations WHERE key=$1)'
      INTO v_applied USING 'nft_pool_v3_consolidation_v1';
    IF v_applied THEN
      RAISE EXCEPTION 'ja aplicado (marcador nft_pool_v3_consolidation_v1 existe) — abortando';
    END IF;
  END IF;

  -- pre-flight: os 4 tiers precisam estar retirados (Estagio 1) — no dry-run vira aviso
  IF EXISTS (SELECT 1 FROM upgrades
             WHERE id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
               AND (is_active <> 0 OR status <> 'retired')) THEN
    IF c_dry THEN
      RAISE WARNING 'pre-flight: tiers ainda ativos (ok num dry-run; Estagio 1 obrigatorio antes do apply)';
    ELSE
      RAISE EXCEPTION 'pre-flight: algum tier ainda ativo/nao-retired — rode o Estagio 1 antes';
    END IF;
  END IF;

  -- pre-flight: backup existe
  IF to_regclass('public.player_asic_leases_bak_nftv3') IS NULL THEN
    RAISE EXCEPTION 'pre-flight: rode backup.sql antes (necessario ate no dry-run p/ o diff)';
  END IF;

  -- ------------------------------------------------------------------
  -- working set: 1 linha por unidade comum a cunhar
  -- ------------------------------------------------------------------
  CREATE TEMP TABLE _wk_new ON COMMIT DROP AS
  SELECT gen_random_uuid() AS new_id,
         l.id              AS src_lease_id,
         l.user_id,
         l.item_id         AS src_item,
         (u.base_cost/10)::int AS mult,
         l.acquired_at
  FROM player_asic_leases l
  JOIN upgrades u ON u.id = l.item_id
  CROSS JOIN generate_series(1, (u.base_cost/10)::int) g
  WHERE l.item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
    AND l.status IN ('stock','equipped');

  SELECT count(DISTINCT src_lease_id), count(*), count(DISTINCT user_id)
    INTO v_src_leases, v_units, v_users FROM _wk_new;
  RAISE NOTICE 'working set: % leases origem -> % unidades comuns, % usuarios', v_src_leases, v_units, v_users;

  -- mapa persistente src->new (para rollback e auditoria)
  CREATE TABLE IF NOT EXISTS nft_pool_v3_mint_map (
    new_id uuid PRIMARY KEY, src_lease_id uuid NOT NULL, user_id int NOT NULL,
    src_item text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
  INSERT INTO nft_pool_v3_mint_map (new_id, src_lease_id, user_id, src_item)
  SELECT new_id, src_lease_id, user_id, src_item FROM _wk_new;

  -- ------------------------------------------------------------------
  -- (a) DESEQUIPAR da sala NFT.
  --     rack_slots: DELETE da linha (nao NULL!). O worker yield_tick.rs:177 le
  --     machine_item_id como String nao-nula e paniqueia com NULL; o unequip real
  --     do app apaga a linha (rack_slots count == equipados no levantamento).
  -- ------------------------------------------------------------------
  DELETE FROM rack_slots
   WHERE machine_item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario');
  GET DIAGNOSTICS v_unequipped = ROW_COUNT;

  UPDATE player_asic_leases SET status='stock', rack_id=NULL, slot_index=NULL
   WHERE item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
     AND status='equipped';
  UPDATE item_instances SET status='stock', rack_id=NULL, slot_index=NULL
   WHERE catalog_item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
     AND status='equipped';
  UPDATE player_machines SET location='INVENTORY', rack_id=NULL, slot_index=NULL, version=version+1
   WHERE catalog_item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
     AND location='EQUIPPED';

  -- ------------------------------------------------------------------
  -- (b) CUNHAR unidades comuns SOLTAS (lease + instance com o MESMO uuid)
  -- ------------------------------------------------------------------
  INSERT INTO player_asic_leases (id,user_id,item_id,acquired_at,expires_at,status,rack_id,slot_index)
  SELECT new_id, user_id, 'nft_pool_v3_comum',
         COALESCE(acquired_at, c_now_ms),
         COALESCE(acquired_at, c_now_ms) + c_four_years,
         'stock', NULL, NULL
  FROM _wk_new;

  INSERT INTO item_instances (id, code, catalog_item_id, user_id, status, rack_id, slot_index, created_at)
  SELECT new_id, 'nft_pool_v3_comum:' || new_id::text, 'nft_pool_v3_comum', user_id, 'stock', NULL, NULL,
         to_timestamp(COALESCE(acquired_at, c_now_ms)/1000.0)
  FROM _wk_new;

  INSERT INTO player_machines (id,user_id,catalog_item_id,location,rack_id,slot_index,version,expires_at,acquired_at,legacy_lease_id)
  SELECT new_id, user_id, 'nft_pool_v3_comum','INVENTORY',NULL,NULL,1,
         COALESCE(acquired_at, c_now_ms) + c_four_years, COALESCE(acquired_at, c_now_ms), new_id
  FROM _wk_new;

  -- ------------------------------------------------------------------
  -- (c) stock (fonte da tela de inventario): += unidades cunhadas por usuario
  -- ------------------------------------------------------------------
  INSERT INTO stock (user_id, item_id, qty)
  SELECT user_id, 'nft_pool_v3_comum', count(*)::int   -- _wk_new ja e 1 linha/unidade
  FROM _wk_new GROUP BY user_id
  ON CONFLICT (user_id, item_id) DO UPDATE SET qty = stock.qty + EXCLUDED.qty;
  GET DIAGNOSTICS v_stock_groups = ROW_COUNT;

  DELETE FROM stock WHERE item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario');

  -- ------------------------------------------------------------------
  -- (d) TOMBSTONE das origens
  -- ------------------------------------------------------------------
  UPDATE player_asic_leases SET status='expired'
   WHERE item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
     AND status IN ('stock','equipped');
  GET DIAGNOSTICS v_tomb_leases = ROW_COUNT;

  UPDATE item_instances SET status='consumed'
   WHERE catalog_item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
     AND status <> 'consumed';
  GET DIAGNOSTICS v_tomb_inst = ROW_COUNT;

  UPDATE player_machines SET location='DESTROYED', version=version+1
   WHERE catalog_item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
     AND location <> 'DESTROYED';
  GET DIAGNOSTICS v_pm_tomb = ROW_COUNT;

  -- ------------------------------------------------------------------
  -- (e) marcador de idempotencia
  -- ------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS nft_pool_v3_migrations (key text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), meta jsonb);
  INSERT INTO nft_pool_v3_migrations (key, meta) VALUES (
    'nft_pool_v3_consolidation_v1',
    jsonb_build_object('src_leases',v_src_leases,'units_minted',v_units,'users',v_users,
                       'unequipped_slots',v_unequipped,'tomb_leases',v_tomb_leases,
                       'tomb_instances',v_tomb_inst,'pm_tombstoned',v_pm_tomb,'now_ms',c_now_ms));

  RAISE NOTICE 'DONE: units=% users=% unequipped=% tomb_leases=% tomb_inst=% pm_tomb=% stock_groups=%',
    v_units, v_users, v_unequipped, v_tomb_leases, v_tomb_inst, v_pm_tomb, v_stock_groups;

  IF v_units <> 564 THEN
    RAISE WARNING 'esperava 564 unidades, obteve % — CONFIRA antes de commitar', v_units;
  END IF;
END $mig$;

-- ---- diff por usuario (dentro da TX) ----
\echo ''
\echo '==== DIFF por usuario: comum ANTES (bak) x DEPOIS (vivo) ===='
WITH ids(id,mult) AS (VALUES
  ('nft_pool_v3_incomum',1),('nft_pool_v3_raro',2),('nft_pool_v3_epico',4),('nft_pool_v3_lendario',10)),
bak AS (
  SELECT user_id, sum((SELECT mult FROM ids WHERE id=b.item_id))::int AS esperado_delta
  FROM player_asic_leases_bak_nftv3 b
  WHERE b.item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
    AND b.status IN ('stock','equipped')
  GROUP BY user_id),
comum_antes AS (
  SELECT user_id, count(*) FILTER (WHERE status IN ('stock','equipped')) AS n
  FROM player_asic_leases_bak_nftv3 WHERE item_id='nft_pool_v3_comum' GROUP BY user_id),
comum_depois AS (
  SELECT user_id, count(*) FILTER (WHERE status IN ('stock','equipped')) AS n
  FROM player_asic_leases WHERE item_id='nft_pool_v3_comum' GROUP BY user_id)
SELECT b.user_id,
       COALESCE(ca.n,0) AS comum_antes,
       COALESCE(cd.n,0) AS comum_depois,
       COALESCE(cd.n,0) - COALESCE(ca.n,0) AS delta_real,
       b.esperado_delta,
       CASE WHEN COALESCE(cd.n,0) - COALESCE(ca.n,0) = b.esperado_delta THEN 'PASS' ELSE 'FAIL' END AS ok,
       (SELECT qty FROM stock s WHERE s.user_id=b.user_id AND s.item_id='nft_pool_v3_comum') AS stock_qty_depois,
       (SELECT count(*) FROM item_instances ii WHERE ii.user_id=b.user_id AND ii.catalog_item_id='nft_pool_v3_comum' AND ii.status='stock') AS ii_stock_depois
FROM bak b
LEFT JOIN comum_antes  ca ON ca.user_id=b.user_id
LEFT JOIN comum_depois cd ON cd.user_id=b.user_id
ORDER BY b.user_id;

\echo ''
\echo '==== sobrou alguma linha VIVA dos 4 tiers? (tudo 0 = PASS) ===='
SELECT 'leases_vivas'  AS o, count(*) FROM player_asic_leases
  WHERE item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
    AND status IN ('stock','equipped')
UNION ALL SELECT 'instances_vivas', count(*) FROM item_instances
  WHERE catalog_item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
    AND status NOT IN ('consumed')
UNION ALL SELECT 'stock_rows', count(*) FROM stock
  WHERE item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario')
UNION ALL SELECT 'rack_slots', count(*) FROM rack_slots
  WHERE machine_item_id IN ('nft_pool_v3_incomum','nft_pool_v3_raro','nft_pool_v3_epico','nft_pool_v3_lendario');

\if :dry_run
  \echo ''
  \echo '*********** DRY RUN — ROLLBACK ***********'
  ROLLBACK;
\else
  \echo ''
  \echo '*********** APPLY — COMMIT ***********'
  COMMIT;
\endif
