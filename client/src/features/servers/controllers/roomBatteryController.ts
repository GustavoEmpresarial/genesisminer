import type { GameState, Upgrade } from '../types';
import { normalizePlacedRackRoomId } from '../types';
import {
  applyBulkRoomBatteryChange,
  applyBulkRoomBatterySmartFill,
  type BulkRoomBatteryApplyOptions,
  type BulkRoomBatteryResult,
  type BatteryRigSortMode
} from '../models/roomBatteryModel';
import { isValidBatteryRigSort, parseBooleanSmartFill } from '../validation/bulkBatteryValidation';
import { isValidBatterySelectionId, isValidRoomId } from '../validation/roomBatteryValidation';

export type BulkRoomBatteryRunOptions = BulkRoomBatteryApplyOptions & {
  smartFill?: boolean;
};

/**
 * Entrada única para aplicar bateria em massa na sala (validação + modelo).
 */
export function runBulkRoomBattery(
  prev: GameState,
  roomId: string,
  batteryUpgradeId: string,
  gameUpgrades: Upgrade[],
  runOpts?: BulkRoomBatteryRunOptions
): BulkRoomBatteryResult {
  const roomNorm = normalizePlacedRackRoomId(roomId);
  if (!isValidRoomId(roomNorm)) {
    return { ok: false, message: 'Sala inválida.' };
  }

  const smart = parseBooleanSmartFill(runOpts?.smartFill);
  const rigSort: BatteryRigSortMode = isValidBatteryRigSort(runOpts?.rigSort) ? runOpts.rigSort : 'slot_asc';

  if (smart) {
    if (batteryUpgradeId) {
      return {
        ok: false,
        message: 'No modo inteligente não pode haver um tipo de bateria selecionado na lista.'
      };
    }
    return applyBulkRoomBatterySmartFill(prev, roomNorm, gameUpgrades, rigSort);
  }

  if (batteryUpgradeId && !isValidBatterySelectionId(batteryUpgradeId)) {
    return { ok: false, message: 'Identificador de bateria inválido.' };
  }
  return applyBulkRoomBatteryChange(prev, roomNorm, batteryUpgradeId, gameUpgrades, { rigSort });
}
