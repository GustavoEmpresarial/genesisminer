-- Texto opcional mostrado no login quando `users.is_blocked` está ligado.
-- Vazio ou NULL mantém a frase genérica do auth.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "block_message" TEXT;
