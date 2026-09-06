/** Migrado de legacy/backend/modules/partners/partnersState.service.ts (verbatim). */
import { encodePartnerYoutubeVideoCursor, parsePartnerYoutubeVideoCursor, partnerYoutubeUtcDayKeyYYYYMMDD, userAccessSetHasPartnerLevel } from './helpers.js';
import {
  countPartnerSubmissionsForUserUtcDay,
  getPartnerAccessLevelIdsLower,
  getPartnerYoutubeApplicationForUser,
  getPartnerYoutubeApprovedByPublicId,
  getPartnerYoutubeCreatorProfile,
  isPartnerYoutubeManualAllowlisted,
  listPartnerYoutubeApprovedPublicCursor,
  listPartnerYoutubeByUser,
  type PartnerYoutubeApprovedPublicRow,
  type PartnerYoutubeByUserRow
} from './model.js';
import { buildPartnerNftRoomStatus } from './profile.js';
import { youtubeEmbedUrl, youtubeThumbnailUrl } from './youtube-url.js';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;
const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 800;
const REJECT_REASON_MAX_LENGTH = 500;
const VIDEO_PUBLIC_ID_MAX_LENGTH = 120;
const MAX_SUBMISSIONS_PER_UTC_DAY = 1;

export type PartnersPublicVideoDto = {
  publicId: string;
  title: string;
  youtubeUrl: string;
  youtubeVideoId: string;
  thumbnailUrl: string;
  embedUrl: string;
  description: string;
  publishedAt: number;
  creator: { displayName: string; channelUrl: string; avatarUrl: string };
};

function mapApprovedRowToPublicDto(row: PartnerYoutubeApprovedPublicRow): PartnersPublicVideoDto {
  const publishedAt = Number(row.reviewed_at ?? row.created_at) || 0;
  const vid = String(row.youtube_video_id || '').trim();
  return {
    publicId: row.id,
    title: String(row.title || '').slice(0, TITLE_MAX_LENGTH),
    youtubeUrl: String(row.youtube_url || ''),
    youtubeVideoId: vid,
    thumbnailUrl: youtubeThumbnailUrl(vid),
    embedUrl: youtubeEmbedUrl(vid),
    description: String(row.description || '').slice(0, DESCRIPTION_MAX_LENGTH),
    publishedAt,
    creator: {
      displayName: String(row.partner_display_name || row.username || '').trim() || 'Parceiro',
      channelUrl: String(row.partner_channel_url || '').trim(),
      avatarUrl: String(row.partner_avatar_url || '').trim()
    }
  };
}

function encodeCursorFromRow(row: PartnerYoutubeApprovedPublicRow): string {
  const ts = Number(row.reviewed_at ?? row.created_at) || 0;
  return encodePartnerYoutubeVideoCursor(ts, row.id);
}

function mapMySubmission(row: PartnerYoutubeByUserRow) {
  return {
    publicId: row.id,
    title: row.title,
    youtubeUrl: row.youtube_url,
    youtubeVideoId: row.youtube_video_id,
    description: row.description || '',
    status: row.status,
    createdAt: Number(row.created_at) || 0,
    reviewedAt: row.reviewed_at != null ? Number(row.reviewed_at) : undefined,
    rejectReasonPublic: row.reject_reason ? String(row.reject_reason).slice(0, REJECT_REASON_MAX_LENGTH) : undefined
  };
}

export async function buildPartnersStatePayload(params: { optionalUserId: number | null; query: { limit?: string; cursor?: string } }): Promise<Record<string, unknown>> {
  const lim = Math.min(MAX_LIMIT, Math.max(1, parseInt(String(params.query.limit || String(DEFAULT_LIMIT)), 10) || DEFAULT_LIMIT));
  const cursorDb = parsePartnerYoutubeVideoCursor(params.query.cursor);

  const rows = await listPartnerYoutubeApprovedPublicCursor(lim, cursorDb);
  const videos = rows.map(mapApprovedRowToPublicDto);
  const nextCursor = rows.length === lim ? encodeCursorFromRow(rows[rows.length - 1]!) : null;

  const page: Record<string, unknown> = { limit: lim, videos, pagination: { nextCursor, limit: lim }, empty: videos.length === 0 && !params.query.cursor };

  const base: Record<string, unknown> = {
    ok: true,
    page: {
      title: 'Parceiros YouTube',
      subtitle: 'Vídeos aprovados pela equipa — vitrine ao estilo comunidade. Parceiros podem enviar até 1 vídeo por dia (UTC).',
      emptyMessage: 'Ainda não há vídeos aprovados. Volta mais tarde!',
      rules: { maxSubmissionsPerUtcDay: MAX_SUBMISSIONS_PER_UTC_DAY, allowedHosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'] }
    },
    showcase: page
  };

  const uid = params.optionalUserId;
  if (!uid) {
    base.auth = { authenticated: false };
    return base;
  }

  const idSet = await getPartnerAccessLevelIdsLower(uid);
  const manualListed = await isPartnerYoutubeManualAllowlisted(uid);
  const isPartner = userAccessSetHasPartnerLevel(idSet) || manualListed;
  const dayKey = partnerYoutubeUtcDayKeyYYYYMMDD(Date.now());
  const usedToday = await countPartnerSubmissionsForUserUtcDay(uid, dayKey);
  const listRows = await listPartnerYoutubeByUser(uid);

  const application = await getPartnerYoutubeApplicationForUser(uid);
  const creatorProfileRow = await getPartnerYoutubeCreatorProfile(uid);
  const nftRoom = isPartner ? await buildPartnerNftRoomStatus(uid) : null;

  base.auth = {
    authenticated: true,
    isPartner,
    canSubmitToday: isPartner && usedToday < MAX_SUBMISSIONS_PER_UTC_DAY,
    submissionsToday: usedToday,
    application: application
      ? {
          id: application.id,
          status: application.status,
          channelName: application.channel_name,
          channelUrl: application.channel_url,
          avatarUrl: application.avatar_url,
          description: application.description,
          createdAt: Number(application.created_at) || 0,
          rejectReason: application.reject_reason ? String(application.reject_reason).slice(0, REJECT_REASON_MAX_LENGTH) : undefined
        }
      : null,
    canApply: !isPartner && (!application || application.status === 'rejected')
  };
  base.creatorProfile = creatorProfileRow
    ? { channelName: creatorProfileRow.channel_name, channelUrl: creatorProfileRow.channel_url, avatarUrl: creatorProfileRow.avatar_url, description: creatorProfileRow.description, canEditChannelUrl: false }
    : null;
  base.nftRoom = nftRoom;
  base.mySubmissions = listRows.map(mapMySubmission);

  return base;
}

export async function getApprovedPartnerVideoByPublicId(publicId: string): Promise<PartnersPublicVideoDto | null> {
  const id = String(publicId || '').trim().slice(0, VIDEO_PUBLIC_ID_MAX_LENGTH);
  if (!id) return null;
  const row = await getPartnerYoutubeApprovedByPublicId(id);
  return row ? mapApprovedRowToPublicDto(row) : null;
}
