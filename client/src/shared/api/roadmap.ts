/**
 * Roadmap public + admin API.
 */
import { apiFetch } from './http';

const base = '/api';


export type RoadmapStepPayload = {
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

function parseRoadmapStep(o: unknown): RoadmapStepPayload | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.title !== 'string') return null;
  return {
    id: r.id,
    title: r.title,
    description: String(r.description ?? ''),
    status: String(r.status ?? 'planned'),
    plannedDate: r.plannedDate != null ? String(r.plannedDate) : r.planned_date != null ? String(r.planned_date) : null,
    imageUrl: r.imageUrl != null ? String(r.imageUrl) : r.image_url != null ? String(r.image_url) : null,
    isHighlight: r.isHighlight === true || r.is_highlight === 1,
    sortOrder: Number(r.sortOrder ?? r.sort_order) || 0,
    isPublished: r.isPublished === true || r.is_published === 1,
    createdAt: Number(r.createdAt ?? r.created_at) || 0,
    updatedAt: Number(r.updatedAt ?? r.updated_at) || 0
  };
}

export async function getRoadmapSteps(): Promise<{ steps: RoadmapStepPayload[] }> {
  try {
    const res = await apiFetch(`${base}/roadmap`);
    if (!res.ok) return { steps: [] };
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const list = Array.isArray(raw?.steps) ? raw.steps : [];
    return { steps: list.map(parseRoadmapStep).filter((x): x is RoadmapStepPayload => x != null) };
  } catch {
    return { steps: [] };
  }
}

export async function getAdminRoadmapSteps(): Promise<{ steps: RoadmapStepPayload[] }> {
  try {
    const res = await apiFetch(`${base}/admin/roadmap`);
    if (!res.ok) return { steps: [] };
    const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const list = Array.isArray(raw?.steps) ? raw.steps : [];
    return { steps: list.map(parseRoadmapStep).filter((x): x is RoadmapStepPayload => x != null) };
  } catch {
    return { steps: [] };
  }
}

export async function adminCreateRoadmapStep(body: Partial<RoadmapStepPayload>) {
  const res = await apiFetch(`${base}/admin/roadmap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.ok;
}

export async function adminUpdateRoadmapStep(id: string, body: Partial<RoadmapStepPayload>) {
  const res = await apiFetch(`${base}/admin/roadmap/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.ok;
}

export async function adminDeleteRoadmapStep(id: string) {
  const res = await apiFetch(`${base}/admin/roadmap/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.ok;
}

export async function adminReorderRoadmapSteps(orderedIds: string[]) {
  await apiFetch(`${base}/admin/roadmap/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds })
  });
}
