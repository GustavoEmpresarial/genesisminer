/**
 * Migrado de legacy/backend/modules/partners/partnersApply.service.ts —
 * `runPartnerYoutubeApplicationApprove`/`Reject` (admin only). Substitui a classe
 * bespoke `PartnerYoutubeApplyError` do legado por `HttpControlledError`, no mesmo
 * padrão já usado por `./apply.ts` (fluxo de submissão do jogador).
 */
import { NFT_AUTO_ROOM_ID } from '../../mining-engine/services/nft-room-mining.js';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import {
  getPartnerYoutubeApplicationById,
  updatePartnerYoutubeApplicationApprove,
  updatePartnerYoutubeApplicationReject,
  addPartnerYoutubeManualAllowlist,
  grantPartnerNftRoomAccess,
  ensurePartnerAccessLevel,
  upsertPartnerYoutubeCreatorProfile
} from './admin-model.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const REJECT_REASON_MAX_LENGTH = 500;

export async function runPartnerYoutubeApplicationApprove(params: { applicationId: string; adminUserId: number }): Promise<{ userId: number }> {
  const id = String(params.applicationId || '').trim();
  if (!id) throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'ID inválido.', code: 'VALIDATION' });

  const app = await getPartnerYoutubeApplicationById(id);
  if (!app || app.status !== 'pending') {
    throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'Candidatura não encontrada ou já processada.', code: 'NOT_FOUND' });
  }

  const n = await updatePartnerYoutubeApplicationApprove(id, params.adminUserId, Date.now());
  if (!n) {
    throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'Candidatura não encontrada ou já processada.', code: 'NOT_FOUND' });
  }

  const userId = app.user_id;
  const now = Date.now();

  await addPartnerYoutubeManualAllowlist(userId, params.adminUserId, now);
  await ensurePartnerAccessLevel(userId);
  await upsertPartnerYoutubeCreatorProfile({
    userId,
    channelName: app.channel_name,
    channelUrl: app.channel_url,
    avatarUrl: app.avatar_url,
    description: app.description,
    updatedAt: now,
    updatedBy: params.adminUserId
  });
  await grantPartnerNftRoomAccess(userId, NFT_AUTO_ROOM_ID);

  return { userId };
}

export async function runPartnerYoutubeApplicationReject(params: { applicationId: string; adminUserId: number; reasonRaw: unknown }): Promise<void> {
  const id = String(params.applicationId || '').trim();
  if (!id) throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'ID inválido.', code: 'VALIDATION' });
  const reason = typeof params.reasonRaw === 'string' ? params.reasonRaw.trim().slice(0, REJECT_REASON_MAX_LENGTH) : '';
  const n = await updatePartnerYoutubeApplicationReject(id, params.adminUserId, reason || null, Date.now());
  if (!n) {
    throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'Candidatura não encontrada ou já processada.', code: 'NOT_FOUND' });
  }
}
