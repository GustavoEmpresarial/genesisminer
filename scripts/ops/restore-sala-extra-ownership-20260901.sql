-- Restore SALA EXTRA (`room_1776433944492`) ownership after the 2026-08-31 lock.
-- That room (ex THE LAST ROOM) had allowed_levels including `normal` + almost every plan,
-- so players saw it without user_rig_rooms. Locking to __admin_grant_only__ hid it.
-- Converts the old public gate into explicit posse. Idempotent.
-- Already applied on prod VM 2026-09-01.

BEGIN;

INSERT INTO user_rig_rooms (user_id, room_id, purchased_at, unlocked_slots)
SELECT u.id, 'room_1776433944492', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, 0
FROM users u
WHERE COALESCE(u.is_admin, 0) = 0
ON CONFLICT (user_id, room_id) DO NOTHING;

COMMIT;
