/**
 * Serviço de avisos no jogo (popup + Mini Blog).
 * Tabelas Prisma mantêm o nome legado `in_app_announcements*` (DDL).
 * Revisão/renomeação: DECISIONS.md #59.
 */
import crypto from 'node:crypto';
import {
  callMiningWorkerAnnouncementAdminList,
  callMiningWorkerAnnouncementCreate,
  callMiningWorkerAnnouncementDelete,
  callMiningWorkerAnnouncementGet,
  callMiningWorkerAnnouncementMarkRead,
  callMiningWorkerAnnouncementMiniBlog,
  callMiningWorkerAnnouncementPending,
  callMiningWorkerAnnouncementUpdate,
  type MiningWorkerAnnouncementRow
} from '../../mining-engine/services/mining-worker-client.js';
import { parseAnnouncementId, parseOptionalHttpsLink, parseOptionalSelfImagePath, validateScheduleRange, type ValidatedCreateAnnouncement, type ValidatedUpdateAnnouncement } from './validation.js';
import type { AnnouncementAdminDto, AnnouncementDto } from './types.js';

const ACTIVE_FLAG = 1;

function nowMs(): number {
  return Date.now();
}

function toPlayerDto(row: { id: string; title: string; message: string; link: string | null; image_url: string | null; priority: number; created_at: bigint }): AnnouncementDto {
  let link: string | null;
  let imageUrl: string | null;
  try {
    link = parseOptionalHttpsLink(row.link);
  } catch {
    link = null;
  }
  try {
    imageUrl = parseOptionalSelfImagePath(row.image_url);
  } catch {
    imageUrl = null;
  }
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    link,
    imageUrl,
    priority: Number(row.priority) || 0,
    createdAt: Number(row.created_at) || nowMs()
  };
}

function workerRowToAdminSource(row: MiningWorkerAnnouncementRow): {
  id: string;
  title: string;
  message: string;
  link: string | null;
  image_url: string | null;
  is_active: number;
  priority: number;
  starts_at: bigint | null;
  ends_at: bigint | null;
  created_at: bigint;
  created_by: number | null;
} {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    link: row.link,
    image_url: row.imageUrl,
    is_active: row.isActive,
    priority: row.priority,
    starts_at: row.startsAt != null ? BigInt(row.startsAt) : null,
    ends_at: row.endsAt != null ? BigInt(row.endsAt) : null,
    created_at: BigInt(row.createdAt),
    created_by: row.createdBy
  };
}

function toAdminDto(
  row: {
    id: string;
    title: string;
    message: string;
    link: string | null;
    image_url: string | null;
    is_active: number;
    priority: number;
    starts_at: bigint | null;
    ends_at: bigint | null;
    created_at: bigint;
    created_by: number | null;
  },
  readCount: number
): AnnouncementAdminDto {
  return {
    ...toPlayerDto(row),
    isActive: Number(row.is_active) === ACTIVE_FLAG,
    startsAt: row.starts_at != null ? Number(row.starts_at) : null,
    endsAt: row.ends_at != null ? Number(row.ends_at) : null,
    createdBy: row.created_by ?? null,
    readCount
  };
}

function workerRowToPlayerSource(row: MiningWorkerAnnouncementRow): {
  id: string;
  title: string;
  message: string;
  link: string | null;
  image_url: string | null;
  priority: number;
  created_at: bigint;
} {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    link: row.link,
    image_url: row.imageUrl,
    priority: row.priority,
    created_at: BigInt(row.createdAt)
  };
}

export async function listPendingAnnouncementsForUser(userId: number): Promise<AnnouncementDto[]> {
  const out = await callMiningWorkerAnnouncementPending({ userId, nowMs: nowMs() });
  return out.rows.map((r) => toPlayerDto(workerRowToPlayerSource(r)));
}

/** Mini Blog: anúncios já lidos pelo utilizador (arquivo após popup). */
export async function listMiniBlogEntriesForUser(userId: number): Promise<AnnouncementDto[]> {
  const out = await callMiningWorkerAnnouncementMiniBlog({ userId, nowMs: nowMs() });
  return out.rows.map((r) => toPlayerDto(workerRowToPlayerSource(r)));
}

export async function dismissAnnouncementForUser(userId: number, announcementIdRaw: string): Promise<'ok' | 'not_found' | 'invalid_id'> {
  let id: string;
  try {
    id = parseAnnouncementId(announcementIdRaw);
  } catch {
    return 'invalid_id';
  }

  const existing = await callMiningWorkerAnnouncementGet(id);
  if (!existing.ok) {
    if (existing.code === 'NOT_FOUND') return 'not_found';
    throw new Error(existing.error);
  }

  const out = await callMiningWorkerAnnouncementMarkRead({ userId, announcementId: id, readAt: nowMs() });
  if (!out.ok) {
    if (out.code === 'NOT_FOUND') return 'not_found';
    throw new Error(out.error);
  }

  return 'ok';
}

export async function listAnnouncementsAdmin(): Promise<AnnouncementAdminDto[]> {
  const out = await callMiningWorkerAnnouncementAdminList();
  return out.rows.map((r) => toAdminDto(workerRowToAdminSource(r), r.readCount));
}

export async function createAnnouncementAdmin(input: ValidatedCreateAnnouncement, createdBy: number | null): Promise<AnnouncementAdminDto> {
  const out = await callMiningWorkerAnnouncementCreate({
    id: crypto.randomUUID(),
    title: input.title,
    message: input.message,
    link: input.link,
    imageUrl: input.imageUrl,
    isActive: input.isActive,
    priority: input.priority,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    createdAt: nowMs(),
    createdBy
  });
  if (!out.ok || !out.row) {
    throw new Error(out.ok ? 'mining worker announcement create empty row' : out.error);
  }
  return toAdminDto(workerRowToAdminSource(out.row), out.readCount ?? 0);
}

export async function updateAnnouncementAdmin(idRaw: string, input: ValidatedUpdateAnnouncement): Promise<AnnouncementAdminDto | null> {
  let announcementId: string;
  try {
    announcementId = parseAnnouncementId(idRaw);
  } catch {
    return null;
  }

  const got = await callMiningWorkerAnnouncementGet(announcementId);
  if (!got.ok) {
    if (got.code === 'NOT_FOUND') return null;
    throw new Error(got.error);
  }
  if (!got.row) return null;
  const existing = workerRowToAdminSource(got.row);

  const mergedStarts = input.startsAt !== undefined ? input.startsAt : existing.starts_at != null ? Number(existing.starts_at) : null;
  const mergedEnds = input.endsAt !== undefined ? input.endsAt : existing.ends_at != null ? Number(existing.ends_at) : null;
  if (input.startsAt !== undefined || input.endsAt !== undefined) {
    validateScheduleRange(mergedStarts, mergedEnds);
  }

  const out = await callMiningWorkerAnnouncementUpdate({
    id: announcementId,
    title: input.title !== undefined ? input.title : existing.title,
    message: input.message !== undefined ? input.message : existing.message,
    link: input.link !== undefined ? input.link : existing.link,
    imageUrl: input.imageUrl !== undefined ? input.imageUrl : existing.image_url,
    isActive: input.isActive !== undefined ? input.isActive : Number(existing.is_active) === ACTIVE_FLAG,
    priority: input.priority !== undefined ? input.priority : existing.priority,
    startsAt: mergedStarts,
    endsAt: mergedEnds
  });
  if (!out.ok || !out.row) {
    if (!out.ok && out.code === 'NOT_FOUND') return null;
    throw new Error(out.ok ? 'mining worker announcement update empty row' : out.error);
  }

  return toAdminDto(workerRowToAdminSource(out.row), out.readCount ?? 0);
}

export async function deleteAnnouncementAdmin(idRaw: string): Promise<boolean> {
  let announcementId: string;
  try {
    announcementId = parseAnnouncementId(idRaw);
  } catch {
    return false;
  }
  const out = await callMiningWorkerAnnouncementDelete(announcementId);
  if (out.ok) return true;
  if (out.code === 'NOT_FOUND') return false;
  throw new Error(out.error);
}
