/**
 * Persistência de `ui_display_labels` — GET público + POST admin batch.
 * Comportamento alinhado a `legacy/backend/server.ts` (~4886–4966).
 */
import { prisma } from '../../../core/database/prisma.js';
import { UI_DISPLAY_LABEL_KEY_SET, UI_DISPLAY_LABEL_VALUE_MAX } from './keys.js';

function rowToEntry(key: unknown, value: unknown): { key: string; value: string } | null {
  const k = key != null ? String(key).trim() : '';
  const v = value != null ? String(value).trim() : '';
  if (!k || !v) return null;
  return { key: k, value: v.slice(0, UI_DISPLAY_LABEL_VALUE_MAX) };
}

export async function listAll(): Promise<Record<string, string>> {
  const rows = await prisma.ui_display_labels.findMany({ orderBy: { key: 'asc' } });
  const obj: Record<string, string> = {};
  for (const row of rows) {
    const entry = rowToEntry(row.key, row.value);
    if (entry) obj[entry.key] = entry.value;
  }
  return obj;
}

/**
 * Upsert/delete batch. Unknown keys are skipped (legado).
 * Empty string after trim → DELETE; otherwise UPSERT truncated to max length.
 */
export async function upsertBatch(labels: Record<string, unknown>, nowMs = Date.now()): Promise<Record<string, string>> {
  const at = BigInt(nowMs);
  await prisma.$transaction(async (tx) => {
    for (const [key, rawVal] of Object.entries(labels)) {
      if (!UI_DISPLAY_LABEL_KEY_SET.has(key)) continue;
      const val = typeof rawVal === 'string' ? rawVal.trim().slice(0, UI_DISPLAY_LABEL_VALUE_MAX) : '';
      if (!val) {
        await tx.ui_display_labels.deleteMany({ where: { key } });
      } else {
        await tx.ui_display_labels.upsert({
          where: { key },
          create: { key, value: val, updated_at: at },
          update: { value: val, updated_at: at }
        });
      }
    }
  });
  return listAll();
}
