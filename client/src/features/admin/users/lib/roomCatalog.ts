/**
 * Admin users — room catalog helpers (active `rig_rooms` only).
 */
export type AdminRoomOption = { id: string; name: string };

/** Free starter room — always available; admin UI must not revoke it. */
export const ROOM_INITIAL_ID = 'room_initial';

const STREAMER_NAME_RE = /streamer/i;

/** Resolve streamer room id from live catalog; null if not among active rooms. */
export function resolveStreamerRoomId(rooms: AdminRoomOption[]): string | null {
  const hit = rooms.find((r) => STREAMER_NAME_RE.test(r.name) || STREAMER_NAME_RE.test(r.id));
  return hit?.id ?? null;
}

export function roomNameById(rooms: AdminRoomOption[], roomId: string | null | undefined): string {
  const id = String(roomId ?? '').trim() || 'room_initial';
  const hit = rooms.find((r) => r.id === id);
  return hit?.name ?? id;
}

export function isActiveRoomId(rooms: AdminRoomOption[], roomId: string | null | undefined): boolean {
  const id = String(roomId ?? '').trim();
  if (!id) return false;
  return rooms.some((r) => r.id === id);
}

/** Normalize legacy aliases to room_initial when present in catalog. */
export function normalizeRoomIdForCatalog(
  rooms: AdminRoomOption[],
  roomId: string | null | undefined
): string {
  const raw = String(roomId ?? '').trim();
  if (!raw || raw === 'main') {
    return rooms.some((r) => r.id === 'room_initial') ? 'room_initial' : rooms[0]?.id || 'room_initial';
  }
  if (isActiveRoomId(rooms, raw)) return raw;
  return raw; // orphan — caller must remap
}

export function ownedRoomsFromIds(
  rooms: AdminRoomOption[],
  ownedIds: string[] | null | undefined
): AdminRoomOption[] {
  const set = new Set((ownedIds || []).map((x) => String(x).trim()).filter(Boolean));
  return rooms.filter((r) => set.has(r.id));
}
