/**
 * Membership access levels vs mining rooms (`rig_rooms`).
 * Room unlocks must never live as access_levels (SALA *, Sala Extra, …).
 */

const ROOM_NAMED_ACCESS_LEVEL_IDS = new Set([
  'sala_das_asics',
  'one_click',
  'sala_extra'
]);

const ROOM_NAMED_NAME_RE = /^(sala[\s_-]|room[\s_-])/i;

export function isRoomNamedAccessLevel(level: {
  id?: string | null;
  name?: string | null;
}): boolean {
  const id = String(level.id ?? '').trim();
  const name = String(level.name ?? '').trim();
  if (id && ROOM_NAMED_ACCESS_LEVEL_IDS.has(id)) return true;
  if (name && ROOM_NAMED_NAME_RE.test(name)) return true;
  return false;
}

/** Drop fake room-as-plan rows from any access_levels list (API / cache / stale). */
export function filterMembershipAccessLevels<T extends { id?: string | null; name?: string | null }>(
  levels: T[] | null | undefined
): T[] {
  if (!Array.isArray(levels)) return [];
  return levels.filter((l) => !isRoomNamedAccessLevel(l));
}

export function stripRoomNamedIdsFromList(ids: string[] | null | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.filter((id) => {
    const s = String(id ?? '').trim();
    return s && !ROOM_NAMED_ACCESS_LEVEL_IDS.has(s) && !ROOM_NAMED_NAME_RE.test(s);
  });
}
