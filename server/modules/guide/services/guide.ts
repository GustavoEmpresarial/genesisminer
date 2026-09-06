/**
 * Migrado de legacy/backend/modules/guide/guide.service.ts.
 * Revisão pós-migração: ver DECISIONS.md #57.
 */
import crypto from 'node:crypto';
import { prisma } from '../../../core/database/prisma.js';
import { HttpControlledError } from '../../../shared/errors/http-controlled-error.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const ACTIVE_FLAG = 1;
const INACTIVE_FLAG = 0;
const SLUG_MAX_LENGTH = 120;

function nowMs(): number {
  return Date.now();
}

/** Sanitização básica — remove scripts e handlers inline. */
function sanitizeHtml(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

export type GuidePageDto = {
  id: string;
  categoryId: string;
  title: string;
  slug: string;
  contentHtml: string;
  sortOrder: number;
  isPublished: boolean;
  createdAt: number;
  updatedAt: number;
};

export type GuideCategoryDto = {
  id: string;
  title: string;
  sortOrder: number;
  isPublished: boolean;
  pages: GuidePageDto[];
  createdAt: number;
  updatedAt: number;
};

function mapPage(row: { id: string; category_id: string; title: string; slug: string; content_html: string; sort_order: number; is_published: number; created_at: bigint; updated_at: bigint }): GuidePageDto {
  return {
    id: row.id,
    categoryId: row.category_id,
    title: row.title,
    slug: row.slug || '',
    contentHtml: row.content_html || '',
    sortOrder: Number(row.sort_order) || 0,
    isPublished: Number(row.is_published) === ACTIVE_FLAG,
    createdAt: Number(row.created_at) || nowMs(),
    updatedAt: Number(row.updated_at) || nowMs()
  };
}

function mapCategory(row: { id: string; title: string; sort_order: number; is_published: number; created_at: bigint; updated_at: bigint }, pages: GuidePageDto[]): GuideCategoryDto {
  return {
    id: row.id,
    title: row.title,
    sortOrder: Number(row.sort_order) || 0,
    isPublished: Number(row.is_published) === ACTIVE_FLAG,
    pages,
    createdAt: Number(row.created_at) || nowMs(),
    updatedAt: Number(row.updated_at) || nowMs()
  };
}

function groupPagesByCategory(pages: Array<Parameters<typeof mapPage>[0]>): Map<string, GuidePageDto[]> {
  const byCat = new Map<string, GuidePageDto[]>();
  for (const p of pages) {
    const list = byCat.get(p.category_id);
    if (list) list.push(mapPage(p));
    else byCat.set(p.category_id, [mapPage(p)]);
  }
  return byCat;
}

function requireNonEmptyTitle(raw: unknown): string {
  const title = String(raw || '').trim();
  if (!title) throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Title required.', code: 'VALIDATION' });
  return title;
}

async function requireCategory(categoryId: string): Promise<void> {
  const cat = await prisma.guide_categories.findUnique({ where: { id: categoryId }, select: { id: true } });
  if (!cat) throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'Category not found.', code: 'NOT_FOUND' });
}

export async function listPublishedGuide(): Promise<GuideCategoryDto[]> {
  const cats = await prisma.guide_categories.findMany({
    where: { is_published: ACTIVE_FLAG },
    orderBy: [{ sort_order: 'asc' }, { title: 'asc' }]
  });
  const pages = await prisma.guide_pages.findMany({
    where: { is_published: ACTIVE_FLAG, category: { is_published: ACTIVE_FLAG } },
    orderBy: [{ sort_order: 'asc' }, { title: 'asc' }]
  });
  const byCat = groupPagesByCategory(pages);
  return cats.map((c) => mapCategory(c, byCat.get(c.id) || []));
}

export async function listGuideAdmin(): Promise<GuideCategoryDto[]> {
  const cats = await prisma.guide_categories.findMany({
    orderBy: [{ sort_order: 'asc' }, { title: 'asc' }]
  });
  const pages = await prisma.guide_pages.findMany({
    orderBy: [{ sort_order: 'asc' }, { title: 'asc' }]
  });
  const byCat = groupPagesByCategory(pages);
  return cats.map((c) => mapCategory(c, byCat.get(c.id) || []));
}

export type CreateGuideCategoryInput = { title: string; sortOrder?: number; isPublished?: boolean };

export async function createGuideCategory(input: CreateGuideCategoryInput): Promise<GuideCategoryDto> {
  const title = requireNonEmptyTitle(input.title);
  const t = BigInt(nowMs());
  const row = await prisma.guide_categories.create({
    data: {
      id: crypto.randomUUID(),
      title,
      sort_order: Number(input.sortOrder) || 0,
      is_published: input.isPublished === false ? INACTIVE_FLAG : ACTIVE_FLAG,
      created_at: t,
      updated_at: t
    }
  });
  return mapCategory(row, []);
}

export type UpdateGuideCategoryInput = Partial<CreateGuideCategoryInput>;

export async function updateGuideCategory(id: string, input: UpdateGuideCategoryInput): Promise<GuideCategoryDto> {
  const data: Record<string, unknown> = { updated_at: BigInt(nowMs()) };
  if (input.title !== undefined) data.title = requireNonEmptyTitle(input.title);
  if (input.sortOrder !== undefined) data.sort_order = Math.floor(Number(input.sortOrder) || 0);
  if (input.isPublished !== undefined) data.is_published = input.isPublished ? ACTIVE_FLAG : INACTIVE_FLAG;
  const row = await prisma.guide_categories.update({ where: { id }, data });
  const pages = await prisma.guide_pages.findMany({ where: { category_id: id }, orderBy: { sort_order: 'asc' } });
  return mapCategory(
    row,
    pages.map((p) => mapPage(p))
  );
}

export async function deleteGuideCategory(id: string): Promise<boolean> {
  try {
    await prisma.guide_categories.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

export type CreateGuidePageInput = {
  categoryId: string;
  title: string;
  slug?: string;
  contentHtml?: string;
  sortOrder?: number;
  isPublished?: boolean;
};

export async function createGuidePage(input: CreateGuidePageInput): Promise<GuidePageDto> {
  const title = String(input.title || '').trim();
  const categoryId = String(input.categoryId || '').trim();
  if (!title || !categoryId) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Category and title required.', code: 'VALIDATION' });
  }
  await requireCategory(categoryId);
  const t = BigInt(nowMs());
  const row = await prisma.guide_pages.create({
    data: {
      id: crypto.randomUUID(),
      category_id: categoryId,
      title,
      slug: String(input.slug || '').trim().slice(0, SLUG_MAX_LENGTH),
      content_html: sanitizeHtml(input.contentHtml || ''),
      sort_order: Number(input.sortOrder) || 0,
      is_published: input.isPublished ? ACTIVE_FLAG : INACTIVE_FLAG,
      created_at: t,
      updated_at: t
    }
  });
  return mapPage(row);
}

export type UpdateGuidePageInput = Partial<CreateGuidePageInput>;

export async function updateGuidePage(id: string, input: UpdateGuidePageInput): Promise<GuidePageDto> {
  const data: Record<string, unknown> = { updated_at: BigInt(nowMs()) };
  if (input.categoryId !== undefined) {
    const categoryId = String(input.categoryId).trim();
    if (!categoryId) {
      throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Category and title required.', code: 'VALIDATION' });
    }
    await requireCategory(categoryId);
    data.category_id = categoryId;
  }
  if (input.title !== undefined) data.title = requireNonEmptyTitle(input.title);
  if (input.slug !== undefined) data.slug = String(input.slug).trim().slice(0, SLUG_MAX_LENGTH);
  if (input.contentHtml !== undefined) data.content_html = sanitizeHtml(input.contentHtml);
  if (input.sortOrder !== undefined) data.sort_order = Math.floor(Number(input.sortOrder) || 0);
  if (input.isPublished !== undefined) data.is_published = input.isPublished ? ACTIVE_FLAG : INACTIVE_FLAG;
  const row = await prisma.guide_pages.update({ where: { id }, data });
  return mapPage(row);
}

export async function deleteGuidePage(id: string): Promise<boolean> {
  try {
    await prisma.guide_pages.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

export async function reorderGuideCategories(orderedIds: string[]): Promise<void> {
  const updatedAt = BigInt(nowMs());
  // Numa única transação: falha no meio (ex.: id inexistente) não deixa a ordenação
  // parcialmente aplicada — antes era um UPDATE por item fora de transação.
  await prisma.$transaction(
    orderedIds.map((id, i) =>
      prisma.guide_categories.update({
        where: { id },
        data: { sort_order: i, updated_at: updatedAt }
      })
    )
  );
}

export async function reorderGuidePages(categoryId: string, orderedIds: string[]): Promise<void> {
  const catId = String(categoryId || '').trim();
  if (!catId) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Category required.', code: 'VALIDATION' });
  }
  await requireCategory(catId);
  const updatedAt = BigInt(nowMs());
  await prisma.$transaction(
    orderedIds.map((id, i) =>
      prisma.guide_pages.update({
        where: { id },
        data: { sort_order: i, category_id: catId, updated_at: updatedAt }
      })
    )
  );
}
