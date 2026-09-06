/**
 * POST /api/admin/recall-all-players-items — recolhe TODAS as instalações para `stock`.
 *
 * Semântica 1:1 de `legacy/backend/server.ts` (não usa o GET recall-scan nem os seus totais).
 *
 * Por tentativa (máx. 3): scan de `placed_racks` FORA da transação →
 * `callHardwareRecallAll` (um TX worker: credit + DELETE racks; fail-closed)
 * e sem SQL de stock/racks no Node. Scan de verificação (read-only).
 * Fail-closed: HTTP que falha aborta (não apaga racks).
 *
 * Contagem POST (diferente do scan): chassis só entra se `item_id` for truthy.
 * "Ainda instalado" = existência de linhas em `placed_racks`.
 *
 * Concorrência: o legado não trava. Dois POSTs em paralelo duplicariam `stock`.
 * Serializamos com `pg_advisory_lock` na MESMA sessão do client (não muda o SQL
 * de uma execução isolada; o segundo pedido espera e em geral vê "Tudo limpo").
 */
import type { Pool, PoolClient } from 'pg';
import { callHardwareRecallAll } from '../../../hardware/services/hardware-client.js';

export const RECALL_ALL_MAX_ATTEMPTS = 3;
export const RECALL_ALL_ADVISORY_LOCK_SQL =
  "SELECT pg_advisory_lock(hashtext('admin.recall-all-players-items'))";
export const RECALL_ALL_ADVISORY_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtext('admin.recall-all-players-items'))";

export type RecallAllReport = {
  steps: string[];
  finalStatus: 'pending' | 'success' | 'incomplete';
  totalItemsMoved: number;
  racksProcessed: number;
  retries: number;
};

export type RecallAllResult = {
  ok: boolean;
  report: RecallAllReport;
};

export type RecallAllThrown = {
  report: RecallAllReport;
};

export function emptyRecallAllReport(): RecallAllReport {
  return { steps: [], finalStatus: 'pending', totalItemsMoved: 0, racksProcessed: 0, retries: 0 };
}

export function isRecallAllThrown(err: unknown): err is Error & RecallAllThrown {
  return Boolean(err && typeof err === 'object' && 'report' in err && (err as RecallAllThrown).report);
}

type PlacedRackRow = {
  id: string;
  user_id: number;
  item_id: unknown;
  wiring_id: unknown;
  battery_id: unknown;
};

type RackMapEntry = { rackId: string; userId: number; components: unknown[] };

export function collectRackComponents(
  rack: Pick<PlacedRackRow, 'item_id' | 'wiring_id' | 'battery_id'>,
  slotItemIds: unknown[],
  multiplierItemIds: unknown[]
): unknown[] {
  const components: unknown[] = [];
  if (rack.item_id) components.push(rack.item_id);
  if (rack.wiring_id) components.push(rack.wiring_id);
  if (rack.battery_id) components.push(rack.battery_id);
  for (const id of slotItemIds) {
    if (id) components.push(id);
  }
  for (const id of multiplierItemIds) {
    if (id) components.push(id);
  }
  return components;
}

function groupItemIdsByRack(
  rows: Array<{ rack_id: string; item_id: unknown }>,
  rackOrder: string[]
): Map<string, unknown[]> {
  const lists = new Map<string, unknown[]>();
  for (const id of rackOrder) lists.set(id, []);
  for (const row of rows) {
    const list = lists.get(row.rack_id);
    if (list) list.push(row.item_id);
    else lists.set(row.rack_id, [row.item_id]);
  }
  return lists;
}

async function scanRigs(client: PoolClient): Promise<RackMapEntry[]> {
  const racks = await client.query(
    'SELECT id, user_id, item_id, wiring_id, battery_id FROM placed_racks'
  );
  const rows = racks.rows as PlacedRackRow[];
  if (rows.length === 0) return [];

  const rackIds = rows.map((r) => r.id);
  const slotRes = await client.query(
    'SELECT rack_id, machine_item_id AS item_id FROM rack_slots WHERE rack_id = ANY($1::text[])',
    [rackIds]
  );
  const multiRes = await client.query(
    'SELECT rack_id, multiplier_item_id AS item_id FROM rack_multiplier_slots WHERE rack_id = ANY($1::text[])',
    [rackIds]
  );

  const slotsByRack = groupItemIdsByRack(slotRes.rows as Array<{ rack_id: string; item_id: unknown }>, rackIds);
  const multiByRack = groupItemIdsByRack(multiRes.rows as Array<{ rack_id: string; item_id: unknown }>, rackIds);

  return rows.map((r) => ({
    rackId: r.id,
    userId: r.user_id,
    components: collectRackComponents(r, slotsByRack.get(r.id) || [], multiByRack.get(r.id) || [])
  }));
}

async function runRecallAttempt(
  _client: PoolClient,
  _currentMap: RackMapEntry[],
  report: RecallAllReport
): Promise<number> {
  const result = await callHardwareRecallAll();
  const itemsMoved = result.itemsMoved ?? 0;
  const racksProcessed = result.racksProcessed ?? 0;
  report.totalItemsMoved += itemsMoved;
  report.racksProcessed = Math.max(report.racksProcessed, racksProcessed);
  return itemsMoved;
}

export async function recallAllPlayersItems(pool: Pool): Promise<RecallAllResult> {
  const report = emptyRecallAllReport();
  const client = await pool.connect();
  try {
    await client.query(RECALL_ALL_ADVISORY_LOCK_SQL);
    try {
      console.log('[RecallAll] Iniciando processo robusto de recolhimento global...');
      let attempts = 0;
      let itemsStillInstalled = true;

      while (itemsStillInstalled && attempts < RECALL_ALL_MAX_ATTEMPTS) {
        attempts++;
        report.steps.push('Iniciando tentativa ' + attempts + '...');
        const currentMap = await scanRigs(client);

        if (currentMap.length === 0) {
          report.steps.push('Tudo limpo: Nenhum item instalado detectado.');
          itemsStillInstalled = false;
          break;
        }

        report.steps.push('Levantamento concluido: ' + currentMap.length + ' rigs identificadas.');

        const batchMoved = await runRecallAttempt(client, currentMap, report);
        report.steps.push('Tentativa ' + attempts + ': ' + batchMoved + ' itens movidos para estoque.');

        const verifyMap = await scanRigs(client);
        if (verifyMap.length === 0) {
          report.steps.push('Verificacao concluida: Todas as instalacoes foram removidas.');
          itemsStillInstalled = false;
        } else {
          report.steps.push(
            'Aviso: ' + verifyMap.length + ' instalacoes ainda detectadas após a tentativa ' + attempts + '.'
          );
          report.retries++;
        }
      }

      report.finalStatus = itemsStillInstalled ? 'incomplete' : 'success';
      report.steps.push(
        itemsStillInstalled
          ? 'Encerrado com itens pendentes após 3 tentativas.'
          : 'Finalizado com sucesso total e verificado.'
      );
      return { ok: report.finalStatus === 'success', report };
    } finally {
      try {
        await client.query(RECALL_ALL_ADVISORY_UNLOCK_SQL);
      } catch {
        /* unlock best-effort; o release da sessão liberta o lock */
      }
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    (err as Error & RecallAllThrown).report = report;
    throw err;
  } finally {
    client.release();
  }
}
