/**
 * CRUD admin de `transparency_entries` (POST/PUT/DELETE).
 *
 * Migrado de `legacy/backend/server.ts`. O GET público permanece em
 * `modules/transparency` (`mapTransparencyEntryRow` reutilizado).
 * Uma linha por operação — sem multi-tabela.
 */
import { prisma } from '../../../../core/database/prisma.js';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import {
  mapTransparencyEntryRow,
  type TransparencyEntryDto
} from '../../../transparency/services/transparency.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
export const TRANSPARENCY_TITLE_MAX = 300;
export const TRANSPARENCY_BODY_MAX = 8000;
export const TRANSPARENCY_LINK_MAX = 2048;
export const TRANSPARENCY_CATEGORIES = new Set(['pool', 'expense', 'investment', 'other']);

export type TransparencyEntryRow = {
  id: number;
  category: string;
  title: string;
  body: string | null;
  amount_usdc: number | null;
  link_url: string | null;
  sort_order: number;
  created_at: bigint | number;
  updated_at: bigint | number;
};

export type TransparencyWritePlan = {
  category: string;
  title: string;
  body: string | null;
  amount_usdc: number | null;
  link_url: string | null;
  sort_order: number;
};

export function parseTransparencyEntryId(raw: unknown): number {
  const id = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(id) || id < 1) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'ID inválido' });
  }
  return id;
}

function parseSortOrder(sortOrder: unknown): number {
  return Math.floor(Number(sortOrder)) || 0;
}

export function planCreateTransparencyEntry(body: unknown): TransparencyWritePlan {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (!TRANSPARENCY_CATEGORIES.has(String(b.category))) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Categoria inválida' });
  }
  const t = String(b.title || '').trim();
  if (!t) throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Título obrigatório' });
  if (t.length > TRANSPARENCY_TITLE_MAX) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Título longo demais' });
  }
  const desc = b.body != null ? String(b.body).trim() : '';
  if (desc.length > TRANSPARENCY_BODY_MAX) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Descrição longa demais' });
  }
  let amt: number | null = null;
  if (b.amountUsdc !== undefined && b.amountUsdc !== null && String(b.amountUsdc).trim() !== '') {
    const n = Number(b.amountUsdc);
    if (!Number.isFinite(n)) throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Valor USDC inválido' });
    amt = n;
  }
  const link = b.linkUrl != null ? String(b.linkUrl).trim() : '';
  if (link.length > TRANSPARENCY_LINK_MAX) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Link longo demais' });
  }
  return {
    category: String(b.category),
    title: t,
    body: desc || null,
    amount_usdc: amt,
    link_url: link || null,
    sort_order: parseSortOrder(b.sortOrder)
  };
}

export function planUpdateTransparencyEntry(body: unknown, existing: TransparencyEntryRow): TransparencyWritePlan {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (b.category != null && !TRANSPARENCY_CATEGORIES.has(String(b.category))) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Categoria inválida' });
  }

  const t = b.title != null ? String(b.title).trim() : null;
  if (t !== null) {
    if (!t) throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Título obrigatório' });
    if (t.length > TRANSPARENCY_TITLE_MAX) {
      throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Título longo demais' });
    }
  }

  let bodyVal: string | null | undefined = undefined;
  if (b.body !== undefined) {
    const bs = b.body == null ? '' : String(b.body).trim();
    if (bs.length > TRANSPARENCY_BODY_MAX) {
      throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Descrição longa demais' });
    }
    bodyVal = bs || null;
  }

  let amtVal: number | null | undefined = undefined;
  if (b.amountUsdc !== undefined) {
    if (b.amountUsdc === null || (typeof b.amountUsdc === 'string' && b.amountUsdc.trim() === '')) {
      amtVal = null;
    } else {
      const n = Number(b.amountUsdc);
      if (!Number.isFinite(n)) throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Valor USDC inválido' });
      amtVal = n;
    }
  }

  let linkVal: string | null | undefined = undefined;
  if (b.linkUrl !== undefined) {
    const lk = b.linkUrl == null ? '' : String(b.linkUrl).trim();
    if (lk.length > TRANSPARENCY_LINK_MAX) {
      throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Link longo demais' });
    }
    linkVal = lk || null;
  }

  const sortVal = b.sortOrder !== undefined ? parseSortOrder(b.sortOrder) : undefined;

  return {
    category: b.category != null ? String(b.category) : existing.category,
    title: t !== null ? t : existing.title,
    body: bodyVal !== undefined ? bodyVal : existing.body,
    amount_usdc: amtVal !== undefined ? amtVal : existing.amount_usdc,
    link_url: linkVal !== undefined ? linkVal : existing.link_url,
    sort_order: sortVal !== undefined ? sortVal : existing.sort_order
  };
}

export async function createTransparencyEntry(body: unknown, nowMs = Date.now()): Promise<TransparencyEntryDto> {
  const plan = planCreateTransparencyEntry(body);
  const now = BigInt(nowMs);
  const ins = await prisma.transparency_entries.create({
    data: {
      category: plan.category,
      title: plan.title,
      body: plan.body,
      amount_usdc: plan.amount_usdc,
      link_url: plan.link_url,
      sort_order: plan.sort_order,
      created_at: now,
      updated_at: now
    }
  });
  return mapTransparencyEntryRow(ins);
}

export async function updateTransparencyEntry(
  idRaw: unknown,
  body: unknown,
  nowMs = Date.now()
): Promise<TransparencyEntryDto> {
  const id = parseTransparencyEntryId(idRaw);
  const existing = await prisma.transparency_entries.findUnique({ where: { id } });
  if (!existing) throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'Registro não encontrado' });
  const plan = planUpdateTransparencyEntry(body, existing);
  const upd = await prisma.transparency_entries.update({
    where: { id },
    data: {
      category: plan.category,
      title: plan.title,
      body: plan.body,
      amount_usdc: plan.amount_usdc,
      link_url: plan.link_url,
      sort_order: plan.sort_order,
      updated_at: BigInt(nowMs)
    }
  });
  return mapTransparencyEntryRow(upd);
}

export async function deleteTransparencyEntry(idRaw: unknown): Promise<{ ok: true }> {
  const id = parseTransparencyEntryId(idRaw);
  const r = await prisma.transparency_entries.deleteMany({ where: { id } });
  if (r.count === 0) throw new HttpControlledError(HTTP_NOT_FOUND, { error: 'Registro não encontrado' });
  return { ok: true };
}
