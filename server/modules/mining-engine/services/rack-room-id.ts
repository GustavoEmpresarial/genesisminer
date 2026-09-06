/**
 * Normalização de `room_id` de racks — compartilhada entre `mining-engine`,
 * `ranking` e (futuramente) `modules/batteries`.
 *
 * Migrado de legacy/backend/modules/batteries/batteries.validation.ts (só
 * `normalizePlacedRackRoomId` — as demais funções de validação de baterias
 * ficam para quando `modules/batteries` migrar).
 */

/**
 * Sala inicial gratuita do admin — todo utilizador tem acesso sem comprar.
 * Fonte única: `modules/servers` e `modules/player-calculator` importam daqui
 * em vez de redeclararem a string.
 */
export const ROOM_INITIAL_ID = 'room_initial';

/**
 * Sala EXTRA canónica — sempre possuída por jogadores (junto de Inicial + ASICs).
 * Não importar `ASIC_ROOM_ID` aqui (evita ciclo com `room-kind`).
 */
export const EXTRA_ROOM_ID = 'room_1776433944492';

/** Alinha com a sala inicial do admin (`room_initial`). Saves antigos usavam NULL / '' / 'main'. */
export function normalizePlacedRackRoomId(raw: unknown): string {
  const s = raw != null ? String(raw).trim() : '';
  if (!s || s === 'main') return ROOM_INITIAL_ID;
  return s;
}
