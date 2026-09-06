/** ID de upgrade (bateria) — mesmo charset que loot box ids. */
const BATTERY_ID_RE = /^[a-zA-Z0-9_.-]{1,200}$/;

export function isValidRoomId(raw: string | null | undefined): boolean {
  const s = raw != null ? String(raw).trim() : '';
  return s.length > 0 && s.length <= 120 && !/[\x00-\x1f<>]/.test(s);
}

export function isValidBatterySelectionId(raw: string | null | undefined): boolean {
  if (raw == null || raw === '') return true;
  const s = String(raw).trim();
  return BATTERY_ID_RE.test(s);
}
