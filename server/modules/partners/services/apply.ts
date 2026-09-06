/**
 * Migrado de legacy/backend/modules/partners/partnersApply.service.ts —
 * `assertUserCanApplyForPartner` + `runPartnerYoutubeApplicationSubmit` (rota
 * de jogador). `runPartnerYoutubeApplicationApprove`/`Reject` (admin) vivem em
 * `./admin-apply.ts`.
 */
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import { getPartnerAccessLevelIdsLower, getPartnerYoutubePendingApplicationForUser, insertPartnerYoutubeApplication } from './model.js';
import { isPartnerYoutubeManualAllowlisted } from './model.js';
import { sanitizePartnerChannelDescription, sanitizePartnerChannelName, sanitizePartnerCreatorAvatarUrl, sanitizePartnerCreatorChannelUrl, userAccessSetHasPartnerLevel } from './helpers.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;
const HTTP_CONFLICT = 409;
const CHANNEL_NAME_MIN_LENGTH = 2;
const PRISMA_UNIQUE_CONSTRAINT_CODE = 'P2002';

export async function assertUserCanApplyForPartner(userId: number): Promise<void> {
  const idSet = await getPartnerAccessLevelIdsLower(userId);
  const manualListed = await isPartnerYoutubeManualAllowlisted(userId);
  if (userAccessSetHasPartnerLevel(idSet) || manualListed) {
    throw new HttpControlledError(HTTP_CONFLICT, { error: 'You are already a YouTube partner.', code: 'ALREADY_PARTNER' });
  }
  const pending = await getPartnerYoutubePendingApplicationForUser(userId);
  if (pending) {
    throw new HttpControlledError(HTTP_CONFLICT, { error: 'You already have a pending application.', code: 'PENDING_APPLICATION' });
  }
}

export async function runPartnerYoutubeApplicationSubmit(params: { userId: number; channelNameRaw: unknown; channelUrlRaw: unknown; avatarUrlRaw: unknown; descriptionRaw: unknown }): Promise<{ id: string }> {
  await assertUserCanApplyForPartner(params.userId);

  const channelName = sanitizePartnerChannelName(String(params.channelNameRaw ?? ''));
  if (channelName.length < CHANNEL_NAME_MIN_LENGTH) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Invalid channel name (min. 2 characters).', code: 'VALIDATION' });
  }

  const channelUrl = sanitizePartnerCreatorChannelUrl(String(params.channelUrlRaw ?? ''));
  if (!channelUrl) {
    throw new HttpControlledError(HTTP_UNPROCESSABLE, { error: 'Invalid channel URL. Use an https:// YouTube link (e.g. /@yourchannel or /channel/...).', code: 'INVALID_CHANNEL_URL' });
  }

  const avatarUrl = sanitizePartnerCreatorAvatarUrl(String(params.avatarUrlRaw ?? ''));
  if (!avatarUrl) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Upload a channel photo/cover (PNG, JPG, or WEBP).', code: 'AVATAR_REQUIRED' });
  }

  const description = sanitizePartnerChannelDescription(String(params.descriptionRaw ?? ''));
  const id = crypto.randomUUID();
  const now = Date.now();

  try {
    await insertPartnerYoutubeApplication({ id, userId: params.userId, channelName, channelUrl, avatarUrl, description, createdAt: now });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === PRISMA_UNIQUE_CONSTRAINT_CODE) {
      throw new HttpControlledError(HTTP_CONFLICT, { error: 'A pending application already exists.', code: 'PENDING_APPLICATION' });
    }
    throw e;
  }

  return { id };
}
