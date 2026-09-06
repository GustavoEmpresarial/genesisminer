/**
 * Guardas de validação/saneamento para persistência de `stored_batteries` em massa
 * (save-game/server-room). Migrado de legacy/backend/lib/saveGameEconomyValidate.ts —
 * só o subconjunto usado por `persistence.ts` (`StoredBatterySaveGuardError`,
 * `sanitizeStoredBatteriesForSavePayload`, `validateStoredBatteryWarehouseRemovalAllowed`).
 * As funções de validação de stock/caixas/daily-actions do arquivo original pertencem
 * ao endpoint de save-game amplo, não migrado ainda.
 */
import type { PoolClient } from 'pg';

/** Alinhado a `RACK_ID_RE` no servidor — IDs de item/instância. */
export const SAVE_GAME_ITEM_ID_RE = /^[a-zA-Z0-9_.-]{1,200}$/;

/** Marcador no payload sanitizado quando `itemId` vem vazio ou inválido. */
export const STORED_BATTERY_CATALOG_PENDING_ID = 'legacy_battery_missing_catalog';

const HTTP_CONFLICT = 409;

/** Erro de guarda ao aplicar remoções em `stored_batteries` (save-game/persistência de sala). */
export class StoredBatterySaveGuardError extends Error {
  readonly httpStatus = HTTP_CONFLICT;
  readonly forceReload = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'StoredBatterySaveGuardError';
  }
}

/** UUIDs/ids de `placed_racks.battery_id` já persistidos na BD (fonte de verdade antes do merge do payload). */
export async function collectBatteryIdsFromPlacedRacksDb(client: PoolClient, uid: number | string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const res = await client.query<{ battery_id: string | null }>(
      `SELECT battery_id FROM placed_racks WHERE user_id = $1 AND battery_id IS NOT NULL AND btrim(battery_id::text) <> ''`,
      [uid]
    );
    for (const row of res.rows || []) {
      const s = String(row.battery_id ?? '').trim();
      if (s) out.add(s);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function collectBatteryIdsFromPlacedRacksPayload(placedRacks: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(placedRacks)) return out;
  for (const r of placedRacks) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const bid = (r as Record<string, unknown>).batteryId;
    if (bid != null && String(bid).trim()) out.add(String(bid).trim());
  }
  return out;
}

/**
 * Com inventário stock-only, linhas soltas de `stored_batteries` podem ser omitidas.
 * Esta guarda deixa de exigir a lista warehouse completa; UUIDs montados ficam
 * protegidos pelo `warehouse-delete` (NOT EXISTS placed_racks).
 */
export async function validateStoredBatteryWarehouseRemovalAllowed(
  _client: PoolClient,
  _uid: number | string,
  _incomingIds: string[],
  _changes: { placedRacks?: unknown },
  adminOverride: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  void adminOverride;
  // Stock-only: loose warehouse rows may be dropped. Mounted UUIDs are protected by warehouse-delete.
  return { ok: true };
}

/**
 * Normaliza o array `storedBatteries` antes de validar/persistir:
 * - deduplica por `id` (mantém a última entrada);
 * - remove entradas cujo `id` já está montado numa rig (`batteryId`),
 *   evitando duplicar a mesma instância montada.
 */
export function sanitizeStoredBatteriesForSavePayload(batteries: unknown[], placedRacks: unknown): unknown[] {
  if (!Array.isArray(batteries)) return [];
  const mounted = new Set<string>([...collectBatteryIdsFromPlacedRacksPayload(placedRacks)]);
  const byId = new Map<string, { id: string; itemId: string }>();
  for (const b of batteries) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    const o = b as Record<string, unknown>;
    const id = o.id != null ? String(o.id).trim() : '';
    let itemId = o.itemId != null ? String(o.itemId).trim() : '';
    if (!SAVE_GAME_ITEM_ID_RE.test(id)) continue;
    if (!itemId || !SAVE_GAME_ITEM_ID_RE.test(itemId)) {
      itemId = STORED_BATTERY_CATALOG_PENDING_ID;
    }
    if (mounted.has(id)) continue;
    byId.set(id, { id, itemId });
  }
  return [...byId.values()];
}
