/**
 * Migrado de legacy/backend/models/roletaModel.ts — as queries/consultas de
 * prémios (elegíveis pro sorteio real, filtradas por `tier`) e o sorteio
 * ponderado. `fetchWheelPrizesForAdminWheelEditor` (catálogo completo, sem
 * filtro de tier) vive em `./admin.ts` — editor admin, não sorteio.
 */
import { Prisma } from '@prisma/client';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';

const HTTP_INTERNAL_SERVER_ERROR = 500;

export type WheelPrizeRow = {
  id: string;
  label: string;
  weight: number;
  color: string | null;
  item_id: string;
  /** Caminho relativo do asset do upgrade (`upgrades.image`) — UI usa `normalizePublicAssetUrl`. */
  image: string | null;
};

/** `label` exibido: nome atual do upgrade quando `item_id` existe; senão etiqueta em `wheel_prizes`. */
function mapWheelPrizeJoinedRow(row: Record<string, unknown>): WheelPrizeRow {
  const un = row.upgrade_name;
  const live = un != null && typeof un === 'string' && String(un).trim().length > 0 ? String(un).trim() : null;
  const stored = row.stored_label != null ? String(row.stored_label) : String(row.label ?? '');
  const img = row.upgrade_image;
  const imageStr = img != null && typeof img === 'string' && String(img).trim().length > 0 ? String(img).trim() : null;
  return {
    id: String(row.id ?? ''),
    label: live ?? stored,
    weight: Number(row.weight),
    color: row.color != null ? String(row.color) : null,
    item_id: row.item_id != null ? String(row.item_id) : '',
    image: imageStr
  };
}

/** Apenas prémios ativos e de impacto baixo (sorteio pago e por código). */
export async function queryWheelPrizesEligibleForRoll(tx: Prisma.TransactionClient): Promise<WheelPrizeRow[]> {
  const prizesRes = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT wp.id,
           wp.label AS stored_label,
           wp.weight,
           wp.color,
           wp.item_id,
           u.name AS upgrade_name,
           u.image AS upgrade_image
    FROM wheel_prizes wp
    LEFT JOIN upgrades u ON u.id = wp.item_id
    WHERE COALESCE(wp.is_active, 1) = 1
      AND UPPER(TRIM(COALESCE(wp.tier, 'BASIC'))) IN ('BASIC', 'COMMON')
      AND UPPER(TRIM(COALESCE(wp.tier, 'BASIC'))) NOT IN ('LEGACY', 'PREMIUM', 'EPIC', 'LEGENDARY', 'RARE')
    ORDER BY wp.id ASC
  `;
  return prizesRes.map((r) => mapWheelPrizeJoinedRow(r));
}

export async function queryWheelPrizeByItemIdJoined(
  tx: Prisma.TransactionClient,
  itemId: string
): Promise<WheelPrizeRow | null> {
  const prizeRes = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT wp.id,
           wp.label AS stored_label,
           wp.weight,
           wp.color,
           wp.item_id,
           u.name AS upgrade_name,
           u.image AS upgrade_image
    FROM wheel_prizes wp
    LEFT JOIN upgrades u ON u.id = wp.item_id
    WHERE wp.item_id = ${itemId}
    LIMIT 1
  `;
  const r = prizeRes[0];
  return r ? mapWheelPrizeJoinedRow(r) : null;
}

/** Batch: 1 query para N item_ids (evita N+1 no histórico da roleta). */
export async function queryWheelPrizesByItemIdsJoined(
  tx: Prisma.TransactionClient,
  itemIds: string[]
): Promise<Map<string, WheelPrizeRow>> {
  const uniq = [...new Set(itemIds.map((id) => String(id || '').trim()).filter(Boolean))];
  const out = new Map<string, WheelPrizeRow>();
  if (uniq.length === 0) return out;
  const prizeRes = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT DISTINCT ON (wp.item_id)
           wp.id,
           wp.label AS stored_label,
           wp.weight,
           wp.color,
           wp.item_id,
           u.name AS upgrade_name,
           u.image AS upgrade_image
    FROM wheel_prizes wp
    LEFT JOIN upgrades u ON u.id = wp.item_id
    WHERE wp.item_id IN (${Prisma.join(uniq)})
    ORDER BY wp.item_id, wp.id
  `;
  for (const r of prizeRes) {
    const mapped = mapWheelPrizeJoinedRow(r);
    if (mapped.item_id) out.set(mapped.item_id, mapped);
  }
  return out;
}

/** Resposta JSON pública `/api/wheel/state` — só prémios ativos básicos; peso uniforme (UI). */
export async function fetchWheelPrizesForApiConfig(
  tx: Prisma.TransactionClient
): Promise<Array<{ id: string; label: string; color: string | null; weight: number; itemId: string; image: string | null }>> {
  const UNIFORM_UI_WEIGHT = 1;
  const rows = await queryWheelPrizesEligibleForRoll(tx);
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    color: row.color,
    weight: UNIFORM_UI_WEIGHT,
    itemId: row.item_id,
    image: row.image
  }));
}

function assertFinitePositiveWeight(w: unknown): number {
  const n = typeof w === 'number' ? w : Number(w);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** Sorteio ponderado determinístico no servidor; `prizes` já validados não vazios. */
export function pickWeightedPrize(prizes: WheelPrizeRow[]): WheelPrizeRow {
  const weights = prizes.map((p) => assertFinitePositiveWeight(p.weight));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    throw new HttpControlledError(HTTP_INTERNAL_SERVER_ERROR, { error: 'Invalid wheel configuration (weights).' });
  }
  let r = Math.random() * total;
  for (let i = 0; i < prizes.length; i++) {
    const w = weights[i]!;
    if (r < w) return prizes[i]!;
    r -= w;
  }
  return prizes[prizes.length - 1]!;
}
