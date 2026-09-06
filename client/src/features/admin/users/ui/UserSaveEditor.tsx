/**
 * Editor de save do jogador (Estoque / Rigs / Saldos / Caixas / Carteiras / Atividade).
 * Composição principal: `AdminUsersPage` (estado partilhado com perfil + override API).
 * Stock helpers: `../lib/adminStock`.
 */
import { adminStockEntriesForEditor, adminStockPayloadForSave, sanitizeAdminStock } from '../lib/adminStock';
import { isActiveRoomId, roomNameById, type AdminRoomOption } from '../lib/roomCatalog';

export type UserSaveTab = 'stock' | 'racks' | 'balances' | 'boxes' | 'wallets' | 'logs';

export const USER_SAVE_TABS: UserSaveTab[] = [
  'stock',
  'racks',
  'balances',
  'boxes',
  'wallets',
  'logs'
];

export function isUserSaveTabReadonly(tab: UserSaveTab | string): boolean {
  return tab === 'logs' || tab === 'wallets';
}

/** Supported delta for `ApplyAdminSaveGameOverrideInput` from the editor. */
export function buildAdminSaveOverrideDelta(save: {
  stock?: Record<string, number>;
  placedRacks?: unknown[];
  usdc?: number;
  coinBalances?: Record<string, number>;
  unopenedBoxes?: Record<string, number>;
}) {
  return {
    stock: adminStockPayloadForSave(save.stock),
    placedRacks: save.placedRacks || [],
    usdc: save.usdc,
    coinBalances: save.coinBalances || {},
    unopenedBoxes: save.unopenedBoxes || {}
  };
}

export function findOrphanRackRoom(
  placedRacks: Array<{ roomId?: string }> | undefined,
  roomOptions: AdminRoomOption[]
) {
  return (placedRacks || []).find(
    (r) => !isActiveRoomId(roomOptions, String(r.roomId || '').trim() || 'room_initial')
  );
}

export {
  adminStockEntriesForEditor,
  adminStockPayloadForSave,
  sanitizeAdminStock,
  isActiveRoomId,
  roomNameById
};
