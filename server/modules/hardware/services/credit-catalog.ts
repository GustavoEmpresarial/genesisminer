/**
 * Credita itens de catálogo no inventário do jogador (sempre `stock` empilhável).
 * Usado por abertura de caixas e grants de pacotes.
 *
 * Baterias infinitas (ex.: Estelar, `power_capacity === -1`) também vão para `stock`
 * por qty — inventário jogável é stock-only; UUID só existe enquanto montado na rig.
 *
 * Sempre `callHardwareCredit` (worker faz UPSERT + leases). Fail-closed: sem URL ou
 * HTTP em erro → throw. Sem Prisma stock/leases/`item_instances` neste TX.
 */
import type { Prisma } from '@prisma/client';
import { callHardwareCredit } from './hardware-client.js';

export type CatalogCreditKind = 'stock' | 'skipped';

/**
 * Entrega `qty` unidades de `itemId` ao jogador em `stock` (upsert qty).
 * Se o item for máquina timed, o worker cria também `qty` leases em stock.
 * Fail-closed HTTP only — sem Prisma stock nem leases neste TX.
 */
export async function creditCatalogItemQtyInTx(
  _tx: Prisma.TransactionClient,
  userId: number,
  itemIdRaw: string,
  qtyRaw: number
): Promise<CatalogCreditKind> {
  const itemId = String(itemIdRaw || '').trim();
  const qty = Math.floor(Number(qtyRaw));
  if (!itemId || !Number.isFinite(qty) || qty <= 0) return 'skipped';

  await callHardwareCredit({ userId, itemId, qty });
  return 'stock';
}

/** Credita um mapa itemId → qty (abertura de caixa / grants). */
export async function creditCatalogItemsMapInTx(
  tx: Prisma.TransactionClient,
  userId: number,
  gainedItems: Record<string, number>
): Promise<{ stock: number }> {
  let stock = 0;
  for (const [id, qty] of Object.entries(gainedItems)) {
    const kind = await creditCatalogItemQtyInTx(tx, userId, id, qty);
    if (kind === 'stock') stock += 1;
  }
  return { stock };
}
