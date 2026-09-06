/** Admin user management feature — gestão de usuários. */
export { AdminUsersPage as AdminUsers, AdminUsersPage } from './ui/AdminUsersPage';
export type { AdminUsersJumpTarget } from './ui/AdminUsersPage';
export { AccessLevelsCatalog } from './ui/AccessLevelsCatalog';
export {
  buildAdminSaveOverrideDelta,
  findOrphanRackRoom,
  isUserSaveTabReadonly,
  USER_SAVE_TABS,
  type UserSaveTab
} from './ui/UserSaveEditor';
export * from './api';
export {
  resolveStreamerRoomId,
  roomNameById,
  isActiveRoomId,
  ownedRoomsFromIds,
  type AdminRoomOption
} from './lib/roomCatalog';
