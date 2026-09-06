/**
 * Lock exclusive rooms: only SALA INICIAL is open by default.
 * All other active rooms require admin grant / ownership (`user_rig_rooms`).
 * Safe to re-run.
 */
UPDATE rig_rooms
SET allowed_levels = '["__admin_grant_only__"]'
WHERE id <> 'room_initial';

UPDATE rig_rooms
SET allowed_levels = '[]'
WHERE id = 'room_initial';
