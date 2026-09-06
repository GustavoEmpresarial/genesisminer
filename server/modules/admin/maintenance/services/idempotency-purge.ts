/**
 * Expurgo de chaves de idempotência expiradas.
 *
 * As tabelas de idempotência existem para que um retry do cliente não aplique
 * a mesma operação duas vezes. Essa janela é de minutos — passados dias, a
 * linha só ocupa espaço. Sem rotina de limpeza, `game_servers_intent_idempotency`
 * cresceu até **3.2 GB, 62% da base de dados inteira**, com registos desde
 * Maio de 2026.
 *
 * Apaga em lotes para não segurar locks longos nem inchar o WAL: cada lote é a
 * sua própria transação, e o tick pára ao fim de `MAX_BATCHES_PER_TICK` mesmo
 * que ainda haja backlog — o tick seguinte continua de onde ficou.
 */
import pool from '../../../../core/database/pool.js';
import { log } from '../../../../core/ops/logger.js';
import { MS_PER_DAY } from '../../../../shared/utils/time.js';

/**
 * Retenção. Muito acima de qualquer janela de retry realista (minutos), mas
 * larga o suficiente para uma investigação de suporte a um pedido duplicado.
 */
export const IDEMPOTENCY_RETENTION_DAYS = 30;

/** Lote pequeno: cada DELETE é uma transação, não vale a pena segurar mais. */
export const IDEMPOTENCY_PURGE_BATCH = 5_000;

/** Tecto por tick, para o expurgo nunca competir com o tráfego de jogo. */
export const MAX_BATCHES_PER_TICK = 20;

/**
 * Tabelas a expurgar e a coluna de idade de cada uma. O tipo difere entre elas
 * — herança do schema legado — por isso a comparação é declarada por tabela em
 * vez de assumida.
 */
export type IdempotencyTable = {
  table: string;
  /** `timestamptz` compara com `now()`; `epoch_ms` compara com inteiro. */
  ageColumn: { name: string; kind: 'timestamptz' | 'epoch_ms' };
};

export const IDEMPOTENCY_TABLES: readonly IdempotencyTable[] = [
  { table: 'game_servers_intent_idempotency', ageColumn: { name: 'created_at', kind: 'timestamptz' } },
  { table: 'lucky_box_idempotency', ageColumn: { name: 'created_at', kind: 'timestamptz' } }
] as const;

/** Nomes vêm de constantes deste ficheiro, nunca de input — mas validar é barato. */
const SAFE_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

function assertSafeIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER_RE.test(name)) {
    throw new Error(`[idempotency-purge] identificador inválido: ${name}`);
  }
  return name;
}

/**
 * Só o que este expurgo precisa de um client. Declarar o mínimo (em vez de
 * `Pick<PoolClient,'query'>`) evita arrastar as sobrecargas do `pg` para quem
 * chama, e mantém a função testável com um duplo simples. `PoolClient` satisfaz
 * esta forma estruturalmente.
 */
export type PurgeQueryable = {
  query(sql: string, params: unknown[]): Promise<{ rowCount: number | null }>;
};

/**
 * Apaga um lote. Devolve quantas linhas saíram — 0 significa que não há mais
 * nada a expurgar nesta tabela.
 */
export async function purgeIdempotencyBatch(
  client: PurgeQueryable,
  spec: IdempotencyTable,
  retentionDays: number,
  batchSize: number
): Promise<number> {
  const table = assertSafeIdentifier(spec.table);
  const column = assertSafeIdentifier(spec.ageColumn.name);
  const cutoffCondition =
    spec.ageColumn.kind === 'timestamptz'
      ? `${column} < now() - ($1::int * interval '1 day')`
      : `${column} < (EXTRACT(epoch FROM now()) * 1000)::bigint - ($1::bigint * ${MS_PER_DAY})`;

  // `ctid` evita depender da forma da chave primária, que difere entre tabelas.
  const res = await client.query(
    `DELETE FROM ${table}
      WHERE ctid IN (
        SELECT ctid FROM ${table}
         WHERE ${cutoffCondition}
         LIMIT $2
      )`,
    [retentionDays, batchSize]
  );
  return res.rowCount ?? 0;
}

export type PurgeSummary = { table: string; deleted: number; exhausted: boolean };

/** Um tick: percorre as tabelas, em lotes, respeitando o tecto e o cancelamento. */
export async function runIdempotencyPurge(
  shouldStop: () => boolean = () => false,
  retentionDays: number = IDEMPOTENCY_RETENTION_DAYS
): Promise<PurgeSummary[]> {
  const summaries: PurgeSummary[] = [];

  for (const spec of IDEMPOTENCY_TABLES) {
    let deleted = 0;
    let exhausted = false;

    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
      if (shouldStop()) break;
      const client = await pool.connect();
      try {
        const n = await purgeIdempotencyBatch(client, spec, retentionDays, IDEMPOTENCY_PURGE_BATCH);
        deleted += n;
        if (n < IDEMPOTENCY_PURGE_BATCH) {
          exhausted = true;
          break;
        }
      } finally {
        client.release();
      }
    }

    summaries.push({ table: spec.table, deleted, exhausted });
  }

  const total = summaries.reduce((acc, s) => acc + s.deleted, 0);
  if (total > 0) {
    log.info('idempotency purged', {
      module: 'idempotency_purge',
      event: 'purged',
      retentionDays,
      total,
      tables: summaries
    });
  }
  return summaries;
}
