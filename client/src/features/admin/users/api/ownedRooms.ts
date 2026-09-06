import { apiFetch } from '../../../../shared/api/http';

/** Grant/revoke active mining rooms for a user (`user_rig_rooms`). */
export async function setAdminUserOwnedRooms(
  userId: number,
  roomIds: string[]
): Promise<{
  ok: boolean;
  ownedRoomIds?: string[];
  removedRackCount?: number;
  error?: string;
  code?: string;
}> {
  try {
    const res = await apiFetch(`/api/admin/users/${encodeURIComponent(String(userId))}/rooms`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomIds })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, ...(data as object) };
    }
    return { ok: true, ...(data as object) };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}
