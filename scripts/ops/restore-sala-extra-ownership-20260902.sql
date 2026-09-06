-- Idempotent backfill: SALA EXTRA (`room_1776433944492`) for non-admin players.
-- Same grant as signup (`ensureUserHasDefaultPlayerRooms`). Do NOT re-apply on VM
-- if `restore-sala-extra-ownership-20260901.sql` already ran.

BEGIN;

INSERT INTO user_rig_rooms (user_id, room_id, purchased_at, unlocked_slots)
SELECT u.id, 'room_1776433944492', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, 0
FROM users u
WHERE COALESCE(u.is_admin, 0) = 0
ON CONFLICT (user_id, room_id) DO NOTHING;

COMMIT;
