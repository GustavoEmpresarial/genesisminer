/**
 * Listagem pública de entradas de transparência (pools / despesas / investimentos).
 * Migrado de legacy/backend/server.ts `GET /api/transparency` + mapTransparencyEntryRow.
 */
import { prisma } from '../../../core/database/prisma.js';

export type TransparencyCategory = 'pool' | 'expense' | 'investment' | 'other';

export type TransparencyEntryDto = {
  id: number;
  category: string;
  title: string;
  body?: string;
  amountUsdc?: number;
  linkUrl?: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export function mapTransparencyEntryRow(r: {
  id: number;
  category: string;
  title: string;
  body: string | null;
  amount_usdc: number | null;
  link_url: string | null;
  sort_order: number;
  created_at: bigint | number;
  updated_at: bigint | number;
}): TransparencyEntryDto {
  return {
    id: r.id,
    category: r.category,
    title: r.title,
    body: r.body || undefined,
    amountUsdc: r.amount_usdc != null && Number.isFinite(Number(r.amount_usdc)) ? Number(r.amount_usdc) : undefined,
    linkUrl: r.link_url || undefined,
    sortOrder: r.sort_order != null ? Number(r.sort_order) : 0,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  };
}

export async function listTransparencyEntries(): Promise<TransparencyEntryDto[]> {
  const rows = await prisma.transparency_entries.findMany({
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }]
  });
  return rows.map((row) => mapTransparencyEntryRow(row));
}
