import { describe, expect, it, vi } from 'vitest';
import {
  IDEMPOTENCY_RETENTION_DAYS,
  IDEMPOTENCY_TABLES,
  purgeIdempotencyBatch,
  type IdempotencyTable
} from '../../../../../server/modules/admin/maintenance/services/idempotency-purge.js';

type QueryEspiada = { sql: string; params: unknown[] };

function clienteFalso(rowCounts: number[]) {
  const chamadas: QueryEspiada[] = [];
  let i = 0;
  return {
    chamadas,
    client: {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        chamadas.push({ sql, params });
        const rowCount = rowCounts[i] ?? 0;
        i += 1;
        return { rowCount, rows: [] };
      })
    }
  };
}

const TABELA_TIMESTAMP: IdempotencyTable = {
  table: 'game_servers_intent_idempotency',
  ageColumn: { name: 'created_at', kind: 'timestamptz' }
};

const TABELA_EPOCH: IdempotencyTable = {
  table: 'tabela_epoch',
  ageColumn: { name: 'criado_em', kind: 'epoch_ms' }
};

const LOTE = 5000;
const RETENCAO = 30;

describe('admin/maintenance — idempotency-purge', () => {
  describe('configuração', () => {
    it('retenção é muito maior que qualquer janela de retry realista', () => {
      // Retry de cliente vive em minutos; a retenção existe para suporte.
      expect(IDEMPOTENCY_RETENTION_DAYS).toBeGreaterThanOrEqual(7);
    });

    it('cobre as tabelas de idempotência conhecidas', () => {
      const nomes = IDEMPOTENCY_TABLES.map((t) => t.table);
      expect(nomes).toContain('game_servers_intent_idempotency');
      expect(nomes).toContain('lucky_box_idempotency');
    });

    it('toda a tabela declara como medir a idade', () => {
      for (const t of IDEMPOTENCY_TABLES) {
        expect(t.ageColumn.name, `${t.table} sem coluna de idade`).toBeTruthy();
        expect(['timestamptz', 'epoch_ms']).toContain(t.ageColumn.kind);
      }
    });
  });

  describe('purgeIdempotencyBatch', () => {
    it('apaga só o que passou da retenção, em lote limitado', async () => {
      const { client, chamadas } = clienteFalso([LOTE]);
      const n = await purgeIdempotencyBatch(client, TABELA_TIMESTAMP, RETENCAO, LOTE);

      expect(n).toBe(LOTE);
      expect(chamadas).toHaveLength(1);
      const { sql, params } = chamadas[0]!;
      expect(sql).toContain('DELETE FROM game_servers_intent_idempotency');
      expect(sql).toContain('LIMIT $2');
      expect(params).toEqual([RETENCAO, LOTE]);
    });

    it('usa comparação de intervalo para colunas timestamptz', async () => {
      const { client, chamadas } = clienteFalso([0]);
      await purgeIdempotencyBatch(client, TABELA_TIMESTAMP, RETENCAO, LOTE);
      expect(chamadas[0]!.sql).toContain("now() - ($1::int * interval '1 day')");
    });

    it('usa comparação em milissegundos para colunas epoch', async () => {
      const { client, chamadas } = clienteFalso([0]);
      await purgeIdempotencyBatch(client, TABELA_EPOCH, RETENCAO, LOTE);
      const sql = chamadas[0]!.sql;
      expect(sql).toContain('EXTRACT(epoch FROM now()) * 1000');
      expect(sql).not.toContain('interval');
    });

    it('devolve 0 quando não há nada a expurgar (sinal de esgotado)', async () => {
      const { client } = clienteFalso([0]);
      expect(await purgeIdempotencyBatch(client, TABELA_TIMESTAMP, RETENCAO, LOTE)).toBe(0);
    });

    it('trata rowCount nulo do driver como 0', async () => {
      const client = { query: vi.fn(async () => ({ rowCount: null, rows: [] })) };
      expect(await purgeIdempotencyBatch(client, TABELA_TIMESTAMP, RETENCAO, LOTE)).toBe(0);
    });
  });

  describe('segurança de identificadores', () => {
    it('recusa nome de tabela que não seja identificador simples', async () => {
      const { client } = clienteFalso([0]);
      const malicioso: IdempotencyTable = {
        table: 'x; DROP TABLE users; --',
        ageColumn: { name: 'created_at', kind: 'timestamptz' }
      };
      await expect(purgeIdempotencyBatch(client, malicioso, RETENCAO, LOTE)).rejects.toThrow(/identificador inválido/);
      expect(client.query).not.toHaveBeenCalled();
    });

    it('recusa nome de coluna inválido', async () => {
      const { client } = clienteFalso([0]);
      const malicioso: IdempotencyTable = {
        table: 'tabela_ok',
        ageColumn: { name: 'created_at) OR true --', kind: 'timestamptz' }
      };
      await expect(purgeIdempotencyBatch(client, malicioso, RETENCAO, LOTE)).rejects.toThrow(/identificador inválido/);
      expect(client.query).not.toHaveBeenCalled();
    });

    it('as tabelas configuradas passam a validação', async () => {
      for (const t of IDEMPOTENCY_TABLES) {
        const { client } = clienteFalso([0]);
        await expect(purgeIdempotencyBatch(client, t, RETENCAO, LOTE)).resolves.toBe(0);
      }
    });
  });
});
