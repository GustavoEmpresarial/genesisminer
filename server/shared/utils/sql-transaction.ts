/**
 * Abstração de transação SQL que roda tanto sobre `pg.PoolClient` (conexão
 * direta via `node-postgres`) quanto sobre `Prisma.TransactionClient` —
 * permite que código de save-game/economia escrito uma vez funcione com os
 * dois back-ends enquanto a migração do projeto pra Prisma-only não termina
 * (ver `core/database/pool.ts` e `core/database/prisma.ts`).
 *
 * ⚠️ Dualidade intencional e temporária, não acidental: o dia em que todo o
 * projeto rodar só sobre Prisma, este arquivo deve encolher para só
 * `prismaSqlTx`/`prismaTxToPoolLikeClient` (removendo `pgSqlTx` e o tipo
 * `SqlTransaction` genérico). Ver docs/architecture/DECISIONS.md para o
 * estado atual da migração Prisma — não decidir isso aqui sem medir antes
 * quantos call-sites ainda dependem do `pg.PoolClient` bruto.
 *
 * Migrado de legacy/backend/lib/sqlTransaction.ts (sem mudança de comportamento).
 */
import type { PoolClient, QueryResult } from 'pg';
import type { Prisma } from '@prisma/client';

/**
 * Cliente só com `query(sql, params)` em texto — subconjunto do `PoolClient`
 * do `node-postgres` usado pelo save-game. Deliberadamente mais estreito que
 * `PoolClient.query` (que tem várias sobrecargas aceitando objeto de config,
 * `QueryConfig`, etc.) para que `prismaTxToPoolLikeClient` — que só
 * implementa a forma texto+params — seja atribuível a este tipo sem erro de
 * compatibilidade de sobrecarga.
 */
export type SaveGameQueryClient = {
  query(queryText: string, values?: unknown[]): Promise<QueryResult>;
};

/**
 * Interface comum para rodar SQL parametrizado dentro de uma transação,
 * independente do back-end por trás (`pg` puro ou Prisma).
 */
export type SqlTransaction = {
  /** SELECT: devolve as linhas tipadas como `T[]`. */
  queryRows<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]>;
  /** INSERT/UPDATE/DELETE: devolve o número de linhas afetadas. */
  execute(sql: string, params?: unknown[]): Promise<number>;
};

/** Implementação de {@link SqlTransaction} sobre um `PoolClient` de `pg` já
 *  dentro de uma transação (`BEGIN`/`COMMIT` geridos pelo chamador). */
export function pgSqlTx(client: PoolClient): SqlTransaction {
  return {
    async queryRows<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const result = await client.query(sql, params);
      return result.rows as unknown as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = await client.query(sql, params);
      return result.rowCount ?? 0;
    }
  };
}

/** Implementação de {@link SqlTransaction} sobre um `Prisma.TransactionClient`
 *  (dentro de `prisma.$transaction(...)`). Usa `$queryRawUnsafe`/
 *  `$executeRawUnsafe` porque o SQL vem como string já montada pelo
 *  chamador (mesmas queries que rodam sobre `pg` em {@link pgSqlTx}), não
 *  como tagged template — o SQL em si já é confiável (não vem de input do
 *  usuário sem parametrização; ver DECISIONS.md #25 sobre a política de
 *  `$queryRawUnsafe`/`$executeRawUnsafe` do projeto). */
export function prismaSqlTx(tx: Prisma.TransactionClient): SqlTransaction {
  return {
    async queryRows<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const rows = await tx.$queryRawUnsafe(sql, ...params);
      return (Array.isArray(rows) ? rows : []) as unknown as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      return tx.$executeRawUnsafe(sql, ...params);
    }
  };
}

/** Comandos de controle transacional: no-op aqui porque `prisma.$transaction`
 *  já gerencia `BEGIN`/`COMMIT`/`ROLLBACK` implicitamente ao redor do
 *  callback — o código de save-game emite esses comandos por compatibilidade
 *  com o caminho `pg` puro, e este client precisa engoli-los silenciosamente
 *  em vez de tentar executá-los como SQL (o que falharia: não são comandos
 *  válidos dentro de uma transação Prisma já aberta). */
const TRANSACTION_CONTROL_COMMANDS = new Set(['BEGIN', 'COMMIT', 'ROLLBACK']);

/**
 * Expõe uma interface `client.query(text, values)` no formato node-pg sobre
 * um `Prisma.TransactionClient`, para que o mesmo código de save-game
 * (mesmo SQL, mesma ordem de locks) rode sem duplicação nos dois back-ends.
 *
 * Comportamento por tipo de comando (detectado pela primeira palavra do SQL,
 * maiúsculas, após `trim`):
 * - `BEGIN`/`COMMIT`/`ROLLBACK` → no-op, devolve resultado vazio (ver
 *   {@link TRANSACTION_CONTROL_COMMANDS}).
 * - `SELECT`/`WITH`/`SHOW`/`EXPLAIN`/`TABLE` → tratado como leitura,
 *   devolve `rows` populado e `rowCount = rows.length`.
 * - Qualquer outro (INSERT/UPDATE/DELETE/...) → tratado como escrita,
 *   devolve `rows: []` e `rowCount` = linhas afetadas.
 *
 * O `QueryResult` devolvido é parcialmente sintético (campos `command`/
 * `oid`/`fields` são placeholders, não refletem o resultado real do Postgres)
 * — suficiente para o que o save-game lê (`rows`/`rowCount`), não uma
 * implementação completa de `QueryResult`.
 */
export function prismaTxToPoolLikeClient(tx: Prisma.TransactionClient): SaveGameQueryClient {
  const run = prismaSqlTx(tx);
  return {
    async query(queryText: string, values?: unknown[]): Promise<QueryResult> {
      const trimmed = queryText.trim();
      const firstWord = trimmed.split(/\s+/)[0]?.toUpperCase() ?? '';

      if (TRANSACTION_CONTROL_COMMANDS.has(firstWord)) {
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as unknown as QueryResult;
      }

      const READ_COMMANDS = new Set(['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'TABLE']);
      if (READ_COMMANDS.has(firstWord)) {
        const rows = await run.queryRows(trimmed, values ?? []);
        return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as unknown as QueryResult;
      }

      const affectedRowCount = await run.execute(trimmed, values ?? []);
      return { rows: [], rowCount: affectedRowCount, command: 'UPDATE', oid: 0, fields: [] } as unknown as QueryResult;
    }
  };
}
