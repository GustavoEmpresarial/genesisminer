/**
 * Leitura/gravação admin do estado jogável (stock, racks, USDC, coinBalances,
 * unopenedBoxes) para a aba Usuários — sem NFT sync / claimedBoxes / listings.
 *
 * Stock/racks → `callHardwarePersist`. USDC + coinBalances → `genesis-wallet`
 * (`POST /v1/wallet/admin/save-game-balances`, fail-closed).
 */
import type { Pool } from 'pg';
import { prisma } from '../../../../core/database/prisma.js';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import { SAVE_GAME_ITEM_ID_RE } from '../../../hardware/services/save-guard.js';
import { callHardwarePersist } from '../../../hardware/services/hardware-client.js';
import {
  loadUserPlacedRacksWithSlots,
  loadUserStock,
  type PlacedRackLoaded
} from '../../../hardware/services/persistence.js';
import { computeProgressForUser } from '../../../mining-engine/services/progress-computer.js';
import { buildServersAuthoritativeStateDto } from '../../../servers/services/state-snapshot.js';
import {
  callWalletAdminSaveGameBalances,
  isWalletWorkerError
} from '../../../wallet/services/wallet-worker-client.js';
import { ensureOwnedRoomIds, roomIdsFromPlacedRacks } from './owned-rooms-diff.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVICE_UNAVAILABLE = 503;
const COIN_ID_MAX = 128;
const EMAIL_MAX = 254;

const ERR_USER_NOT_FOUND = { error: 'Utilizador não encontrado.', code: 'NOT_FOUND' };
const ERR_EMAIL = { error: 'Email inválido.', code: 'VALIDATION' };
const ERR_PROGRESS_FAILED = {
  error: 'Não foi possível liquidar a mineração antes de guardar.',
  code: 'PROGRESS_UNAVAILABLE'
};

export type AdminGameStateDto = {
  usdc: number;
  blackMarketBalance: number;
  startTime: number;
  stock: Record<string, number>;
  unopenedBoxes: Record<string, number>;
  claimedBoxes: string[];
  storedBatteries: Array<{ id: string; itemId: string; displayName?: string | null; imageUrl?: string | null }>;
  placedRacks: unknown[];
  playerListings: unknown[];
  coinBalances: Record<string, number>;
  claimedReferrals: number;
  referralBonusClaimed: boolean;
  dailyActions: Record<string, number>;
  serverUpdatedAt: number;
  asicLeases?: unknown[];
  asicLeaseDetails?: unknown[];
  ownedRoomIds: string[];
};

export type ApplyAdminSaveGameOverrideInput = {
  targetUserId: number;
  actorUserId: number;
  changes: Record<string, unknown> | null | undefined;
  reason?: string | null;
  pool: Pool;
};

export type ApplyAdminSaveGameOverrideResult = {
  ok: true;
  stock: Record<string, number>;
  placedRacks?: PlacedRackLoaded[];
  storedBatteries?: never;
  serverUpdatedAt: number;
};

/** Normaliza stock para snapshot: só qty finitas ≥ 0; qty 0 omite (DELETE no snapshot). */
export function normalizeAdminStockSnapshot(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [rawId, rawQty] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(rawId ?? '').trim();
    if (!id || !SAVE_GAME_ITEM_ID_RE.test(id)) continue;
    const n = typeof rawQty === 'number' ? rawQty : Number(rawQty);
    if (!Number.isFinite(n) || n < 0) continue;
    const qty = Math.floor(n);
    if (qty <= 0) continue;
    out[id] = (out[id] || 0) + qty;
  }
  return out;
}

function normalizePlacedRacksForPersist(raw: unknown): PlacedRackLoaded[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PlacedRackLoaded[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const id = o.id != null ? String(o.id).trim() : '';
    const itemId = o.itemId != null ? String(o.itemId).trim() : '';
    if (!id || !SAVE_GAME_ITEM_ID_RE.test(id)) continue;
    if (!itemId || !SAVE_GAME_ITEM_ID_RE.test(itemId)) continue;
    const slots = Array.isArray(o.slots) ? o.slots.map((s) => (s == null ? '' : String(s))) : [];
    const multiplierSlots = Array.isArray(o.multiplierSlots)
      ? o.multiplierSlots.map((s) => (s == null ? '' : String(s)))
      : [];
    const slotLeaseIds = Array.isArray(o.slotLeaseIds)
      ? o.slotLeaseIds.map((s) => (s == null ? '' : String(s)))
      : undefined;
    out.push({
      id,
      itemId,
      slots,
      slotLeaseIds,
      multiplierSlots,
      wiringId: o.wiringId != null && String(o.wiringId).trim() ? String(o.wiringId) : null,
      batteryId: o.batteryId != null && String(o.batteryId).trim() ? String(o.batteryId) : null,
      isOn: !!o.isOn,
      selectedCoinId: o.selectedCoinId != null && String(o.selectedCoinId).trim() ? String(o.selectedCoinId) : null,
      roomId: o.roomId != null ? String(o.roomId) : 'room_initial',
      slotIndex: Math.max(0, Math.floor(Number(o.slotIndex) || 0)),
      batteryCatalogItemId: o.batteryCatalogItemId != null ? String(o.batteryCatalogItemId) : null,
      batteryDisplayName: o.batteryDisplayName != null ? String(o.batteryDisplayName) : null,
      batteryImageUrl: o.batteryImageUrl != null ? String(o.batteryImageUrl) : null
    });
  }
  return out;
}

async function loadCoinBalancesMap(userId: number): Promise<Record<string, number>> {
  const rows = await prisma.coin_balances.findMany({
    where: { user_id: userId },
    select: { coin_id: true, amount: true }
  });
  const coinBalances: Record<string, number> = {};
  for (const row of rows) {
    const amt = Number(row.amount);
    coinBalances[String(row.coin_id)] = Number.isFinite(amt) ? amt : 0;
  }
  return coinBalances;
}

export async function loadAdminGameStateByUserId(
  userId: number,
  opts?: { adminEdit?: boolean }
): Promise<AdminGameStateDto> {
  const dto = await buildServersAuthoritativeStateDto(
    userId,
    opts?.adminEdit === true ? { skipProgress: true } : undefined
  );
  const [gsRow, coinBalances, boxRows, ownedRoomRows] = await Promise.all([
    prisma.game_states.findUnique({
      where: { user_id: userId },
      select: {
        start_time: true,
        claimed_referrals: true,
        referral_bonus_claimed: true,
        black_market_balance: true
      }
    }),
    loadCoinBalancesMap(userId),
    prisma.unopened_boxes.findMany({
      where: { user_id: userId },
      select: { box_id: true, qty: true }
    }),
    prisma.user_rig_rooms.findMany({
      where: { user_id: userId },
      select: { room_id: true }
    })
  ]);

  const startTimeRaw = gsRow?.start_time != null ? Number(gsRow.start_time) : 0;
  const startTime = Number.isFinite(startTimeRaw) ? startTimeRaw : 0;
  const claimedReferrals = Math.max(0, Math.floor(Number(gsRow?.claimed_referrals) || 0));
  const referralBonusClaimed = Number(gsRow?.referral_bonus_claimed) === 1;
  const bmRaw = Number(gsRow?.black_market_balance ?? 0);
  const blackMarketBalance = Number.isFinite(bmRaw) ? bmRaw : 0;

  const unopenedBoxes: Record<string, number> = {};
  for (const row of boxRows) {
    const qty = Number(row.qty);
    unopenedBoxes[String(row.box_id)] = Number.isFinite(qty) ? qty : 0;
  }

  const base: AdminGameStateDto = {
    usdc: Number.isFinite(Number(dto.usdc)) ? Number(dto.usdc) : 0,
    blackMarketBalance,
    startTime,
    stock: dto.stock || {},
    unopenedBoxes,
    claimedBoxes: [],
    storedBatteries: dto.storedBatteries || [],
    placedRacks: dto.placedRacks || [],
    playerListings: [],
    coinBalances,
    claimedReferrals,
    referralBonusClaimed,
    dailyActions: {},
    serverUpdatedAt: dto.serverUpdatedAt || 0,
    ownedRoomIds: ensureOwnedRoomIds([
      ...ownedRoomRows.map((r) => r.room_id),
      ...roomIdsFromPlacedRacks(dto.placedRacks || [])
    ])
  };

  if (opts?.adminEdit) {
    base.asicLeases = [];
    base.asicLeaseDetails = [];
  } else if (Array.isArray(dto.asicLeaseDetails)) {
    base.asicLeaseDetails = dto.asicLeaseDetails;
  }

  return base;
}

export async function loadAdminGameStateByEmail(
  email: string,
  opts?: { adminEdit?: boolean }
): Promise<AdminGameStateDto> {
  const em = String(email ?? '').trim();
  if (!em || em.length > EMAIL_MAX) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, ERR_EMAIL);
  }
  const user = await prisma.users.findFirst({
    where: { email: { equals: em, mode: 'insensitive' } },
    select: { id: true }
  });
  if (!user) {
    throw new HttpControlledError(HTTP_NOT_FOUND, ERR_USER_NOT_FOUND);
  }
  return loadAdminGameStateByUserId(user.id, opts);
}

function normalizeCoinBalancesForWallet(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [rawCoinId, rawAmount] of Object.entries(raw)) {
    const coinId = String(rawCoinId ?? '').trim();
    if (!coinId || coinId.length > COIN_ID_MAX) continue;
    const amount = typeof rawAmount === 'number' ? rawAmount : Number(rawAmount);
    if (!Number.isFinite(amount)) continue;
    out[coinId] = amount;
  }
  return out;
}

export async function applyAdminSaveGameOverride(
  input: ApplyAdminSaveGameOverrideInput
): Promise<ApplyAdminSaveGameOverrideResult> {
  const { targetUserId, actorUserId, changes, pool } = input;
  void actorUserId;
  void input.reason;

  if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Invalid user id.', code: 'VALIDATION' });
  }

  const target = await prisma.users.findUnique({ where: { id: targetUserId }, select: { id: true } });
  if (!target) {
    throw new HttpControlledError(HTTP_NOT_FOUND, ERR_USER_NOT_FOUND);
  }

  const ch = changes && typeof changes === 'object' && !Array.isArray(changes) ? changes : {};
  const hasStock = ch.stock != null && typeof ch.stock === 'object' && !Array.isArray(ch.stock);
  const placedRacksNorm = Array.isArray(ch.placedRacks) ? normalizePlacedRacksForPersist(ch.placedRacks) : null;
  const hasUsdc = typeof ch.usdc === 'number' && Number.isFinite(ch.usdc);
  const hasCoins =
    ch.coinBalances != null && typeof ch.coinBalances === 'object' && !Array.isArray(ch.coinBalances);
  // stock-only battery model: skip loose storedBatteries warehouse rewrite (mounted UUIDs stay via racks).
  void ch.storedBatteries;

  // Liquida progresso ANTES do UPDATE last_updated_at — evita saltar intervalo não creditado.
  const progress = await computeProgressForUser(pool, targetUserId, Date.now(), true);
  if (!progress.ok) {
    throw new HttpControlledError(HTTP_SERVICE_UNAVAILABLE, ERR_PROGRESS_FAILED);
  }

  const client = await pool.connect();
  const wroteRacks = placedRacksNorm != null;
  let txOut: {
    serverUpdatedAt: number;
    stock: Record<string, number>;
    placedRacks?: PlacedRackLoaded[];
  };
  try {
    await client.query('BEGIN');
    const tEnsure = Date.now();
    await client.query(
      `INSERT INTO game_states (user_id, usdc, start_time, claimed_referrals, referral_bonus_claimed, last_updated_at, server_updated_at, black_market_balance)
       VALUES ($1, 0, $2, 0, 0, $2, $2, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [targetUserId, tEnsure]
    );
    await client.query('SELECT 1 FROM game_states WHERE user_id = $1 FOR UPDATE', [targetUserId]);

    const persistPayload: {
      stock?: Record<string, number>;
      stockMode?: 'merge';
      placedRacks?: PlacedRackLoaded[];
    } = {};
    if (hasStock) {
      persistPayload.stock = normalizeAdminStockSnapshot(ch.stock);
      persistPayload.stockMode = 'merge';
    }
    if (placedRacksNorm) {
      persistPayload.placedRacks = placedRacksNorm;
    }

    if (persistPayload.stock != null || persistPayload.placedRacks != null) {
      await callHardwarePersist({ userId: targetUserId, ...persistPayload });
    }

    const now = Date.now();
    await client.query(
      'UPDATE game_states SET server_updated_at = $2, last_updated_at = $2 WHERE user_id = $1',
      [targetUserId, now]
    );

    const stock = await loadUserStock(client, targetUserId);
    const placedRacks = wroteRacks ? await loadUserPlacedRacksWithSlots(client, targetUserId) : undefined;

    await client.query('COMMIT');
    txOut = {
      serverUpdatedAt: now,
      stock,
      ...(placedRacks ? { placedRacks } : {})
    };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }

  // Money TX no worker (fora do FOR UPDATE Node — evita deadlock com UPDATE usdc).
  if (hasUsdc || hasCoins) {
    const coinBalances = hasCoins
      ? normalizeCoinBalancesForWallet(ch.coinBalances as Record<string, unknown>)
      : null;
    const coinsPayload =
      coinBalances && Object.keys(coinBalances).length > 0 ? coinBalances : null;
    if (hasUsdc || coinsPayload) {
      try {
        await callWalletAdminSaveGameBalances({
          userId: targetUserId,
          ...(hasUsdc ? { usdc: ch.usdc as number } : {}),
          ...(coinsPayload ? { coinBalances: coinsPayload } : {}),
          serverNowMs: txOut.serverUpdatedAt
        });
      } catch (e) {
        if (isWalletWorkerError(e)) {
          throw new HttpControlledError(e.statusCode, e.jsonBody);
        }
        throw e;
      }
    }
  }

  return {
    ok: true,
    stock: txOut.stock,
    ...(txOut.placedRacks ? { placedRacks: txOut.placedRacks } : {}),
    serverUpdatedAt: txOut.serverUpdatedAt
  };
}
