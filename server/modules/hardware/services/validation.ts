/**
 * Migrado de legacy/backend/modules/batteries/batteries.validation.ts — só o
 * subconjunto de validação (`normalizePlacedRackRoomId` já vive em
 * `modules/mining-engine/services/rack-room-id.ts`, reexportado aqui por
 * conveniência para quem importa deste módulo).
 */
export { normalizePlacedRackRoomId } from '../../mining-engine/services/rack-room-id.js';

const BATTERY_ID_RE = /^[a-zA-Z0-9_.-]{1,200}$/;
const ROOM_ID_MAX_LEN = 120;

/** Sala válida: string não vazia, até 120 chars, sem bytes de controlo nem `<`/`>`. */
export function isValidRoomId(raw: unknown): boolean {
  const s = raw != null ? String(raw).trim() : '';
  // eslint-disable-next-line no-control-regex -- uso deliberado: rejeita bytes de controlo e < > no id de sala.
  return s.length > 0 && s.length <= ROOM_ID_MAX_LEN && !/[\x00-\x1f<>]/.test(s);
}

/** Id de bateria selecionada no bulk: vazio é válido (= "remover todas"); senão precisa bater com `BATTERY_ID_RE`. */
export function isValidBatterySelectionId(raw: unknown): boolean {
  if (raw == null || raw === '') return true;
  const s = String(raw).trim();
  return BATTERY_ID_RE.test(s);
}

/** Só os dois critérios de ordenação suportados no preenchimento em lote. */
export function isValidBatteryRigSort(raw: unknown): boolean {
  return raw === 'slot_asc' || raw === 'hashrate_desc';
}

/** Aceita as variantes truthy que o frontend pode enviar para `smartFill` (bool, 1, '1', 'true'). */
export function parseBooleanSmartFill(raw: unknown): boolean {
  return raw === true || raw === 1 || raw === '1' || raw === 'true';
}
