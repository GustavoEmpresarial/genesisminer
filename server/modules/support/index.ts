/**
 * Módulo `support`: tickets de suporte. O HTTP do jogador (submit, reply,
 * anexos) é de genesis-api; aqui fica o painel admin (`admin.controller.ts`)
 * mais os serviços/modelos partilhados.
 */
export { registerSupportAdminModuleRoutes } from './controllers/admin.controller.js';
export type { SupportAdminModuleDeps } from './controllers/admin.controller.js';

export { SUPPORT_ALLOWED_EXT, SUPPORT_UPLOAD_MAX_BYTES, SUPPORT_UPLOAD_MAX_FILES } from './services/limits.js';
export { SupportMutationError, runSupportPlayerReplyMutation, runSupportSubmitTicketMutation } from './services/mutation.js';
export type { SupportAttachmentItem } from './services/mutation.js';
export { buildAttachmentsFromFiles, sendSupportMulterError } from './services/attachments.js';
export {
  isSafeSupportStoredFilename,
  isSupportReplyStoredName,
  rewriteSupportAttachmentsForPlayerDownload,
  storedNameFromImgUrl,
  supportStoredFileOwnedByUser
} from './services/attachments-proxy.js';
export { buildSupportStatePayload, listSupportTicketsPageForPlayer, mapSupportSummariesToPlayerTickets } from './services/state.js';
export type { SupportPlayerTicketListItem } from './services/state.js';
export {
  getAdminTicketListRowById,
  getOwnedSupportTicketBundle,
  getSupportTicketById,
  getTicketForAdminReply,
  getTicketForPlayerAction,
  getUserSupportTicketStats,
  insertSupportAdminReply,
  insertSupportPlayerReply,
  insertSupportTicket,
  listAdminRepliesForTicket,
  listAdminRepliesForTicketIds,
  listMySupportTicketSummaries,
  listPlayerRepliesForTicket,
  listPlayerRepliesForTicketIds,
  listTicketsForAdmin,
  listUserSupportTicketHistorySummaries,
  supportStoredNameReferencedOnTicket,
  updateSupportTicketStatus,
  updateSupportTicketStatusForUser
} from './services/ticket-model.js';
export type {
  AdminReplyBatchRow,
  AdminTicketListRow,
  PlayerReplyBatchRow,
  SupportTicketPlayerReplyDbRow,
  SupportTicketReplyDbRow,
  SupportTicketRow,
  SupportTicketSummaryRow,
  UserSupportHistorySummaryRow,
  UserSupportTicketStatsRow
} from './services/ticket-model.js';
