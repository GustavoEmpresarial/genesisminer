/**
 * Módulo `partners`: vitrine + candidatura + envio de vídeos de Parceiros YouTube.
 * O HTTP do jogador é de genesis-api; aqui fica o painel admin (aprovar/rejeitar
 * candidaturas e envios, allowlist manual, gestão da Sala Streamer) e os serviços.
 */
export { registerPartnersAdminModuleRoutes } from './controllers/partners-admin.controller.js';
export type { PartnersAdminModuleDeps } from './controllers/partners-admin.controller.js';

export { assertUserCanApplyForPartner, runPartnerYoutubeApplicationSubmit } from './services/apply.js';
export { runPartnerYoutubeApplicationApprove, runPartnerYoutubeApplicationReject } from './services/admin-apply.js';
export { assertUserIsPartner, buildPartnerNftRoomStatus, runPartnerYoutubeProfileUpdate } from './services/profile.js';
export type { PartnerNftRoomStatus } from './services/profile.js';
export { buildPartnersStatePayload, getApprovedPartnerVideoByPublicId } from './services/state.js';
export type { PartnersPublicVideoDto } from './services/state.js';
export { runPartnerYoutubeSubmitVideo } from './services/submit.js';
export { validateAndCanonicalYoutubeUrl, youtubeEmbedUrl, youtubeThumbnailUrl } from './services/youtube-url.js';
export * from './services/admin-model.js';
