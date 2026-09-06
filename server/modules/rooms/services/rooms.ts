/**
 * Salas de mineração (`rig_rooms`): listagem pública e compra/desbloqueio de slots.
 *
 * Migrado de legacy/backend/server.ts (`GET /api/rig-rooms`,
 * `POST /api/rig-rooms/purchase-slot`, ~linhas 4446–4636).
 *
 * ⚠️ Correção de segurança (#8): coluna DB `rig_rooms.allowed_levels` +
 * `allowed_season_pass_ids` restringem quais **planos/membership** podem
 * comprar slots numa sala. Validado em `purchaseRigRoomSlot` antes de debitar.
 *
 * Domínio (#89): **sala ≠ plano**. Tabela `access_levels` = planos;
 * `rig_rooms` = pisos. API JSON usa `allowedPlanIds` / `planIds`.
 * Coluna SQL permanece `allowed_levels` (schema legado).
 */
import { prisma } from '../../../core/database/prisma.js';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import {
  callRoomPurchaseSlot,
  isHardwareMarketError
} from '../../hardware/services/hardware-client.js';
import { isNftAutoArmario1OnlyRoomRow } from '../../mining-engine/services/nft-room-mining.js';
import { roomAccessGateFromRow, type UserRoomAccess } from './room-access.js';

// Gate puro vive em `room-access.ts` (sem DB); reexportado para não quebrar importadores.
export { isRoomAccessAllowedForUser, roomAccessGateFromRow, type RoomAccessGate, type UserRoomAccess } from './room-access.js';

const HTTP_BAD_REQUEST = 400;
const PURCHASE_MAX_QUANTITY = 50;
const PURCHASE_DEFAULT_QUANTITY = 1;

export type RigRoomListItem = {
  id: string;
  name: string;
  initialCapacity: number;
  maxCapacity: number;
  baseSlotPrice: number;
  slotPriceIncreasePercent: number;
  /** IDs de plano/membership (`access_levels.id`) que desbloqueiam esta sala. */
  allowedPlanIds: string[];
  allowedSeasonPassIds: string[];
  isActive: boolean;
  sortOrder: number;
  nftAutoArmario1Only: boolean;
};

function parseJsonStringArray(raw: unknown): string[] {
  return roomAccessGateFromRow({ allowed_levels: raw }).allowedPlanIds;
}

export async function listRigRooms(): Promise<RigRoomListItem[]> {
  const rows = await prisma.rig_rooms.findMany({
    orderBy: [{ sort_order: 'asc' }, { name: 'asc' }]
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    initialCapacity: r.initial_capacity,
    maxCapacity: r.max_capacity,
    baseSlotPrice: r.base_slot_price,
    slotPriceIncreasePercent: r.slot_price_increase_percent,
    allowedPlanIds: parseJsonStringArray(r.allowed_levels),
    allowedSeasonPassIds: parseJsonStringArray(r.allowed_season_pass_ids),
    isActive: !!r.is_active,
    sortOrder: r.sort_order,
    nftAutoArmario1Only: isNftAutoArmario1OnlyRoomRow(r)
  }));
}

/**
 * Planos do utilizador + season passes — gate de sala apenas
 * (não confundir plano com a sala em si).
 */
export async function resolveUserRoomAccess(userId: number): Promise<UserRoomAccess> {
  const [user, grants, passes] = await Promise.all([
    prisma.users.findUnique({ where: { id: userId }, select: { access_level_id: true } }),
    prisma.user_access_levels.findMany({ where: { user_id: userId }, select: { access_level_id: true } }),
    prisma.season_purchases.findMany({ where: { user_id: userId }, select: { pass_id: true } })
  ]);

  const planIds = new Set<string>(grants.map((g) => g.access_level_id));
  if (user?.access_level_id) planIds.add(user.access_level_id);

  return {
    planIds: Array.from(planIds),
    passIds: passes.map((p) => p.pass_id)
  };
}

const RIG_ROOM_ID_RE = /^[a-zA-Z0-9_.:-]{1,120}$/;

export function parseRigRoomId(raw: unknown): string | null {
  return typeof raw === 'string' && RIG_ROOM_ID_RE.test(raw.trim()) ? raw.trim() : null;
}

export function parsePurchaseQuantity(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return PURCHASE_DEFAULT_QUANTITY;
  return n;
}

export type PurchaseRigRoomSlotResult = {
  ok: true;
  roomId: string;
  slotsPurchased: number;
  totalPrice: number;
  newUsdc: number;
  cached?: boolean;
};

/**
 * Compra/desbloqueia slots numa sala via `genesis-hardware`
 * (`POST /v1/rooms/purchase-slot`) — USDC + unlock + idem num TX (fail-closed).
 *
 * `idempotencyKey` obrigatória: débito + slots + linha de idempotência no mesmo COMMIT.
 */
export async function purchaseRigRoomSlot(
  userId: number,
  roomId: string,
  quantityRaw: number,
  idempotencyKey: string
): Promise<PurchaseRigRoomSlotResult> {
  const quantity = Math.min(PURCHASE_MAX_QUANTITY, Math.max(1, Math.floor(quantityRaw)));
  const idemKey = String(idempotencyKey || '').trim();
  if (!idemKey) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, {
      ok: false,
      error: 'Invalid or missing idempotencyKey (8–128 safe characters).',
      code: 'IDEMPOTENCY_KEY_REQUIRED'
    });
  }

  try {
    return await callRoomPurchaseSlot({
      userId,
      roomId,
      quantity,
      idempotencyKey: idemKey,
      serverNowMs: Date.now()
    });
  } catch (e) {
    if (isHardwareMarketError(e)) {
      throw new HttpControlledError(e.statusCode, { ok: false, ...e.jsonBody });
    }
    throw e;
  }
}
