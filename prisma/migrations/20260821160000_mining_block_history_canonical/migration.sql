-- PLANO 3: histórico canónico 1 row por (user_id, coin_id, window_start_ms, window_end_ms).
-- Consolida legado (SUM amounts/hash) sem alterar a economia já creditada em coin_balances.
-- Só corre se a tabela existir (DDL legado / não no schema.prisma).

DO $$
BEGIN
  IF to_regclass('public.mining_block_history') IS NULL THEN
    RAISE NOTICE 'mining_block_history ausente — skip P3';
    RETURN;
  END IF;

  -- Já consolidado?
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'mining_block_history_user_coin_window_uidx'
  ) THEN
    RAISE NOTICE 'mining_block_history já tem unique canónica — skip';
    RETURN;
  END IF;

  CREATE TABLE mining_block_history_p3_canonical (
    LIKE mining_block_history INCLUDING DEFAULTS
  );

  INSERT INTO mining_block_history_p3_canonical (
    id, user_id, coin_id, room_id, window_start_ms, window_end_ms, credit_blocks,
    amount_coins, amount_usd, user_hash_hps, network_hashrate, block_reward, block_time, created_at
  )
  SELECT
    MIN(id) AS id,
    user_id,
    coin_id,
    CASE
      WHEN COUNT(DISTINCT NULLIF(BTRIM(COALESCE(room_id, '')), '')) = 1
        THEN MAX(NULLIF(BTRIM(COALESCE(room_id, '')), ''))
      ELSE NULL
    END AS room_id,
    window_start_ms,
    window_end_ms,
    MAX(credit_blocks) AS credit_blocks,
    SUM(amount_coins) AS amount_coins,
    SUM(amount_usd) AS amount_usd,
    SUM(user_hash_hps) AS user_hash_hps,
    MAX(network_hashrate) AS network_hashrate,
    MAX(block_reward) AS block_reward,
    MAX(block_time) AS block_time,
    MAX(created_at) AS created_at
  FROM mining_block_history
  GROUP BY user_id, coin_id, window_start_ms, window_end_ms;

  -- Invariante: soma economica preservada.
  -- double precision nao e associativo; tolerar epsilon absoluto minimo.
  IF abs(
    (SELECT COALESCE(SUM(amount_coins), 0) FROM mining_block_history)
    - (SELECT COALESCE(SUM(amount_coins), 0) FROM mining_block_history_p3_canonical)
  ) > 1e-6 THEN
    RAISE EXCEPTION 'P3 consolidate: SUM(amount_coins) mismatch — abort (delta>1e-6)';
  END IF;

  ALTER TABLE mining_block_history DROP CONSTRAINT IF EXISTS mining_block_history_user_id_fkey;
  ALTER TABLE mining_block_history RENAME TO mining_block_history_pre_p3;
  ALTER TABLE mining_block_history_p3_canonical RENAME TO mining_block_history;

  -- Sequence fica OWNED BY a tabela antiga apos RENAME; reatribuir a canónica.
  ALTER SEQUENCE mining_block_history_id_seq OWNED BY mining_block_history.id;

  -- Nomes de índices sao globais no schema — libertar antes de recriar na canónica.
  ALTER INDEX mining_block_history_pkey RENAME TO mining_block_history_pre_p3_pkey;
  ALTER INDEX idx_mining_block_history_user_time RENAME TO mining_block_history_pre_p3_user_time;
  ALTER INDEX idx_mining_block_history_user_coin_time RENAME TO mining_block_history_pre_p3_user_coin_time;
  ALTER INDEX idx_mining_block_history_window_end RENAME TO mining_block_history_pre_p3_window_end;
  ALTER INDEX idx_mining_block_history_coin_window RENAME TO mining_block_history_pre_p3_coin_window;

  ALTER TABLE mining_block_history
    ADD CONSTRAINT mining_block_history_pkey PRIMARY KEY (id);

  ALTER TABLE mining_block_history
    ADD CONSTRAINT mining_block_history_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

  CREATE UNIQUE INDEX mining_block_history_user_coin_window_uidx
    ON mining_block_history (user_id, coin_id, window_start_ms, window_end_ms);

  CREATE INDEX idx_mining_block_history_user_time
    ON mining_block_history (user_id, window_end_ms DESC);
  CREATE INDEX idx_mining_block_history_user_coin_time
    ON mining_block_history (user_id, coin_id, window_end_ms DESC);
  CREATE INDEX idx_mining_block_history_window_end
    ON mining_block_history (window_end_ms DESC);
  CREATE INDEX idx_mining_block_history_coin_window
    ON mining_block_history (coin_id, window_end_ms DESC);

  PERFORM setval(
    pg_get_serial_sequence('mining_block_history', 'id'),
    COALESCE((SELECT MAX(id) FROM mining_block_history), 1),
    true
  );

  DROP TABLE mining_block_history_pre_p3;
END $$;
