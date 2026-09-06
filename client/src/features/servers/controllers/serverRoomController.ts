import type { ServerRoomSelectionContext } from '../models/serverRoomModel';
import {
  isChassisAllowedForRoomAffinity,
  resolveChassisRackRoomAffinity,
  resolveClientRoomKind,
  type RackRoomAffinity
} from '../types';
import { parseValidGameItemId, parseValidStoredBatteryId } from '../validation/serverRoomValidation';

export type ServerRoomActionHandlers = {
  onPlaceRack: (
    rackTypeId: string,
    roomId: string,
    slotIndex: number,
    ctx?: { roomName?: string; nftAutoArmario1Only?: boolean; roomKind?: string; rackRoomAffinity?: RackRoomAffinity }
  ) => void;
  onEquipMiner: (rackId: string, slotIndex: number, minerId: string) => void;
  onEquipAux: (
    rackId: string,
    itemId: string,
    type: 'battery' | 'wiring' | 'multiplier',
    storedBatteryId?: string,
    slotIndex?: number
  ) => void;
};

export function runValidatedItemSelection(
  selection: ServerRoomSelectionContext,
  itemId: string,
  storedBatteryId: string | undefined,
  handlers: ServerRoomActionHandlers,
  rackRoomAffinity?: RackRoomAffinity | string | null
): { ok: true } | { ok: false; message: string } {
  const cleanItem = parseValidGameItemId(itemId);
  if (!cleanItem) {
    return { ok: false, message: 'Invalid item identifier.' };
  }
  if (storedBatteryId != null && storedBatteryId !== '') {
    const sb = parseValidStoredBatteryId(storedBatteryId);
    if (!sb) {
      return { ok: false, message: 'Invalid warehouse battery identifier.' };
    }
  }

  const { rackId, slotIndex, type, roomId, roomName, nftAutoArmario1Only, roomKind } = selection;

  if (type === 'rack') {
    if (!roomId || slotIndex === null || slotIndex < 0) {
      return { ok: false, message: 'Invalid room or slot.' };
    }
    const kind = resolveClientRoomKind({ roomId, roomName, roomKind, nftAutoArmario1Only });
    const affinity = resolveChassisRackRoomAffinity(cleanItem, rackRoomAffinity);
    if (!isChassisAllowedForRoomAffinity(affinity, kind)) {
      return { ok: false, message: 'This chassis cannot be placed in this room.' };
    }
    handlers.onPlaceRack(cleanItem, roomId, slotIndex, {
      roomName: roomName ?? undefined,
      nftAutoArmario1Only,
      roomKind,
      rackRoomAffinity: affinity
    });
    return { ok: true };
  }

  if (!rackId) {
    return { ok: false, message: 'Invalid rig.' };
  }

  if (type === 'machine') {
    if (slotIndex === null || slotIndex < 0) {
      return { ok: false, message: 'Invalid GPU slot.' };
    }
    handlers.onEquipMiner(rackId, slotIndex, cleanItem);
    return { ok: true };
  }

  const sb = storedBatteryId ? parseValidStoredBatteryId(storedBatteryId) : undefined;
  handlers.onEquipAux(rackId, cleanItem, type, sb ?? undefined, slotIndex ?? undefined);
  return { ok: true };
}
