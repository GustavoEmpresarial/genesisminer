/**
 * Migrado de legacy/backend/modules/roadmap/roadmap.service.ts.
 * Revisão pós-migração: ver DECISIONS.md #58.
 */
import crypto from 'node:crypto';
import { prisma } from '../../../core/database/prisma.js';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';

const HTTP_BAD_REQUEST = 400;
const ROADMAP_STATUSES = new Set(['planned', 'in_dev', 'testing', 'done', 'cancelled']);
const DEFAULT_STATUS = 'planned';
const DESCRIPTION_MAX_LENGTH = 8000;
const PLANNED_DATE_MAX_LENGTH = 40;
const IMAGE_URL_MAX_LENGTH = 500;
const ACTIVE_FLAG = 1;
const INACTIVE_FLAG = 0;

function nowMs(): number {
  return Date.now();
}

function requireNonEmptyTitle(raw: unknown): string {
  const title = String(raw || '').trim();
  if (!title) throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Title required.', code: 'VALIDATION' });
  return title;
}

export type RoadmapStepDto = {
  id: string;
  title: string;
  description: string;
  status: string;
  plannedDate: string | null;
  imageUrl: string | null;
  isHighlight: boolean;
  sortOrder: number;
  isPublished: boolean;
  createdAt: number;
  updatedAt: number;
};

function mapStep(row: {
  id: string;
  title: string;
  description: string;
  status: string;
  planned_date: string | null;
  image_url: string | null;
  is_highlight: number;
  sort_order: number;
  is_published: number;
  created_at: bigint;
  updated_at: bigint;
}): RoadmapStepDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    status: ROADMAP_STATUSES.has(row.status) ? row.status : DEFAULT_STATUS,
    plannedDate: row.planned_date,
    imageUrl: row.image_url,
    isHighlight: Number(row.is_highlight) === ACTIVE_FLAG,
    sortOrder: Number(row.sort_order) || 0,
    isPublished: Number(row.is_published) === ACTIVE_FLAG,
    createdAt: Number(row.created_at) || nowMs(),
    updatedAt: Number(row.updated_at) || nowMs()
  };
}

export async function listPublishedRoadmap(): Promise<RoadmapStepDto[]> {
  const rows = await prisma.roadmap_steps.findMany({
    where: { is_published: ACTIVE_FLAG },
    orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }]
  });
  return rows.map(mapStep);
}

export async function listRoadmapAdmin(): Promise<RoadmapStepDto[]> {
  const rows = await prisma.roadmap_steps.findMany({
    orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }]
  });
  return rows.map(mapStep);
}

export type CreateRoadmapStepInput = {
  title: string;
  description?: string;
  status?: string;
  plannedDate?: string | null;
  imageUrl?: string | null;
  isHighlight?: boolean;
  sortOrder?: number;
  isPublished?: boolean;
};

export async function createRoadmapStep(input: CreateRoadmapStepInput): Promise<RoadmapStepDto> {
  const title = requireNonEmptyTitle(input.title);
  const status = ROADMAP_STATUSES.has(String(input.status || '')) ? String(input.status) : DEFAULT_STATUS;
  const t = BigInt(nowMs());
  const row = await prisma.roadmap_steps.create({
    data: {
      id: crypto.randomUUID(),
      title,
      description: String(input.description || '').slice(0, DESCRIPTION_MAX_LENGTH),
      status,
      planned_date: input.plannedDate != null ? String(input.plannedDate).slice(0, PLANNED_DATE_MAX_LENGTH) : null,
      image_url: input.imageUrl != null ? String(input.imageUrl).slice(0, IMAGE_URL_MAX_LENGTH) : null,
      is_highlight: input.isHighlight ? ACTIVE_FLAG : INACTIVE_FLAG,
      sort_order: Number(input.sortOrder) || 0,
      is_published: input.isPublished === false ? INACTIVE_FLAG : ACTIVE_FLAG,
      created_at: t,
      updated_at: t
    }
  });
  return mapStep(row);
}

export type UpdateRoadmapStepInput = Partial<CreateRoadmapStepInput>;

export async function updateRoadmapStep(id: string, input: UpdateRoadmapStepInput): Promise<RoadmapStepDto> {
  const data: Record<string, unknown> = { updated_at: BigInt(nowMs()) };
  if (input.title !== undefined) data.title = requireNonEmptyTitle(input.title);
  if (input.description !== undefined) data.description = String(input.description).slice(0, DESCRIPTION_MAX_LENGTH);
  if (input.status !== undefined) {
    data.status = ROADMAP_STATUSES.has(String(input.status)) ? String(input.status) : DEFAULT_STATUS;
  }
  if (input.plannedDate !== undefined) {
    data.planned_date = input.plannedDate != null ? String(input.plannedDate).slice(0, PLANNED_DATE_MAX_LENGTH) : null;
  }
  if (input.imageUrl !== undefined) {
    data.image_url = input.imageUrl != null ? String(input.imageUrl).slice(0, IMAGE_URL_MAX_LENGTH) : null;
  }
  if (input.isHighlight !== undefined) data.is_highlight = input.isHighlight ? ACTIVE_FLAG : INACTIVE_FLAG;
  if (input.sortOrder !== undefined) data.sort_order = Math.floor(Number(input.sortOrder) || 0);
  if (input.isPublished !== undefined) data.is_published = input.isPublished ? ACTIVE_FLAG : INACTIVE_FLAG;
  const row = await prisma.roadmap_steps.update({ where: { id }, data });
  return mapStep(row);
}

export async function deleteRoadmapStep(id: string): Promise<boolean> {
  try {
    await prisma.roadmap_steps.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

export async function reorderRoadmapSteps(orderedIds: string[]): Promise<void> {
  const updatedAt = BigInt(nowMs());
  // Numa única transação: falha no meio (ex.: id inexistente) não deixa a ordenação
  // parcialmente aplicada — antes era um UPDATE por item fora de transação.
  await prisma.$transaction(
    orderedIds.map((id, i) =>
      prisma.roadmap_steps.update({
        where: { id },
        data: { sort_order: i, updated_at: updatedAt }
      })
    )
  );
}
