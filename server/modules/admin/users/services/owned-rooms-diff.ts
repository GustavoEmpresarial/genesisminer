/**
 * Diff grant/revoke de salas admin e partição de racks ao revogar.
 */
import {
  EXTRA_ROOM_ID,
  normalizePlacedRackRoomId,
  ROOM_INITIAL_ID
} from '../../../mining-engine/services/rack-room-id.js';
import { ASIC_ROOM_ID } from '../../../mining-engine/services/room-kind.js';

/** Salas sempre possuídas por jogadores — nunca revogáveis no diff admin. */
export const DEFAULT_PLAYER_OWNED_ROOM_IDS = [
  ROOM_INITIAL_ID,
  ASIC_ROOM_ID,
  EXTRA_ROOM_ID
] as const;

const ALWAYS_OWNED_ROOM_IDS = new Set<string>(DEFAULT_PLAYER_OWNED_ROOM_IDS);

export type OwnedRoomDiffInput = {
  currentIds: readonly unknown[];
  desiredIds: readonly unknown[];
  activeIds: Iterable<string>;
};

export type OwnedRoomDiff = {
  toAdd: string[];
  toRemove: string[];
};

function trimRoomId(raw: unknown): string {
  return raw != null ? String(raw).trim() : '';
}

function toTrimmedSet(ids: Iterable<unknown>): Set<string> {
  const out = new Set<string>();
  for (const raw of ids) {
    const id = trimRoomId(raw);
    if (id) out.add(id);
  }
  return out;
}

/** Garante salas default (Inicial / ASICs / Extra) na lista. */
export function ensureOwnedRoomIds(ids: Iterable<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown): void => {
    const id = trimRoomId(raw);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of DEFAULT_PLAYER_OWNED_ROOM_IDS) add(id);
  for (const raw of ids) add(raw);
  return out;
}

/** `room_id` de racks colocados (blank/main → sala inicial). */
export function roomIdsFromPlacedRacks(racks: readonly { roomId?: unknown }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rack of racks) {
    const id = normalizePlacedRackRoomId(rack.roomId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Só ids activos do catálogo. Salas default nunca entram em `toRemove`.
 */
export function computeOwnedRoomDiff(input: OwnedRoomDiffInput): OwnedRoomDiff {
  const active = toTrimmedSet(input.activeIds);
  const current = new Set<string>();
  for (const raw of input.currentIds) {
    const id = trimRoomId(raw);
    if (id && active.has(id)) current.add(id);
  }
  const desired = new Set<string>();
  for (const raw of input.desiredIds) {
    const id = trimRoomId(raw);
    if (id && active.has(id)) desired.add(id);
  }

  const toAdd: string[] = [];
  for (const id of desired) {
    if (!current.has(id)) toAdd.push(id);
  }

  const toRemove: string[] = [];
  for (const id of current) {
    if (!desired.has(id) && !ALWAYS_OWNED_ROOM_IDS.has(id)) toRemove.push(id);
  }

  return { toAdd, toRemove };
}

/**
 * Racks cuja sala normalizada está em `revokeRoomIds` → `removed`; resto → `keep`.
 */
export function partitionRacksForRoomRevoke<T extends { roomId?: unknown }>(
  racks: readonly T[],
  revokeRoomIds: readonly string[]
): { keep: T[]; removed: T[] } {
  const revoke = toTrimmedSet(revokeRoomIds);
  const keep: T[] = [];
  const removed: T[] = [];
  for (const rack of racks) {
    const roomId = normalizePlacedRackRoomId(rack.roomId);
    if (revoke.has(roomId)) removed.push(rack);
    else keep.push(rack);
  }
  return { keep, removed };
}
