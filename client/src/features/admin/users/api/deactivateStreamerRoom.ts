/**
 * Deactivate streamer room using catalog room id (not a hardcoded constant).
 */
import type { GameState } from '../../lib/adminTypes';
import { deactivateStreamerRoomByAdmin as deactivateStreamerRoomLegacy } from '../../../../shared/api/admin-legacy';

export async function deactivateStreamerRoomByAdminCatalog(
  userId: number,
  currentState: GameState,
  streamerRoomId: string
): Promise<{ ok: boolean; removedRackCount?: number; error?: string }> {
  return deactivateStreamerRoomLegacy(userId, currentState, streamerRoomId);
}
