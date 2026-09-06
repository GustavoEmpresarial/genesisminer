/**
 * Gestão admin do catálogo de caixas (`loot_boxes`/`loot_box_items`) — cria/actualiza
 * em lote (painel admin) e apaga em cascata. Leitura/consumo pelo jogador já
 * migrado em `modules/lucky-boxes/`; aqui só a escrita administrativa.
 *
 * Migrado de legacy/backend/controllers/lootBoxController.ts
 * (`registerLootBoxAdminRoutes`) + legacy/backend/models/lootBoxModel.ts
 * (`parseLootBoxId`, `isLootBoxBrokenForSafeDelete`, `deleteLootBoxCascade`).
 */
import { prisma } from '../../../../core/database/prisma.js';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import { prismaSqlTx, type SqlTransaction } from '../../../../shared/utils/sql-transaction.js';
import { parseLootBoxId } from '../../../lucky-boxes/services/validation.js';

export { parseLootBoxId };

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const TX_TIMEOUT_MS = 60_000;
const TX_MAX_WAIT_MS = 10_000;
const DEFAULT_MIN_MAX_QTY = 1;
const DEFAULT_ICON = '🎁';

const txOpts = { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS } as const;

export async function isLootBoxBrokenForSafeDelete(sql: SqlTransaction, boxId: string): Promise<boolean> {
  const rows = await sql.queryRows<{ n: number; w: number }>(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(GREATEST(0, probability::double precision)), 0)::double precision AS w
     FROM loot_box_items WHERE box_id = $1`,
    [boxId]
  );
  const row = rows[0];
  if (!row) return true;
  return row.n === 0 || row.w <= 0;
}

export type LootBoxDeleteSummary = {
  lootBoxItemsRemoved: number;
  unopenedBoxesRows: number;
  playerClaimedRows: number;
  adminUpgradeBoxesRows: number;
  promoCodesCleared: number;
  referralModelsSenderCleared: number;
  referralModelsReceiverCleared: number;
  lootBoxesRemoved: number;
};

/**
 * Apaga a caixa e referências conhecidas (transação activa no `sql`).
 * Ordem respeita FK `loot_box_items` → `loot_boxes` e limpa inventários / promo / referral.
 */
export async function deleteLootBoxCascade(sql: SqlTransaction, boxId: string): Promise<LootBoxDeleteSummary> {
  const lootBoxItemsRemoved = await sql.execute('DELETE FROM loot_box_items WHERE box_id = $1', [boxId]);
  const unopenedBoxesRows = await sql.execute('DELETE FROM unopened_boxes WHERE box_id = $1', [boxId]);
  const playerClaimedRows = await sql.execute('DELETE FROM player_claimed_boxes WHERE box_id = $1', [boxId]);
  const adminUpgradeBoxesRows = await sql.execute('DELETE FROM admin_upgrade_boxes WHERE box_id = $1', [boxId]);
  const promoCodesCleared = await sql.execute('UPDATE promo_codes SET loot_box_id = NULL WHERE loot_box_id = $1', [boxId]);
  const referralModelsSenderCleared = await sql.execute(
    'UPDATE referral_models SET sender_loot_box_id = NULL WHERE sender_loot_box_id = $1',
    [boxId]
  );
  const referralModelsReceiverCleared = await sql.execute(
    'UPDATE referral_models SET receiver_loot_box_id = NULL WHERE receiver_loot_box_id = $1',
    [boxId]
  );
  const lootBoxesRemoved = await sql.execute('DELETE FROM loot_boxes WHERE id = $1', [boxId]);

  return {
    lootBoxItemsRemoved,
    unopenedBoxesRows,
    playerClaimedRows,
    adminUpgradeBoxesRows,
    promoCodesCleared,
    referralModelsSenderCleared,
    referralModelsReceiverCleared,
    lootBoxesRemoved
  };
}

type IncomingLootBoxItem = {
  id?: string;
  type?: string;
  minQty?: number;
  maxQty?: number;
  probability?: number;
};

type IncomingLootBox = {
  id: string;
  name: string;
  description?: string;
  price?: number;
  trigger?: string;
  icon?: string;
  isActive?: boolean;
  items?: IncomingLootBoxItem[];
  clearItems?: unknown;
};

const TRIGGERS_WITHOUT_ITEM_LIST = new Set(['roleta_code']);
const SHOP_TRIGGERS = new Set(['shop', 'shop_once', 'special']);

/**
 * Upsert em lote do catálogo de caixas (painel admin); antes em `pg` + `BEGIN` no server.
 * `replaceCatalog: true` desactiva qualquer caixa fora do payload (o painel envia o catálogo todo).
 */
export async function upsertLootBoxCatalog(boxes: IncomingLootBox[], replaceCatalog: boolean): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const validBoxes = boxes.filter((b) => b && b.id && typeof b.name === 'string' && String(b.name).trim());
    const validIncomingIds = validBoxes.map((b) => String(b.id));

    const outWarnings: string[] = [];

    /**
     * Snapshot dos `loot_box_items` actuais por caixa (apenas para as caixas neste payload)
     * — usado para decidir se a caixa pode ficar `is_active` mesmo quando o payload tem
     * `items: []` (cache/lazy state). Se já tiver prémios em DB, não coage a inactiva.
     */
    const currentItemCountByBoxId = new Map<string, number>();
    if (validIncomingIds.length > 0) {
      const grouped = await tx.loot_box_items.groupBy({
        by: ['box_id'],
        where: { box_id: { in: validIncomingIds } },
        _count: { _all: true }
      });
      for (const row of grouped) {
        currentItemCountByBoxId.set(String(row.box_id), Number(row._count?._all ?? 0));
      }
    }

    type NormalizedBox = { b: IncomingLootBox; effectiveActive: boolean };
    const normalized: NormalizedBox[] = [];

    for (const b of validBoxes) {
      let effectiveActive = b.isActive !== false;
      const trig = String(b.trigger || 'shop');
      const nItemsPayload = Array.isArray(b.items) ? b.items.filter((it) => it && String(it.id ?? '').trim()).length : 0;
      const nItemsDb = currentItemCountByBoxId.get(String(b.id)) ?? 0;
      const nItemsEffective = nItemsPayload > 0 ? nItemsPayload : nItemsDb;

      /**
       * Antes: 400 se `isActive` sem linhas em `loot_box_items` — com `replaceCatalog: true`
       * o painel envia todo o catálogo; uma única caixa inconsistente (cache, payload
       * parcial, rascunho antigo) bloqueava o save de todas.
       * Agora: coerção segura só se activa, não é gatilho exempto, e não há prémios
       * (nem payload nem DB) — combinado com preserve-on-empty abaixo, evita falso positivo.
       */
      if (effectiveActive && !TRIGGERS_WITHOUT_ITEM_LIST.has(trig) && nItemsEffective === 0) {
        effectiveActive = false;
        const msg = `Caixa "${String(b.name).trim()}" (${String(b.id)}): activa mas sem prémios — gravada como inactiva (rascunho). Adicione prémios e reactive.`;
        outWarnings.push(msg);
        console.warn(`[POST /api/admin/loot-boxes] ${msg}`);
      }

      if (effectiveActive && SHOP_TRIGGERS.has(trig)) {
        const p = Number(b.price);
        if (!Number.isFinite(p) || p <= 0) {
          throw new HttpControlledError(HTTP_BAD_REQUEST, {
            error: `Caixa "${String(b.name).trim()}" (${b.id}): preço USDC inválido para venda na loja (use número > 0).`
          });
        }
      }
      normalized.push({ b, effectiveActive });
    }

    /**
     * Estratégia post-fix (legado b3fb57e + restore 20260517100000):
     *   - Nunca apaga `loot_box_items` às cegas; o painel envia o catálogo todo e
     *     qualquer caixa cujo estado React tinha `items: []` (cache/lazy-load/edição
     *     parcial) fazia o backend apagar prémios reais.
     *   - `clearItems: true` (opt-in) → wipe explícito, depois insere o que vier.
     *   - Items com >= 1 entrada válida → DELETE + INSERT (substitui).
     *   - Items vazio/missing → preserva o que já está em DB.
     */
    for (const { b, effectiveActive } of normalized) {
      const id = String(b.id);
      await tx.loot_boxes.upsert({
        where: { id },
        create: {
          id,
          name: b.name.trim(),
          description: String(b.description ?? ''),
          price: Number(b.price) || 0,
          trigger: String(b.trigger || 'shop'),
          icon: String(b.icon || DEFAULT_ICON),
          is_active: effectiveActive ? 1 : 0
        },
        update: {
          name: b.name.trim(),
          description: String(b.description ?? ''),
          price: Number(b.price) || 0,
          trigger: String(b.trigger || 'shop'),
          icon: String(b.icon || DEFAULT_ICON),
          is_active: effectiveActive ? 1 : 0
        }
      });

      const incomingRows = Array.isArray(b.items)
        ? b.items
            .filter((it): it is IncomingLootBoxItem & { id: string } => !!(it && String(it.id ?? '').trim()))
            .map((it) => ({
              box_id: id,
              item_type: String(it.type || 'item'),
              item_id: String(it.id),
              min_qty: Math.floor(Number(it.minQty) || DEFAULT_MIN_MAX_QTY),
              max_qty: Math.floor(Number(it.maxQty) || DEFAULT_MIN_MAX_QTY),
              probability: Number(it.probability) || 0
            }))
        : [];

      const explicitClear = b.clearItems === true;

      if (incomingRows.length > 0) {
        await tx.loot_box_items.deleteMany({ where: { box_id: id } });
        await tx.loot_box_items.createMany({ data: incomingRows });
      } else if (explicitClear) {
        await tx.loot_box_items.deleteMany({ where: { box_id: id } });
      }
    }

    if (replaceCatalog) {
      if (boxes.length === 0) {
        await tx.loot_boxes.updateMany({ data: { is_active: 0 } });
      } else if (validIncomingIds.length > 0) {
        await tx.loot_boxes.updateMany({ where: { id: { notIn: validIncomingIds } }, data: { is_active: 0 } });
      }
    }

    return outWarnings;
  }, txOpts);
}

export async function deleteLootBoxAdmin(boxId: string, brokenOnly: boolean): Promise<{ boxName: string; summary: LootBoxDeleteSummary }> {
  return prisma.$transaction(async (tx) => {
    const sql = prismaSqlTx(tx);
    const exists = await sql.queryRows<{ id: string; name: string }>('SELECT id, name FROM loot_boxes WHERE id = $1', [boxId]);
    if (exists.length === 0) {
      throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'Caixa não encontrada.' });
    }
    const name = exists[0]!.name;
    if (brokenOnly) {
      const broken = await isLootBoxBrokenForSafeDelete(sql, boxId);
      if (!broken) {
        throw new HttpControlledError(HTTP_CONFLICT, {
          error: 'A caixa ainda tem itens com probabilidade > 0. Remova brokenOnly=1 para apagar à força, ou zere as probabilidades no editor.'
        });
      }
    }
    const summary = await deleteLootBoxCascade(sql, boxId);
    return { boxName: name, summary };
  }, txOpts);
}
