/**
 * Rotas admin do painel de Parceiros YouTube (`/api/admin/partner-youtube-*`,
 * `/api/admin/partner-videos*`, `/api/admin/partners/*`, `/api/admin/streamer-room-users*`).
 *
 * Migrado de legacy/backend/controllers/partnerYoutubeController.ts (rotas com
 * `isAdmin`, linhas ~369-946). Reaproveita `modules/partners/services/model.ts`
 * (funções de jogador já portadas), `./services/admin-model.ts` (novas funções
 * admin-only) e `./services/admin-apply.ts` (aprovar/rejeitar candidatura).
 *
 * Desativação da Sala Streamer (`deactivateStreamerRoomForUser`) reaproveita
 * `loadUserPlacedRacksWithSlots`/`persistStockStoredBatteriesPlacedRacks`,
 * portados verbatim em `modules/batteries/services/persistence.ts` — não
 * duplica o motor de persistência de racks.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import pool from '../../../core/database/pool.js';
import { sendInternalErrorSafeMessageOrPrisma, respondIfHttpControlledError } from '../../../core/http/error-response.js';
import { resolveRequestUserId } from '../../../core/http/request-user-id.js';
import { callHardwarePersist } from '../../hardware/services/hardware-client.js';
import { loadUserPlacedRacksWithSlots } from '../../hardware/services/persistence.js';
import { getPartnerYoutubeCreatorProfile } from './../services/model.js';
import {
  listPartnerYoutubeSubmissionsForAdmin,
  updatePartnerYoutubeApprove,
  updatePartnerYoutubeReject,
  deletePartnerYoutubeSubmission,
  listPartnerYoutubePartnersForAdmin,
  addPartnerYoutubeManualAllowlist,
  removePartnerYoutubeManualAllowlist,
  findUserIdsByNormalizedEmail,
  findUserIdsByNormalizedUsername,
  userExistsById,
  listPartnerYoutubeApplicationsForAdmin,
  upsertPartnerYoutubeCreatorProfile
} from '../services/admin-model.js';
import { sanitizePartnerCreatorAvatarUrl, sanitizePartnerCreatorChannelUrl, sanitizePartnerChannelName, sanitizePartnerChannelDescription } from '../services/helpers.js';
import { runPartnerYoutubeApplicationApprove, runPartnerYoutubeApplicationReject } from '../services/admin-apply.js';

export type PartnersAdminModuleDeps = { isAdmin: RequestHandler };

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;

const STREAMER_ROOM_ID_CONST = 'room_1766898636697';
const STREAMER_LEVEL_IDS = ['creator', 'tester'];
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const DAY_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const OVERDUE_DAYS = 60;
const REQUIRED_APPROVED_PER_YEAR = 6;
const REQUIRED_INTERVAL_DAYS = 60;
const PARTNER_VIDEO_WINDOW_MS = REQUIRED_INTERVAL_DAYS * DAY_MS;
const DAYS_PER_YEAR = 365;
const YEAR_365D_MS = DAYS_PER_YEAR * DAY_MS;
const REJECT_REASON_MAX_LENGTH = 500;
const SUBMISSION_ID_MAX_LENGTH = 120;
const SUBMISSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

type AdminPartnerRow = {
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

function buildPartnerRoomCompliance(lastApprovedAt: number | null | undefined, approvedLast365d: number) {
  const lastMs = Number(lastApprovedAt) || 0;
  const now = Date.now();
  const nextDeadlineAt = lastMs > 0 ? lastMs + PARTNER_VIDEO_WINDOW_MS : 0;
  const overdue = !lastMs || nextDeadlineAt < now;
  return {
    requiredApprovedPerYear: REQUIRED_APPROVED_PER_YEAR,
    requiredIntervalDays: REQUIRED_INTERVAL_DAYS,
    approvedLast365d: Math.max(0, Number(approvedLast365d) || 0),
    lastApprovedAt: lastMs || null,
    nextDeadlineAt: nextDeadlineAt || null,
    overdue,
    compliant: !overdue
  };
}

async function loadPartnerRowsForUserIds(userIds: number[]): Promise<AdminPartnerRow[]> {
  if (userIds.length === 0) return [];
  const cutoff365d = Date.now() - YEAR_365D_MS;
  const r = await pool.query(
    `SELECT
        u.id AS user_id,
        u.username,
        u.email,
        COALESCE(SUM(CASE WHEN s.status = 'approved' THEN 1 ELSE 0 END), 0)::int AS approved_count,
        COALESCE(
          SUM(
            CASE
              WHEN s.status = 'approved' AND COALESCE(s.reviewed_at, s.created_at) >= $2::bigint THEN 1
              ELSE 0
            END
          ),
          0
        )::int AS approved_last_365d,
        MAX(CASE WHEN s.status = 'approved' THEN COALESCE(s.reviewed_at, s.created_at) ELSE NULL END)::bigint AS last_approved_at,
        COALESCE(NULLIF(BTRIM(p.channel_url), ''), '') AS partner_channel_url,
        COALESCE(NULLIF(BTRIM(p.avatar_url), ''), '') AS partner_avatar_url,
        EXISTS (SELECT 1 FROM partner_youtube_manual_allowlist m WHERE m.user_id = u.id) AS is_allowlisted
     FROM users u
     LEFT JOIN partner_youtube_submissions s ON s.user_id = u.id
     LEFT JOIN partner_youtube_creator_profiles p ON p.user_id = u.id
     WHERE u.id = ANY($1::int[])
     GROUP BY
       u.id, u.username, u.email,
       COALESCE(NULLIF(BTRIM(p.channel_url), ''), ''),
       COALESCE(NULLIF(BTRIM(p.avatar_url), ''), '')
     ORDER BY u.username ASC`,
    [userIds, cutoff365d]
  );
  return r.rows as AdminPartnerRow[];
}

async function loadPartnerNftRoomUserIds(filterUserIds?: number[]): Promise<Set<number>> {
  // Sala STREAMERS — quem tem acesso à room_1766898636697 (níveis tester/creator)
  const roomIds = [STREAMER_ROOM_ID_CONST];
  const hasFilter = Array.isArray(filterUserIds) && filterUserIds.length > 0;
  const sql = hasFilter
    ? `SELECT DISTINCT u.id AS user_id
         FROM users u
        WHERE u.id = ANY($2::int[])
          AND (
            EXISTS (
              SELECT 1
                FROM user_rig_rooms urr
               WHERE urr.user_id = u.id
                 AND urr.room_id = ANY($1::text[])
            )
            OR EXISTS (
              SELECT 1
                FROM placed_racks pr
               WHERE pr.user_id = u.id
                 AND COALESCE(NULLIF(BTRIM(pr.room_id::text), ''), 'room_initial') = ANY($1::text[])
            )
            OR EXISTS (
              SELECT 1
                FROM rig_rooms rr
               WHERE rr.id = ANY($1::text[])
                 AND COALESCE(rr.is_active, 1) = 1
                 AND (
                   COALESCE(NULLIF(BTRIM(rr.allowed_levels), ''), '[]') = '[]'
                   OR EXISTS (
                     SELECT 1
                       FROM jsonb_array_elements_text(COALESCE(NULLIF(BTRIM(rr.allowed_levels), ''), '[]')::jsonb) AS room_lvl(level_id)
                      WHERE LOWER(BTRIM(room_lvl.level_id)) IN (
                        SELECT lvl.level_id
                          FROM (
                            SELECT LOWER(BTRIM(u.access_level_id::text)) AS level_id
                             WHERE u.access_level_id IS NOT NULL
                               AND BTRIM(u.access_level_id::text) <> ''
                            UNION
                            SELECT LOWER(BTRIM(ual.access_level_id::text)) AS level_id
                              FROM user_access_levels ual
                             WHERE ual.user_id = u.id
                               AND ual.access_level_id IS NOT NULL
                               AND BTRIM(ual.access_level_id::text) <> ''
                          ) lvl
                      )
                   )
                 )
            )
          )`
    : `SELECT DISTINCT u.id AS user_id
         FROM users u
        WHERE
          EXISTS (
            SELECT 1
              FROM user_rig_rooms urr
             WHERE urr.user_id = u.id
               AND urr.room_id = ANY($1::text[])
          )
          OR EXISTS (
            SELECT 1
              FROM placed_racks pr
             WHERE pr.user_id = u.id
               AND COALESCE(NULLIF(BTRIM(pr.room_id::text), ''), 'room_initial') = ANY($1::text[])
          )
          OR EXISTS (
            SELECT 1
              FROM rig_rooms rr
             WHERE rr.id = ANY($1::text[])
               AND COALESCE(rr.is_active, 1) = 1
               AND (
                 COALESCE(NULLIF(BTRIM(rr.allowed_levels), ''), '[]') = '[]'
                 OR EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements_text(COALESCE(NULLIF(BTRIM(rr.allowed_levels), ''), '[]')::jsonb) AS room_lvl(level_id)
                    WHERE LOWER(BTRIM(room_lvl.level_id)) IN (
                      SELECT lvl.level_id
                        FROM (
                          SELECT LOWER(BTRIM(u.access_level_id::text)) AS level_id
                           WHERE u.access_level_id IS NOT NULL
                             AND BTRIM(u.access_level_id::text) <> ''
                          UNION
                          SELECT LOWER(BTRIM(ual.access_level_id::text)) AS level_id
                            FROM user_access_levels ual
                           WHERE ual.user_id = u.id
                             AND ual.access_level_id IS NOT NULL
                             AND BTRIM(ual.access_level_id::text) <> ''
                        ) lvl
                    )
                 )
               )
          )`;
  const params = hasFilter ? [roomIds, filterUserIds] : [roomIds];
  const r = await pool.query(sql, params);
  return new Set(
    r.rows
      .map((row: { user_id: unknown }) => Number(row.user_id))
      .filter((v: number) => Number.isFinite(v) && v > 0)
  );
}

async function deactivateStreamerRoomForUser(targetUserId: number, _adminId: number): Promise<{ removedRackCount: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const currentRacks = await loadUserPlacedRacksWithSlots(client, targetUserId);
    const nextRacks = currentRacks.filter((rack) => String(rack.roomId || '').trim() !== STREAMER_ROOM_ID_CONST);
    const removedRackCount = Math.max(0, currentRacks.length - nextRacks.length);

    await callHardwarePersist({ userId: targetUserId, placedRacks: nextRacks });

    await client.query('DELETE FROM user_rig_rooms WHERE user_id = $1 AND room_id = $2', [targetUserId, STREAMER_ROOM_ID_CONST]);

    await client.query(`DELETE FROM user_access_levels WHERE user_id = $1 AND LOWER(BTRIM(access_level_id::text)) = ANY($2::text[])`, [targetUserId, STREAMER_LEVEL_IDS]);

    await client.query(
      `UPDATE users SET access_level_id = 'normal'
        WHERE id = $1 AND LOWER(BTRIM(access_level_id::text)) = ANY($2::text[])`,
      [targetUserId, STREAMER_LEVEL_IDS]
    );

    await client.query('COMMIT');

    return { removedRackCount };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

export function registerPartnersAdminModuleRoutes(app: Express, deps: PartnersAdminModuleDeps): void {
  const { isAdmin } = deps;

  app.post('/api/admin/partner-youtube-allowlist', isAdmin, async (req: Request, res: Response) => {
    const adminId = resolveRequestUserId(req);
    if (!adminId) {
      res.status(HTTP_UNAUTHORIZED).json({ error: 'Não autenticado' });
      return;
    }
    const body = (req.body || {}) as { userId?: unknown; username?: unknown };
    let userId = parseInt(String(body.userId ?? '').trim(), 10);
    if (!Number.isFinite(userId) || userId < 1) {
      const raw = typeof body.username === 'string' ? body.username.trim() : '';
      if (!raw) {
        res.status(HTTP_BAD_REQUEST).json({ error: 'Indica userId ou texto (nome ou email).' });
        return;
      }
      try {
        const ids = raw.includes('@') ? await findUserIdsByNormalizedEmail(raw) : await findUserIdsByNormalizedUsername(raw);
        if (ids.length === 0) {
          res.status(HTTP_NOT_FOUND).json({ error: 'Utilizador não encontrado.' });
          return;
        }
        if (ids.length > 1) {
          res.status(HTTP_BAD_REQUEST).json({ error: 'Vários resultados; escolhe na lista pelo ID ou refina a pesquisa.' });
          return;
        }
        userId = ids[0];
      } catch (e) {
        sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/partner-youtube-allowlist lookup', e, 'Erro ao procurar utilizador.');
        return;
      }
    } else {
      const ok = await userExistsById(userId);
      if (!ok) {
        res.status(HTTP_NOT_FOUND).json({ error: 'Utilizador não encontrado.' });
        return;
      }
    }
    try {
      const inserted = await addPartnerYoutubeManualAllowlist(userId, adminId, Date.now());
      res.json({ ok: true, inserted, userId });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/partner-youtube-allowlist', e, 'Erro ao adicionar à lista.');
    }
  });

  app.delete('/api/admin/partner-youtube-allowlist/:userId', isAdmin, async (req: Request, res: Response) => {
    if (!resolveRequestUserId(req)) {
      res.status(HTTP_UNAUTHORIZED).json({ error: 'Não autenticado' });
      return;
    }
    const targetId = parseInt(String(req.params.userId || '').trim(), 10);
    if (!Number.isFinite(targetId) || targetId < 1) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'ID de utilizador inválido.' });
      return;
    }
    try {
      const removed = await removePartnerYoutubeManualAllowlist(targetId);
      if (!removed) {
        res.status(HTTP_NOT_FOUND).json({ error: 'Este utilizador não está na lista manual.' });
        return;
      }
      res.json({ ok: true, userId: targetId });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'DELETE /api/admin/partner-youtube-allowlist/:userId', e, 'Erro ao remover da lista.');
    }
  });

  app.get('/api/admin/partner-youtube-partners', isAdmin, async (_req: Request, res: Response) => {
    try {
      const basePartnerRows = await listPartnerYoutubePartnersForAdmin();
      const partnerUserIds = basePartnerRows.map((row) => Number(row.user_id)).filter((v) => Number.isFinite(v) && v > 0);
      const nftRoomActiveUserIds = await loadPartnerNftRoomUserIds();
      const missingNftRoomUserIds = Array.from(nftRoomActiveUserIds).filter((uid) => !partnerUserIds.includes(uid));
      const extraRows = await loadPartnerRowsForUserIds(missingNftRoomUserIds);
      const mergedRows = [...basePartnerRows, ...extraRows].sort((a, b) => String(a.username || '').localeCompare(String(b.username || ''), 'pt-PT', { sensitivity: 'base' }));
      res.json({
        partners: mergedRows.map((row) => {
          const hasNftRoom = nftRoomActiveUserIds.has(Number(row.user_id) || 0);
          const compliance = buildPartnerRoomCompliance(row.last_approved_at != null ? Number(row.last_approved_at) : null, Number(row.approved_last_365d) || 0);
          return {
            nftRoom: { ...compliance, active: hasNftRoom, overdue: hasNftRoom ? compliance.overdue : false, compliant: hasNftRoom ? compliance.compliant : true },
            userId: row.user_id,
            username: row.username,
            email: row.email,
            approvedCount: Number(row.approved_count) || 0,
            approvedLast365d: Number(row.approved_last_365d) || 0,
            lastApprovedAt: row.last_approved_at != null ? Number(row.last_approved_at) : null,
            channelUrl: row.partner_channel_url || '',
            avatarUrl: row.partner_avatar_url || '',
            allowlisted: Boolean(row.is_allowlisted)
          };
        })
      });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/partner-youtube-partners', e, 'Erro ao listar parceiros.');
    }
  });

  app.post('/api/admin/partner-youtube-partners/:userId/deactivate-nft-room', isAdmin, async (req: Request, res: Response) => {
    const targetUserId = parseInt(String(req.params.userId || '').trim(), 10);
    const adminId = resolveRequestUserId(req);
    if (!Number.isFinite(targetUserId) || targetUserId < 1) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'ID de utilizador inválido.' });
      return;
    }
    if (!adminId) {
      res.status(HTTP_UNAUTHORIZED).json({ error: 'Não autenticado' });
      return;
    }
    try {
      const { removedRackCount } = await deactivateStreamerRoomForUser(targetUserId, adminId);
      res.json({ ok: true, roomId: STREAMER_ROOM_ID_CONST, removedRackCount });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/partner-youtube-partners/:userId/deactivate-nft-room', e, 'Erro ao desativar a Sala Streamer.');
    }
  });

  app.get(['/api/admin/partner-videos', '/api/admin/partners/submissions'], isAdmin, async (req: Request, res: Response) => {
    const st = String(req.query.status || 'all').toLowerCase();
    const statusFilter = st === 'pending' || st === 'approved' || st === 'rejected' ? (st as 'pending' | 'approved' | 'rejected') : 'all';
    try {
      const subRows = await listPartnerYoutubeSubmissionsForAdmin(statusFilter);
      res.json({
        submissions: subRows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          username: row.username,
          email: row.email,
          title: row.title,
          youtubeUrl: row.youtube_url,
          youtubeVideoId: row.youtube_video_id,
          description: row.description || '',
          status: row.status,
          createdAt: Number(row.created_at) || 0,
          reviewedAt: row.reviewed_at != null ? Number(row.reviewed_at) : undefined,
          reviewedBy: row.reviewed_by,
          rejectReason: row.reject_reason || undefined
        }))
      });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/partner-videos', e, 'Erro ao listar envios.');
    }
  });

  app.post(['/api/admin/partner-videos/:id/approve', '/api/admin/partners/videos/:id/approve'], isAdmin, async (req: Request, res: Response) => {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'ID inválido.' });
      return;
    }
    const adminId = resolveRequestUserId(req);
    if (!adminId) {
      res.status(HTTP_UNAUTHORIZED).json({ error: 'Não autenticado' });
      return;
    }
    try {
      const n = await updatePartnerYoutubeApprove(id, adminId, Date.now());
      if (!n) {
        res.status(HTTP_NOT_FOUND).json({ error: 'Envio não encontrado ou já processado.' });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/partner-videos/:id/approve', e, 'Erro ao aprovar.');
    }
  });

  app.post(['/api/admin/partner-videos/:id/reject', '/api/admin/partners/videos/:id/reject'], isAdmin, async (req: Request, res: Response) => {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'ID inválido.' });
      return;
    }
    const adminId = resolveRequestUserId(req);
    if (!adminId) {
      res.status(HTTP_UNAUTHORIZED).json({ error: 'Não autenticado' });
      return;
    }
    const body = (req.body || {}) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, REJECT_REASON_MAX_LENGTH) : '';
    try {
      const n = await updatePartnerYoutubeReject(id, adminId, reason || null, Date.now());
      if (!n) {
        res.status(HTTP_NOT_FOUND).json({ error: 'Envio não encontrado ou já processado.' });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/partner-videos/:id/reject', e, 'Erro ao recusar.');
    }
  });

  app.get('/api/admin/partner-youtube-creators/:userId', isAdmin, async (req: Request, res: Response) => {
    const uid = parseInt(String(req.params.userId || '').trim(), 10);
    if (!Number.isFinite(uid) || uid < 1) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'ID de utilizador inválido.' });
      return;
    }
    try {
      const row = await getPartnerYoutubeCreatorProfile(uid);
      res.json({ channelUrl: row?.channel_url ?? '', avatarUrl: row?.avatar_url ?? '', channelName: row?.channel_name ?? '', description: row?.description ?? '' });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/partner-youtube-creators/:userId', e, 'Erro ao carregar perfil.');
    }
  });

  app.put('/api/admin/partner-youtube-creators/:userId', isAdmin, async (req: Request, res: Response) => {
    const uid = parseInt(String(req.params.userId || '').trim(), 10);
    if (!Number.isFinite(uid) || uid < 1) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'ID de utilizador inválido.' });
      return;
    }
    const adminId = resolveRequestUserId(req);
    if (!adminId) {
      res.status(HTTP_UNAUTHORIZED).json({ error: 'Não autenticado' });
      return;
    }
    const body = (req.body || {}) as { channelUrl?: unknown; avatarUrl?: unknown; channelName?: unknown; description?: unknown };
    const rawCh = typeof body.channelUrl === 'string' ? body.channelUrl : '';
    const rawAv = typeof body.avatarUrl === 'string' ? body.avatarUrl : '';
    const rawName = typeof body.channelName === 'string' ? body.channelName : undefined;
    const rawDesc = typeof body.description === 'string' ? body.description : undefined;
    const channelUrl = sanitizePartnerCreatorChannelUrl(rawCh);
    const avatarUrl = sanitizePartnerCreatorAvatarUrl(rawAv);
    const channelName = rawName !== undefined ? sanitizePartnerChannelName(rawName) : undefined;
    const description = rawDesc !== undefined ? sanitizePartnerChannelDescription(rawDesc) : undefined;
    if (rawCh.trim() && !channelUrl) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'Link do canal inválido (use https:// no YouTube).' });
      return;
    }
    if (rawAv.trim() && !avatarUrl) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'URL da foto inválida (https:// ou caminho /...).' });
      return;
    }
    try {
      await upsertPartnerYoutubeCreatorProfile({ userId: uid, channelName, channelUrl, avatarUrl, description, updatedAt: Date.now(), updatedBy: adminId });
      res.json({ ok: true, channelUrl, avatarUrl });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'PUT /api/admin/partner-youtube-creators/:userId', e, 'Erro ao guardar perfil (verifica se o utilizador existe).');
    }
  });

  app.get('/api/admin/streamer-room-users', isAdmin, async (_req: Request, res: Response) => {
    try {
      const overdueThresholdMs = Date.now() - OVERDUE_DAYS * DAY_MS;
      const sql = `
        SELECT DISTINCT ON (u.id)
          u.id AS user_id,
          u.username,
          u.email,
          (
            SELECT MAX(pys.created_at)
              FROM partner_youtube_submissions pys
             WHERE pys.user_id = u.id
               AND pys.status = 'approved'
          ) AS last_approved_at,
          (
            SELECT COUNT(*)
              FROM partner_youtube_submissions pys
             WHERE pys.user_id = u.id
               AND pys.status = 'approved'
               AND pys.created_at >= $1
          ) AS approved_last_60d
        FROM users u
        WHERE (
          EXISTS (
            SELECT 1 FROM user_rig_rooms urr
             WHERE urr.user_id = u.id AND urr.room_id = $2
          )
          OR EXISTS (
            SELECT 1 FROM placed_racks pr
             WHERE pr.user_id = u.id
               AND COALESCE(NULLIF(BTRIM(pr.room_id::text), ''), 'room_initial') = $2
          )
        )
        ORDER BY u.id ASC
      `;
      const r = await pool.query(sql, [overdueThresholdMs, STREAMER_ROOM_ID_CONST]);
      const users = r.rows.map((row: { user_id: unknown; username: unknown; email: unknown; last_approved_at: unknown; approved_last_60d: unknown }) => {
        const lastApprovedAt = row.last_approved_at != null ? Number(row.last_approved_at) : null;
        const approvedLast60d = parseInt(String(row.approved_last_60d || '0'), 10);
        const overdue = approvedLast60d === 0;
        return {
          userId: Number(row.user_id),
          username: String(row.username || ''),
          email: String(row.email || ''),
          lastApprovedAt,
          approvedLast60d,
          overdue
        };
      });
      res.json({ users });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/streamer-room-users', e, 'Erro ao listar streamers.');
    }
  });

  app.post('/api/admin/streamer-room-users/:userId/deactivate', isAdmin, async (req: Request, res: Response) => {
    const targetUserId = parseInt(String(req.params.userId || '').trim(), 10);
    const adminId = resolveRequestUserId(req);
    if (!Number.isFinite(targetUserId) || targetUserId < 1) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'ID de utilizador inválido.' });
      return;
    }
    if (!adminId) {
      res.status(HTTP_UNAUTHORIZED).json({ error: 'Não autenticado' });
      return;
    }
    try {
      const { removedRackCount } = await deactivateStreamerRoomForUser(targetUserId, adminId);
      res.json({ ok: true, removedRackCount });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/streamer-room-users/:userId/deactivate', e, 'Erro ao desativar sala streamer.');
    }
  });

  app.delete(['/api/admin/partner-videos/:id', '/api/admin/partners/videos/:id/archive'], isAdmin, async (req: Request, res: Response) => {
    const raw = String(req.params.id || '').trim();
    if (!raw || raw.length > SUBMISSION_ID_MAX_LENGTH || !SUBMISSION_ID_RE.test(raw)) {
      res.status(HTTP_BAD_REQUEST).json({ error: 'ID inválido.' });
      return;
    }
    if (!resolveRequestUserId(req)) {
      res.status(HTTP_UNAUTHORIZED).json({ error: 'Não autenticado' });
      return;
    }
    try {
      const n = await deletePartnerYoutubeSubmission(raw);
      if (!n) {
        res.status(HTTP_NOT_FOUND).json({ error: 'Envio não encontrado.' });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'DELETE /api/admin/partner-videos/:id', e, 'Erro ao apagar.');
    }
  });

  app.get('/api/admin/partner-youtube-applications', isAdmin, async (req: Request, res: Response) => {
    const st = String(req.query.status || 'pending').toLowerCase();
    const statusFilter = st === 'all' || st === 'approved' || st === 'rejected' ? st : 'pending';
    try {
      const rows = await listPartnerYoutubeApplicationsForAdmin(statusFilter as 'all' | 'pending' | 'approved' | 'rejected');
      res.json({
        applications: rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          username: row.username ?? '',
          email: row.email ?? '',
          channelName: row.channel_name,
          channelUrl: row.channel_url,
          avatarUrl: row.avatar_url,
          description: row.description || '',
          status: row.status,
          createdAt: Number(row.created_at) || 0,
          reviewedAt: row.reviewed_at != null ? Number(row.reviewed_at) : undefined,
          rejectReason: row.reject_reason || undefined
        }))
      });
    } catch (e) {
      sendInternalErrorSafeMessageOrPrisma(res, 'GET /api/admin/partner-youtube-applications', e, 'Erro ao listar candidaturas.');
    }
  });

  app.post('/api/admin/partner-youtube-applications/:id/approve', isAdmin, async (req: Request, res: Response) => {
    const id = String(req.params.id || '').trim();
    const adminId = resolveRequestUserId(req);
    if (!id || !adminId) {
      res.status(id ? HTTP_UNAUTHORIZED : HTTP_BAD_REQUEST).json({ error: id ? 'Não autenticado' : 'ID inválido.' });
      return;
    }
    try {
      const { userId } = await runPartnerYoutubeApplicationApprove({ applicationId: id, adminUserId: adminId });
      res.json({ ok: true, userId });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/partner-youtube-applications/:id/approve', e, 'Erro ao aprovar candidatura.');
    }
  });

  app.post('/api/admin/partner-youtube-applications/:id/reject', isAdmin, async (req: Request, res: Response) => {
    const id = String(req.params.id || '').trim();
    const adminId = resolveRequestUserId(req);
    if (!id || !adminId) {
      res.status(id ? HTTP_UNAUTHORIZED : HTTP_BAD_REQUEST).json({ error: id ? 'Não autenticado' : 'ID inválido.' });
      return;
    }
    const body = (req.body || {}) as { reason?: unknown };
    try {
      await runPartnerYoutubeApplicationReject({ applicationId: id, adminUserId: adminId, reasonRaw: body.reason });
      res.json({ ok: true });
    } catch (e) {
      if (respondIfHttpControlledError(res, e)) return;
      sendInternalErrorSafeMessageOrPrisma(res, 'POST /api/admin/partner-youtube-applications/:id/reject', e, 'Erro ao recusar candidatura.');
    }
  });
}
