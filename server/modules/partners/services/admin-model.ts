/**
 * Migrado de legacy/backend/models/partnerYoutubeModel.ts — subconjunto admin-only
 * (listar/aprovar/rejeitar candidaturas e envios, allowlist manual, lookup de
 * utilizador, concessão de acesso NFT room / nível parceiro). Complementa
 * `./model.ts` (funções de jogador, já portadas antes do painel admin existir).
 */
import { prisma } from '../../../core/database/prisma.js';
import { callWalletPartnerYoutubeApprove } from '../../wallet/services/wallet-worker-client.js';

const ADMIN_SUBMISSIONS_LIST_LIMIT = 300;
const ADMIN_APPLICATIONS_LIST_LIMIT = 200;
const USER_LOOKUP_MAX_RESULTS = 3;

export type PartnerYoutubeAdminListRow = {
  id: string;
  user_id: number;
  title: string;
  youtube_url: string;
  youtube_video_id: string;
  description: string;
  status: string;
  created_at: bigint | null;
  reviewed_at: bigint | null;
  reviewed_by: number | null;
  reject_reason: string | null;
  username: string;
  email: string;
};

export async function listPartnerYoutubeSubmissionsForAdmin(
  status: 'all' | 'pending' | 'approved' | 'rejected'
): Promise<PartnerYoutubeAdminListRow[]> {
  if (status === 'all') {
    return prisma.$queryRaw<PartnerYoutubeAdminListRow[]>`
      SELECT s.id, s.user_id, s.title, s.youtube_url, s.youtube_video_id, s.description, s.status, s.created_at,
             s.reviewed_at, s.reviewed_by, s.reject_reason, u.username, u.email
      FROM partner_youtube_submissions s
      JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC
      LIMIT ${ADMIN_SUBMISSIONS_LIST_LIMIT}
    `;
  }
  return prisma.$queryRaw<PartnerYoutubeAdminListRow[]>`
    SELECT s.id, s.user_id, s.title, s.youtube_url, s.youtube_video_id, s.description, s.status, s.created_at,
           s.reviewed_at, s.reviewed_by, s.reject_reason, u.username, u.email
    FROM partner_youtube_submissions s
    JOIN users u ON u.id = s.user_id
    WHERE s.status = ${status}
    ORDER BY s.created_at DESC
    LIMIT ${ADMIN_SUBMISSIONS_LIST_LIMIT}
  `;
}

export async function updatePartnerYoutubeApprove(id: string, adminUserId: number, reviewedAt: number): Promise<number> {
  const out = await callWalletPartnerYoutubeApprove({ id, adminUserId, reviewedAt });
  return out.updated;
}

export async function updatePartnerYoutubeReject(id: string, adminUserId: number, reason: string | null, reviewedAt: number): Promise<number> {
  const r = await prisma.partner_youtube_submissions.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'rejected', reviewed_at: BigInt(reviewedAt), reviewed_by: adminUserId, reject_reason: reason }
  });
  return r.count;
}

/** Remove o envio (qualquer estado). Retorna número de linhas apagadas (0 ou 1). */
export async function deletePartnerYoutubeSubmission(id: string): Promise<number> {
  const r = await prisma.partner_youtube_submissions.deleteMany({ where: { id } });
  return r.count;
}

export async function upsertPartnerYoutubeCreatorProfile(params: {
  userId: number;
  channelName?: string;
  channelUrl: string;
  avatarUrl: string;
  description?: string;
  updatedAt: number;
  updatedBy: number | null;
}): Promise<void> {
  await prisma.partner_youtube_creator_profiles.upsert({
    where: { user_id: params.userId },
    create: {
      user_id: params.userId,
      channel_name: params.channelName ?? '',
      channel_url: params.channelUrl,
      avatar_url: params.avatarUrl,
      description: params.description ?? '',
      updated_at: BigInt(params.updatedAt),
      updated_by: params.updatedBy
    },
    update: {
      ...(params.channelName !== undefined ? { channel_name: params.channelName } : {}),
      channel_url: params.channelUrl,
      avatar_url: params.avatarUrl,
      ...(params.description !== undefined ? { description: params.description } : {}),
      updated_at: BigInt(params.updatedAt),
      updated_by: params.updatedBy
    }
  });
}

export type PartnerYoutubeAdminPartnerRow = {
  user_id: number;
  username: string;
  email: string;
  approved_count: number;
  approved_last_365d: number;
  last_approved_at: bigint | null;
  partner_channel_url: string;
  partner_avatar_url: string;
  is_allowlisted: boolean;
};

const DAYS_PER_YEAR = 365;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const YEAR_MS = DAYS_PER_YEAR * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** Parceiros na vitrine: vídeo aprovado OU entrada manual na allowlist (admin). */
export async function listPartnerYoutubePartnersForAdmin(): Promise<PartnerYoutubeAdminPartnerRow[]> {
  const cutoff365d = BigInt(Date.now() - YEAR_MS);
  return prisma.$queryRaw<PartnerYoutubeAdminPartnerRow[]>`
    WITH partner_user_ids AS (
      SELECT DISTINCT user_id FROM partner_youtube_submissions WHERE status = 'approved'
      UNION
      SELECT user_id FROM partner_youtube_manual_allowlist
    )
    SELECT u.id AS user_id,
           u.username,
           u.email,
           (SELECT COUNT(*)::int FROM partner_youtube_submissions s WHERE s.user_id = u.id AND s.status = 'approved') AS approved_count,
           (SELECT COUNT(*)::int
              FROM partner_youtube_submissions s
             WHERE s.user_id = u.id
               AND s.status = 'approved'
               AND COALESCE(s.reviewed_at, s.created_at) >= ${cutoff365d}) AS approved_last_365d,
           (SELECT MAX(COALESCE(s.reviewed_at, s.created_at))::bigint
              FROM partner_youtube_submissions s
             WHERE s.user_id = u.id
               AND s.status = 'approved') AS last_approved_at,
           COALESCE(NULLIF(BTRIM(p.channel_name), ''), u.username) AS partner_display_name,
           COALESCE(NULLIF(BTRIM(p.channel_url), ''), '') AS partner_channel_url,
           COALESCE(NULLIF(BTRIM(p.avatar_url), ''), '') AS partner_avatar_url,
           EXISTS (SELECT 1 FROM partner_youtube_manual_allowlist m WHERE m.user_id = u.id) AS is_allowlisted
    FROM users u
    INNER JOIN partner_user_ids pu ON pu.user_id = u.id
    LEFT JOIN partner_youtube_creator_profiles p ON p.user_id = u.id
    ORDER BY u.username ASC
  `;
}

/** true = inserido; false = já existia. */
export async function addPartnerYoutubeManualAllowlist(userId: number, addedBy: number | null, addedAt: number): Promise<boolean> {
  const n = await prisma.$executeRaw`
    INSERT INTO partner_youtube_manual_allowlist (user_id, added_at, added_by)
    VALUES (${userId}, ${BigInt(addedAt)}, ${addedBy})
    ON CONFLICT (user_id) DO NOTHING
  `;
  return n > 0;
}

/** true = removido; false = não estava na lista manual. */
export async function removePartnerYoutubeManualAllowlist(userId: number): Promise<boolean> {
  const r = await prisma.partner_youtube_manual_allowlist.deleteMany({ where: { user_id: userId } });
  return r.count > 0;
}

export async function findUserIdsByNormalizedEmail(raw: string): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(${raw})) LIMIT ${USER_LOOKUP_MAX_RESULTS}
  `;
  return rows.map((x) => x.id);
}

export async function findUserIdsByNormalizedUsername(raw: string): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT id FROM users WHERE LOWER(TRIM(username)) = LOWER(TRIM(${raw})) LIMIT ${USER_LOOKUP_MAX_RESULTS}
  `;
  return rows.map((x) => x.id);
}

export async function userExistsById(userId: number): Promise<boolean> {
  const n = await prisma.users.count({ where: { id: userId } });
  return n > 0;
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

export async function listPartnerYoutubeApplicationsForAdmin(
  status: 'all' | 'pending' | 'approved' | 'rejected'
): Promise<PartnerYoutubeApplicationRow[]> {
  if (status === 'all') {
    return prisma.$queryRaw<PartnerYoutubeApplicationRow[]>`
      SELECT a.id, a.user_id, a.channel_name, a.channel_url, a.avatar_url, a.description, a.status,
             a.created_at, a.reviewed_at, a.reject_reason, u.username, u.email
      FROM partner_youtube_applications a
      JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT ${ADMIN_APPLICATIONS_LIST_LIMIT}
    `;
  }
  return prisma.$queryRaw<PartnerYoutubeApplicationRow[]>`
    SELECT a.id, a.user_id, a.channel_name, a.channel_url, a.avatar_url, a.description, a.status,
           a.created_at, a.reviewed_at, a.reject_reason, u.username, u.email
    FROM partner_youtube_applications a
    JOIN users u ON u.id = a.user_id
    WHERE a.status = ${status}
    ORDER BY a.created_at DESC
    LIMIT ${ADMIN_APPLICATIONS_LIST_LIMIT}
  `;
}

export async function getPartnerYoutubeApplicationById(id: string): Promise<PartnerYoutubeApplicationRow | null> {
  const rows = await prisma.$queryRaw<PartnerYoutubeApplicationRow[]>`
    SELECT a.id, a.user_id, a.channel_name, a.channel_url, a.avatar_url, a.description, a.status,
           a.created_at, a.reviewed_at, a.reject_reason, u.username, u.email
    FROM partner_youtube_applications a
    JOIN users u ON u.id = a.user_id
    WHERE a.id = ${id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function updatePartnerYoutubeApplicationApprove(id: string, adminUserId: number, reviewedAt: number): Promise<number> {
  const r = await prisma.$executeRaw`
    UPDATE partner_youtube_applications
       SET status = 'approved', reviewed_at = ${BigInt(reviewedAt)}, reviewed_by = ${adminUserId}, reject_reason = NULL
     WHERE id = ${id} AND status = 'pending'
  `;
  return Number(r) || 0;
}

export async function updatePartnerYoutubeApplicationReject(id: string, adminUserId: number, reason: string | null, reviewedAt: number): Promise<number> {
  const r = await prisma.$executeRaw`
    UPDATE partner_youtube_applications
       SET status = 'rejected', reviewed_at = ${BigInt(reviewedAt)}, reviewed_by = ${adminUserId}, reject_reason = ${reason}
     WHERE id = ${id} AND status = 'pending'
  `;
  return Number(r) || 0;
}

/** Slots iniciais da Sala Streamer ao aprovar parceiro (paridade com legado). */
const PARTNER_NFT_ROOM_UNLOCKED_SLOTS = 4;

export async function grantPartnerNftRoomAccess(userId: number, roomId: string): Promise<void> {
  const now = BigInt(Date.now());
  await prisma.user_rig_rooms.upsert({
    where: { user_id_room_id: { user_id: userId, room_id: roomId } },
    create: { user_id: userId, room_id: roomId, purchased_at: now, unlocked_slots: PARTNER_NFT_ROOM_UNLOCKED_SLOTS },
    update: {}
  });
}

export async function ensurePartnerAccessLevel(userId: number): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO user_access_levels (user_id, access_level_id, granted_at)
    VALUES (${userId}, 'partners', ${BigInt(Date.now())})
    ON CONFLICT (user_id, access_level_id) DO NOTHING
  `;
}
