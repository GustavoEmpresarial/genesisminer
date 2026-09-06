/**
 * Módulo `announcements`: avisos no jogo (popup ler uma vez) + Mini Blog
 * (arquivo dos já lidos) — rotas jogador e admin.
 */
export { registerAnnouncementsModuleRoutes } from './controllers/announcements.controller.js';
export type { AnnouncementsModuleDeps } from './controllers/announcements.controller.js';

export {
  AnnouncementValidationError,
  LINK_MAX,
  MESSAGE_MAX,
  PENDING_MAX,
  PRIORITY_MAX,
  PRIORITY_MIN,
  SAFE_ANNOUNCEMENT_IMAGE_PATH_RE,
  SCHEDULE_MAX_MS,
  TITLE_MAX,
  parseAnnouncementId,
  parseCreateInput,
  parseIsActive,
  parseOptionalHttpsLink,
  parseOptionalScheduleMs,
  parseOptionalSelfImagePath,
  parsePlainMessage,
  parsePlainTitle,
  parsePriority,
  parseUpdateInput,
  validateScheduleRange
} from './services/validation.js';
export type { ValidatedCreateAnnouncement, ValidatedUpdateAnnouncement } from './services/validation.js';

export type { CreateAnnouncementInput, AnnouncementAdminDto, AnnouncementDto, UpdateAnnouncementInput } from './services/types.js';

export { createAnnouncementAdmin, deleteAnnouncementAdmin, dismissAnnouncementForUser, listAnnouncementsAdmin, listMiniBlogEntriesForUser, listPendingAnnouncementsForUser, updateAnnouncementAdmin } from './services/announcements.js';
