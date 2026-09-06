/**
 * Guest support tickets: nullable user_id + contact fields for pré-login.
 * Safe to re-run (IF NOT EXISTS / DROP NOT NULL only once).
 */
ALTER TABLE support_tickets ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS contact_email TEXT;
CREATE INDEX IF NOT EXISTS support_tickets_contact_email_lower_idx
  ON support_tickets (lower(btrim(contact_email)))
  WHERE user_id IS NULL AND contact_email IS NOT NULL;
