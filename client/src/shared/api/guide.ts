/**
 * Genesis Miner Guide CMS — public + admin API.
 */
import { apiFetch } from './http';

const base = '/api';


export type GuidePagePayload = {
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

export type GuideCategoryPayload = {
  id: string;
  title: string;
  sortOrder: number;
  isPublished: boolean;
  pages: GuidePagePayload[];
  createdAt: number;
  updatedAt: number;
};

function parseGuidePage(o: unknown): GuidePagePayload | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.title !== 'string') return null;
  return {
    id: r.id,
    categoryId: String(r.categoryId ?? r.category_id ?? ''),
    title: r.title,
    slug: String(r.slug ?? ''),
    contentHtml: String(r.contentHtml ?? r.content_html ?? ''),
    sortOrder: Number(r.sortOrder ?? r.sort_order) || 0,
    isPublished: r.isPublished === true || r.is_published === 1,
    createdAt: Number(r.createdAt ?? r.created_at) || 0,
    updatedAt: Number(r.updatedAt ?? r.updated_at) || 0
  };
}

function parseGuideCategory(o: unknown): GuideCategoryPayload | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.title !== 'string') return null;
  const pagesRaw = Array.isArray(r.pages) ? r.pages : [];
  return {
    id: r.id,
    title: r.title,
    sortOrder: Number(r.sortOrder ?? r.sort_order) || 0,
    isPublished: r.isPublished === true || r.is_published === 1,
    pages: pagesRaw.map(parseGuidePage).filter((x): x is GuidePagePayload => x != null),
    createdAt: Number(r.createdAt ?? r.created_at) || 0,
    updatedAt: Number(r.updatedAt ?? r.updated_at) || 0
  };
}

export async function getGuideContent(): Promise<{ categories: GuideCategoryPayload[] }> {
  try {
    const res = await apiFetch(`${base}/guide`);
    if (!res.ok) return { categories: [] };
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const list = Array.isArray(raw?.categories) ? raw.categories : [];
    return { categories: list.map(parseGuideCategory).filter((x): x is GuideCategoryPayload => x != null) };
  } catch {
    return { categories: [] };
  }
}

export async function getAdminGuideContent(): Promise<{ categories: GuideCategoryPayload[] }> {
  try {
    const res = await apiFetch(`${base}/admin/guide`);
    if (!res.ok) return { categories: [] };
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const list = Array.isArray(raw?.categories) ? raw.categories : [];
    return { categories: list.map(parseGuideCategory).filter((x): x is GuideCategoryPayload => x != null) };
  } catch {
    return { categories: [] };
  }
}

export async function adminCreateGuideCategory(body: { title: string; sortOrder?: number; isPublished?: boolean }) {
  const res = await apiFetch(`${base}/admin/guide/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.ok;
}

export async function adminUpdateGuideCategory(id: string, body: Partial<{ title: string; sortOrder: number; isPublished: boolean }>) {
  const res = await apiFetch(`${base}/admin/guide/categories/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.ok;
}

export async function adminDeleteGuideCategory(id: string) {
  const res = await apiFetch(`${base}/admin/guide/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.ok;
}

export async function adminReorderGuideCategories(orderedIds: string[]) {
  await apiFetch(`${base}/admin/guide/categories/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds })
  });
}

export async function adminCreateGuidePage(body: {
  categoryId: string;
  title: string;
  slug?: string;
  contentHtml?: string;
  sortOrder?: number;
  isPublished?: boolean;
}) {
  const res = await apiFetch(`${base}/admin/guide/pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.ok;
}

export async function adminUpdateGuidePage(
  id: string,
  body: Partial<{ categoryId: string; title: string; slug: string; contentHtml: string; sortOrder: number; isPublished: boolean }>
) {
  const res = await apiFetch(`${base}/admin/guide/pages/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.ok;
}

export async function adminDeleteGuidePage(id: string) {
  const res = await apiFetch(`${base}/admin/guide/pages/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.ok;
}

export async function adminReorderGuidePages(categoryId: string, orderedIds: string[]) {
  await apiFetch(`${base}/admin/guide/pages/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ categoryId, orderedIds })
  });
}

