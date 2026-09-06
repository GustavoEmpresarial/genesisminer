/** Migrado de legacy/backend/modules/partners/partnersProfile.service.ts (verbatim). */
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';
import { NFT_AUTO_ROOM_ID } from '../../mining-engine/services/nft-room-mining.js';
import { sanitizePartnerChannelName, sanitizePartnerCreatorAvatarUrl, userAccessSetHasPartnerLevel } from './helpers.js';
import { countPartnerApprovedVideosSince, getPartnerAccessLevelIdsLower, getPartnerLastApprovedVideoAt, getPartnerYoutubeCreatorProfile, isPartnerYoutubeManualAllowlisted, updatePartnerYoutubeCreatorProfileEditable, userHasNftRoomAccess } from './model.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const CHANNEL_NAME_MIN_LENGTH = 2;
const NFT_ROOM_COMPLIANCE_REQUIRED_DAYS = 60;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const MS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

export async function assertUserIsPartner(userId: number): Promise<void> {
  const idSet = await getPartnerAccessLevelIdsLower(userId);
  const manualListed = await isPartnerYoutubeManualAllowlisted(userId);
  if (!userAccessSetHasPartnerLevel(idSet) && !manualListed) {
    throw new HttpControlledError(HTTP_FORBIDDEN, { error: 'Only YouTube partners can edit the profile.', code: 'NOT_PARTNER' });
  }
}

export async function runPartnerYoutubeProfileUpdate(params: { userId: number; channelNameRaw: unknown; avatarUrlRaw: unknown }): Promise<{ channelName: string; avatarUrl: string; channelUrl: string }> {
  await assertUserIsPartner(params.userId);

  const existing = await getPartnerYoutubeCreatorProfile(params.userId);
  if (!existing) {
    throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'Partner profile not found.', code: 'NOT_FOUND' });
  }

  const channelName = sanitizePartnerChannelName(String(params.channelNameRaw ?? ''));
  if (channelName.length < CHANNEL_NAME_MIN_LENGTH) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Invalid channel name (min. 2 characters).', code: 'VALIDATION' });
  }

  const avatarUrl = sanitizePartnerCreatorAvatarUrl(String(params.avatarUrlRaw ?? ''));
  if (!avatarUrl) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Invalid cover/photo.', code: 'AVATAR_REQUIRED' });
  }

  await updatePartnerYoutubeCreatorProfileEditable({ userId: params.userId, channelName, avatarUrl, updatedAt: Date.now() });

  return { channelName, avatarUrl, channelUrl: existing.channel_url };
}

export type PartnerNftRoomStatus = {
  active: boolean;
  compliant: boolean;
  overdue: boolean;
  requiredIntervalDays: number;
  lastApprovedAt: number | null;
  nextDeadlineAt: number | null;
  approvedLast60d: number;
};

export async function buildPartnerNftRoomStatus(userId: number): Promise<PartnerNftRoomStatus> {
  const windowMs = NFT_ROOM_COMPLIANCE_REQUIRED_DAYS * MS_PER_DAY;
  const active = await userHasNftRoomAccess(userId, NFT_AUTO_ROOM_ID);
  const lastApprovedAt = await getPartnerLastApprovedVideoAt(userId);
  const since60 = Date.now() - windowMs;
  const approvedLast60d = await countPartnerApprovedVideosSince(userId, since60);
  const lastMs = lastApprovedAt ?? 0;
  const nextDeadlineAt = lastMs > 0 ? lastMs + windowMs : null;
  const overdue = active && approvedLast60d === 0;
  const compliant = !active || !overdue;

  return { active, compliant, overdue, requiredIntervalDays: NFT_ROOM_COMPLIANCE_REQUIRED_DAYS, lastApprovedAt, nextDeadlineAt, approvedLast60d };
}
