/**
 * Migrado de legacy/backend/models/partnerYoutubeModel.ts — subconjunto usado
 * pelas rotas de jogador, hoje servidas por genesis-api.
 * `ensurePartnerYoutubeSchema` (DDL manual) não foi portada — as tabelas já
 * existem via migration Prisma. Funções admin-only vivem em `./admin-model.ts`.
 */
import { prisma } from '../../../core/database/prisma.js';

const APPROVED_PUBLIC_QUERY_MAX_LIMIT = 48;
const USER_SUBMISSIONS_TAKE = 50;

export async function getPartnerAccessLevelIdsLower(userId: number): Promise<Set<string>> {
  const id = parseInt(String(userId), 10);
  if (!Number.isFinite(id) || id <= 0) return new Set();
  const r = await prisma.$queryRaw<{ lid: string }[]>`
    SELECT DISTINCT LOWER(TRIM(COALESCE(al, ''))) AS lid FROM (
      SELECT access_level_id::text AS al FROM users WHERE id = ${id}
      UNION ALL
      SELECT access_level_id::text AS al FROM user_access_levels WHERE user_id = ${id}
    ) q WHERE TRIM(COALESCE(al, '')) <> ''
  `;
  return new Set(r.map((row) => String(row.lid || '')));
}

/** Envios no dia civil UTC (via `submit_utc_day`). */
export async function countPartnerSubmissionsForUserUtcDay(userId: number, submitUtcDay: number): Promise<number> {
  return prisma.partner_youtube_submissions.count({ where: { user_id: userId, submit_utc_day: submitUtcDay } });
}

/** Vídeo já na fila ou vitrine — evita duplicar o mesmo ID de vídeo. */
export async function countPartnerYoutubeActiveDuplicateVideo(youtubeVideoId: string): Promise<number> {
  return prisma.partner_youtube_submissions.count({ where: { youtube_video_id: youtubeVideoId, status: { in: ['pending', 'approved'] } } });
}

export type PartnerYoutubeApprovedPublicRow = {
  id: string;
  title: string;
  youtube_url: string;
  youtube_video_id: string;
  description: string;
  created_at: bigint | null;
  reviewed_at: bigint | null;
  user_id: number;
  username: string;
  partner_display_name: string;
  partner_channel_url: string;
  partner_avatar_url: string;
};

export async function listPartnerYoutubeApprovedPublicCursor(limit: number, cursor: { sortTs: bigint; id: string } | null): Promise<PartnerYoutubeApprovedPublicRow[]> {
  const lim = Math.min(APPROVED_PUBLIC_QUERY_MAX_LIMIT, Math.max(1, limit));
  if (!cursor) {
    return prisma.$queryRaw<PartnerYoutubeApprovedPublicRow[]>`
      SELECT s.id, s.title, s.youtube_url, s.youtube_video_id, s.description, s.created_at, s.reviewed_at,
             u.id AS user_id,
             u.username,
             COALESCE(NULLIF(BTRIM(p.channel_name), ''), u.username) AS partner_display_name,
             COALESCE(NULLIF(BTRIM(p.channel_url), ''), '') AS partner_channel_url,
             COALESCE(NULLIF(BTRIM(p.avatar_url), ''), '') AS partner_avatar_url
      FROM partner_youtube_submissions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN partner_youtube_creator_profiles p ON p.user_id = u.id
      WHERE s.status = 'approved'
      ORDER BY COALESCE(s.reviewed_at, s.created_at) DESC, s.id DESC
      LIMIT ${lim}
    `;
  }
  return prisma.$queryRaw<PartnerYoutubeApprovedPublicRow[]>`
    SELECT s.id, s.title, s.youtube_url, s.youtube_video_id, s.description, s.created_at, s.reviewed_at,
           u.id AS user_id,
           u.username,
           COALESCE(NULLIF(BTRIM(p.channel_name), ''), u.username) AS partner_display_name,
           COALESCE(NULLIF(BTRIM(p.channel_url), ''), '') AS partner_channel_url,
           COALESCE(NULLIF(BTRIM(p.avatar_url), ''), '') AS partner_avatar_url
    FROM partner_youtube_submissions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN partner_youtube_creator_profiles p ON p.user_id = u.id
    WHERE s.status = 'approved'
      AND (
        COALESCE(s.reviewed_at, s.created_at) < ${cursor.sortTs}
        OR (COALESCE(s.reviewed_at, s.created_at) = ${cursor.sortTs} AND s.id < ${cursor.id})
      )
    ORDER BY COALESCE(s.reviewed_at, s.created_at) DESC, s.id DESC
    LIMIT ${lim}
  `;
}

export async function getPartnerYoutubeApprovedByPublicId(publicId: string): Promise<PartnerYoutubeApprovedPublicRow | null> {
  const rows = await prisma.$queryRaw<PartnerYoutubeApprovedPublicRow[]>`
    SELECT s.id, s.title, s.youtube_url, s.youtube_video_id, s.description, s.created_at, s.reviewed_at,
           u.id AS user_id,
           u.username,
           COALESCE(NULLIF(BTRIM(p.channel_name), ''), u.username) AS partner_display_name,
           COALESCE(NULLIF(BTRIM(p.channel_url), ''), '') AS partner_channel_url,
           COALESCE(NULLIF(BTRIM(p.avatar_url), ''), '') AS partner_avatar_url
    FROM partner_youtube_submissions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN partner_youtube_creator_profiles p ON p.user_id = u.id
    WHERE s.status = 'approved' AND s.id = ${publicId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getPartnerYoutubeCreatorProfile(userId: number): Promise<{ channel_name: string; channel_url: string; avatar_url: string; description: string } | null> {
  const row = await prisma.partner_youtube_creator_profiles.findUnique({ where: { user_id: userId }, select: { channel_name: true, channel_url: true, avatar_url: true, description: true } });
  if (!row) return null;
  return {
    channel_name: String(row.channel_name ?? '').trim(),
    channel_url: String(row.channel_url ?? '').trim(),
    avatar_url: String(row.avatar_url ?? '').trim(),
    description: String(row.description ?? '').trim()
  };
}

/** Parceiro edita nome e capa — URL do canal permanece intacta. */
export async function updatePartnerYoutubeCreatorProfileEditable(params: { userId: number; channelName: string; avatarUrl: string; updatedAt: number }): Promise<void> {
  await prisma.partner_youtube_creator_profiles.updateMany({
    where: { user_id: params.userId },
    data: { channel_name: params.channelName, avatar_url: params.avatarUrl, updated_at: BigInt(params.updatedAt), updated_by: params.userId }
  });
}

export type PartnerYoutubeByUserRow = {
  id: string;
  title: string;
  youtube_url: string;
  youtube_video_id: string;
  description: string;
  status: string;
  created_at: bigint;
  reviewed_at: bigint | null;
  reject_reason: string | null;
};

export async function listPartnerYoutubeByUser(userId: number): Promise<PartnerYoutubeByUserRow[]> {
  return prisma.partner_youtube_submissions.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
    take: USER_SUBMISSIONS_TAKE,
    select: { id: true, title: true, youtube_url: true, youtube_video_id: true, description: true, status: true, created_at: true, reviewed_at: true, reject_reason: true }
  });
}

export async function insertPartnerYoutubeSubmission(params: { id: string; userId: number; title: string; youtubeUrl: string; youtubeVideoId: string; description: string; createdAt: number; submitUtcDay: number }): Promise<void> {
  await prisma.partner_youtube_submissions.create({
    data: {
      id: params.id,
      user_id: params.userId,
      title: params.title,
      youtube_url: params.youtubeUrl,
      youtube_video_id: params.youtubeVideoId,
      description: params.description,
      status: 'pending',
      created_at: BigInt(params.createdAt),
      submit_utc_day: params.submitUtcDay
    }
  });
}

export async function isPartnerYoutubeManualAllowlisted(userId: number): Promise<boolean> {
  const row = await prisma.partner_youtube_manual_allowlist.findUnique({ where: { user_id: userId }, select: { user_id: true } });
  return row != null;
}

export type PartnerYoutubeApplicationRow = {
  id: string;
  user_id: number;
  channel_name: string;
  channel_url: string;
  avatar_url: string;
  description: string;
  status: string;
  created_at: bigint;
  reviewed_at: bigint | null;
  reject_reason: string | null;
  username?: string;
  email?: string;
};

export async function getPartnerYoutubeApplicationForUser(userId: number): Promise<PartnerYoutubeApplicationRow | null> {
  const rows = await prisma.$queryRaw<PartnerYoutubeApplicationRow[]>`
    SELECT id, user_id, channel_name, channel_url, avatar_url, description, status, created_at, reviewed_at, reject_reason
    FROM partner_youtube_applications WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getPartnerYoutubePendingApplicationForUser(userId: number): Promise<PartnerYoutubeApplicationRow | null> {
  const rows = await prisma.$queryRaw<PartnerYoutubeApplicationRow[]>`
    SELECT id, user_id, channel_name, channel_url, avatar_url, description, status, created_at, reviewed_at, reject_reason
    FROM partner_youtube_applications WHERE user_id = ${userId} AND status = 'pending' ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function insertPartnerYoutubeApplication(params: { id: string; userId: number; channelName: string; channelUrl: string; avatarUrl: string; description: string; createdAt: number }): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO partner_youtube_applications (id, user_id, channel_name, channel_url, avatar_url, description, status, created_at)
    VALUES (${params.id}, ${params.userId}, ${params.channelName}, ${params.channelUrl}, ${params.avatarUrl}, ${params.description}, 'pending', ${BigInt(params.createdAt)})
  `;
}

export async function countPartnerApprovedVideosSince(userId: number, sinceMs: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*)::bigint AS c FROM partner_youtube_submissions
    WHERE user_id = ${userId} AND status = 'approved' AND COALESCE(reviewed_at, created_at) >= ${BigInt(sinceMs)}
  `;
  return Number(rows[0]?.c ?? 0);
}

export async function getPartnerLastApprovedVideoAt(userId: number): Promise<number | null> {
  const row = await prisma.partner_youtube_submissions.findFirst({
    where: { user_id: userId, status: 'approved' },
    orderBy: [{ reviewed_at: 'desc' }, { created_at: 'desc' }],
    select: { reviewed_at: true, created_at: true }
  });
  if (!row) return null;
  const ts = row.reviewed_at != null ? Number(row.reviewed_at) : Number(row.created_at);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

export async function userHasNftRoomAccess(userId: number, roomId: string): Promise<boolean> {
  const n = await prisma.user_rig_rooms.count({ where: { user_id: userId, room_id: roomId } });
  return n > 0;
}
