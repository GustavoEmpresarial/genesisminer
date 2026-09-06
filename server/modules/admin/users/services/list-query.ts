/**
 * Query params + WHERE da lista admin `GET /api/users` (legado server.ts).
 */
import { MS_PER_MINUTE } from '../../../../shared/utils/time.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const SEARCH_MAX_LENGTH = 120;
export const FILTER_ID_MAX_LENGTH = 80;
const ONLINE_WINDOW_MINUTES = 5;
export const ONLINE_WINDOW_MS = ONLINE_WINDOW_MINUTES * MS_PER_MINUTE;

export type AdminUsersListQuery = {
  page: number;
  limit: number;
  offset: number;
  search: string;
  /** Exact user id (`u.id = $n`); omit when unset / invalid. */
  userId: number | null;
  sortBy: 'creation' | 'alpha';
  sortDir: 'ASC' | 'DESC';
  filterStatus: 'all' | 'online' | 'offline';
  filterLevel: string;
  filterRoom: string;
  filterAdminsOnly: boolean;
};

function intOr(raw: unknown, fallback: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function parsePositiveUserId(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function parseAdminUsersListQuery(q: Record<string, unknown> | undefined | null): AdminUsersListQuery {
  const src = q && typeof q === 'object' ? q : {};
  const pageRaw = intOr(src.page, DEFAULT_PAGE);
  const page = pageRaw < DEFAULT_PAGE ? DEFAULT_PAGE : pageRaw;
  const limitRaw = intOr(src.limit, DEFAULT_LIMIT);
  const limit = Math.min(MAX_LIMIT, Math.max(1, limitRaw || DEFAULT_LIMIT));
  const search = clip(String(src.search ?? '').toLowerCase(), SEARCH_MAX_LENGTH);
  const userId = parsePositiveUserId(src.userId);
  const sortBy = src.sortBy === 'alpha' ? 'alpha' : 'creation';
  const sortDir = String(src.sortDir || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const statusRaw = String(src.filterStatus || 'all');
  const filterStatus: AdminUsersListQuery['filterStatus'] =
    statusRaw === 'online' || statusRaw === 'offline' ? statusRaw : 'all';
  const filterLevelRaw = clip(String(src.filterLevel || 'all').trim(), FILTER_ID_MAX_LENGTH);
  const filterLevel = filterLevelRaw || 'all';
  const filterRoomRaw = clip(String(src.filterRoom || 'all').trim(), FILTER_ID_MAX_LENGTH);
  const filterRoom = filterRoomRaw || 'all';
  const filterAdminsRaw = src.filterAdmins;
  const filterAdminsOnly =
    filterAdminsRaw === '1' || String(filterAdminsRaw || '').toLowerCase() === 'true';
  return {
    page,
    limit,
    offset: (page - 1) * limit,
    search,
    userId,
    sortBy,
    sortDir,
    filterStatus,
    filterLevel,
    filterRoom,
    filterAdminsOnly
  };
}

export function orderByClause(q: AdminUsersListQuery): string {
  if (q.sortBy === 'alpha') return `ORDER BY u.username ${q.sortDir}`;
  return `ORDER BY u.id ${q.sortDir}`;
}

/** EXISTS de sala — mesmo `$n` repetido (legado). */
export function roomFilterSql(paramIdx: number): string {
  return `(
        EXISTS (
          SELECT 1
          FROM user_rig_rooms urr
          WHERE urr.user_id = u.id
            AND urr.room_id = $${paramIdx}
        )
        OR EXISTS (
          SELECT 1
          FROM placed_racks pr
          WHERE pr.user_id = u.id
            AND COALESCE(NULLIF(BTRIM(pr.room_id::text), ''), 'room_initial') = $${paramIdx}
        )
        OR EXISTS (
          SELECT 1
          FROM rig_rooms rr
          WHERE rr.id = $${paramIdx}
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
                    WHERE u.access_level_id IS NOT NULL AND BTRIM(u.access_level_id::text) <> ''
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
      )`;
}

export function buildUsersListWhere(
  q: AdminUsersListQuery,
  nowMs: number
): { whereSql: string; params: unknown[]; nextIdx: number } {
  const whereConditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (q.filterAdminsOnly) {
    whereConditions.push('u.is_admin = 1');
  }

  if (q.userId != null) {
    whereConditions.push(`u.id = $${paramIdx}`);
    params.push(q.userId);
    paramIdx += 1;
  }

  if (q.search) {
    whereConditions.push(
      `(LOWER(u.username) LIKE $${paramIdx} OR LOWER(u.email) LIKE $${paramIdx} OR LOWER(u.polygon_wallet) LIKE $${paramIdx})`
    );
    params.push(`%${q.search}%`);
    paramIdx += 1;
  }

  if (q.filterLevel !== 'all' && q.filterRoom === 'all') {
    whereConditions.push(`u.access_level_id = $${paramIdx}`);
    params.push(q.filterLevel);
    paramIdx += 1;
  }

  if (q.filterRoom !== 'all') {
    whereConditions.push(roomFilterSql(paramIdx));
    params.push(q.filterRoom);
    paramIdx += 1;
  }

  const fiveMinutesAgo = nowMs - ONLINE_WINDOW_MS;
  if (q.filterStatus === 'online') {
    whereConditions.push(`gs.last_updated_at >= $${paramIdx}`);
    params.push(fiveMinutesAgo);
    paramIdx += 1;
  } else if (q.filterStatus === 'offline') {
    whereConditions.push(`(gs.last_updated_at < $${paramIdx} OR gs.last_updated_at IS NULL)`);
    params.push(fiveMinutesAgo);
    paramIdx += 1;
  }

  const whereSql = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
  return { whereSql, params, nextIdx: paramIdx };
}

export function parseAdminPermissionsJson(raw: unknown): string[] {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw === 'object') return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    return [];
  } catch {
    return [];
  }
}
