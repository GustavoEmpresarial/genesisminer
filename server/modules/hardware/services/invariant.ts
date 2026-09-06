/**
 * Migrado de legacy/backend/modules/batteries/batteryInvariant.service.ts — só
 * `shouldExposeBatteryInInventoryWarehouse` (+ o que ela usa), consumida por
 * `modules/inventory`. As funções de validação/reparo em massa
 * (`assertInventoryHasNoRack`, `assertEquippedAlignedWithRack`,
 * `semanticInventoryWarehouseData`) pertencem ao motor de integridade/save-game
 * em massa (`batteries.integrity.ts`/`batteries.bulk.ts`), não migradas ainda.
 *
 * Sistema de carregamento descontinuado em `20260516180000_battery_uuids_and_purge_charging`:
 * estados restantes são `INVENTORY` (armazém) e `EQUIPPED` (rig).
 */

/** Regex POSIX para UUID de instância (alinhado a `batteries.integrity.ts` legado). */
export const PG_BATTERY_INSTANCE_UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

const BATTERY_STATUS_INVENTORY = 'INVENTORY';
const BATTERY_STATUS_EQUIPPED = 'EQUIPPED';
const BATTERY_STATUS_BROKEN = 'BROKEN';
const BATTERY_STATUS_CONSUMED = 'CONSUMED';
const BATTERY_STATUS_LOCKED = 'LOCKED';

const BATTERY_LOC_WAREHOUSE = 'WAREHOUSE';
/** Alias aceite em legados/especificações (equivale a armazém). */
const BATTERY_LOC_INVENTORY = 'INVENTORY';

const NO_SLOT_INDEX = 0;

/** Uppercase + trim; centraliza a normalização usada para comparar `stored_batteries.status`. */
export function normalizeBatteryStatus(status: string | null | undefined): string {
  return String(status || '').trim().toUpperCase();
}

/** Localização de armazém (migração Fase 3 usa `WAREHOUSE`; texto `INVENTORY` tratado como equivalente). */
function isWarehouseInventoryLocation(location: string | null | undefined): boolean {
  const l = String(location || '').trim().toUpperCase();
  return l === '' || l === BATTERY_LOC_WAREHOUSE || l === BATTERY_LOC_INVENTORY;
}

export type InventoryWarehouseExposeInput = {
  id: string;
  status: string | null;
  location: string | null;
  rack_id?: string | null;
  slot_id?: number | null;
  room_id?: string | null;
};

/**
 * Decide se uma instância pode aparecer como disponível em `GET /api/inventory/state`.
 * Não corrige dados — só classifica (divergências devolvem `ok: false` com `event` para log).
 */
export function shouldExposeBatteryInInventoryWarehouse(b: InventoryWarehouseExposeInput, mountedRackBatteryIds: ReadonlySet<string>): { ok: true } | { ok: false; reason: string; event: string } {
  const id = String(b.id || '').trim();
  if (!id) return { ok: false, reason: 'empty_id', event: 'inventory_battery_skip' };
  if (mountedRackBatteryIds.has(id)) {
    return { ok: false, reason: 'listed_on_placed_rack', event: 'inventory_state_battery_divergence' };
  }
  const st = normalizeBatteryStatus(b.status);
  if (st === BATTERY_STATUS_EQUIPPED) {
    return { ok: false, reason: `status_${st || 'EMPTY'}`, event: 'inventory_state_battery_divergence' };
  }
  if (st === BATTERY_STATUS_CONSUMED || st === BATTERY_STATUS_LOCKED || st === BATTERY_STATUS_BROKEN) {
    return { ok: false, reason: `blocked_${st}`, event: 'inventory_state_battery_blocked' };
  }
  const rk = b.rack_id != null ? String(b.rack_id).trim() : '';
  if (rk) {
    return { ok: false, reason: 'rack_id_on_inventory_semantics', event: 'inventory_state_battery_divergence' };
  }
  const sid = b.slot_id != null ? Number(b.slot_id) : null;
  if (sid != null && Number.isFinite(sid) && sid !== NO_SLOT_INDEX) {
    return { ok: false, reason: 'slot_id_set', event: 'inventory_state_battery_divergence' };
  }
  const rid = b.room_id != null ? String(b.room_id).trim() : '';
  if (rid) {
    return { ok: false, reason: 'room_id_set', event: 'inventory_state_battery_divergence' };
  }
  if (st === BATTERY_STATUS_INVENTORY || st === '') {
    if (!isWarehouseInventoryLocation(b.location)) {
      return { ok: false, reason: 'location_not_warehouse', event: 'inventory_state_battery_divergence' };
    }
    return { ok: true };
  }
  return { ok: false, reason: `unknown_status_${st}`, event: 'inventory_state_battery_divergence' };
}
