-- Restore SALA ASICs (`room_1775484506874`) ownership after exclusive lock.
-- That room was visible without user_rig_rooms. Locking to __admin_grant_only__
-- hid it; signup never inserted ownership. Converts the old public gate into
-- explicit posse. Idempotent. Do not apply from this workspace — ops on the VM.

BEGIN;

INSERT INTO user_rig_rooms (user_id, room_id, purchased_at, unlocked_slots)
SELECT u.id, 'room_1775484506874', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint, 0
FROM users u
WHERE COALESCE(u.is_admin, 0) = 0
ON CONFLICT (user_id, room_id) DO NOTHING;

COMMIT;
