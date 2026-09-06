/**
 * Perfil do utilizador no admin (planos/níveis, salas do jogador, block/delete, streamer).
 * Composição principal: `AdminUsersPage` (estado + handlers partilhados com o save editor).
 * Helpers de salas: `../lib/roomCatalog`.
 */
export {
  resolveStreamerRoomId,
  ownedRoomsFromIds,
  isActiveRoomId,
  roomNameById,
  type AdminRoomOption
} from '../lib/roomCatalog';

export const USER_PROFILE_SECTION = 'UserProfileEditor' as const;
