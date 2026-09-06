/**
 * Força mínima de senha — regra compartilhada entre cadastro e troca de senha de perfil.
 *
 * Migrado de legacy/backend/models/profilePasswordPolicy.ts (completo agora que
 * `modules/profile/` — dono de `validateProfileNewPasswordStrength` — migrou).
 */
import { authWorkerBcrypt } from './auth-worker-client.js';
import { rustValidatePasswordStrength } from './auth-rust-bridge.js';
const COMMON_WEAK_PASSWORDS = new Set(
  [
    'password',
    '12345678',
    '123456789',
    'qwerty123',
    'genesis',
    'genesisminer',
    'welcome1',
    'senha123',
    'palavrapasse',
    'abc123456'
  ].map((s) => s.toLowerCase())
);

const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_STRENGTH_MAX_LENGTH = 50;

export type ProfilePasswordStrength = { ok: true } | { ok: false; error: string };

export function validatePasswordStrengthPolicy(newPassword: string): ProfilePasswordStrength {
  const rust = rustValidatePasswordStrength(String(newPassword || ''));
  if (rust) return rust;
  const p = String(newPassword || '');
  if (p.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` };
  }
  if (p.length > PASSWORD_STRENGTH_MAX_LENGTH) {
    return { ok: false, error: 'The new password is too long.' };
  }
  if (COMMON_WEAK_PASSWORDS.has(p.toLowerCase())) {
    return { ok: false, error: 'This password is too common. Choose another.' };
  }
  return { ok: true };
}

/** Regra de troca de senha autenticada: além da força mínima, não pode repetir a senha atual. */
export async function validateProfileNewPasswordStrength(
  newPassword: string,
  currentHash: string | null | undefined
): Promise<ProfilePasswordStrength> {
  const base = validatePasswordStrengthPolicy(newPassword);
  if (!base.ok) return base;
  const p = String(newPassword || '');
  if (currentHash && (await authWorkerBcrypt.compare(p, currentHash))) {
    return { ok: false, error: 'The new password cannot be the same as the current one.' };
  }
  return { ok: true };
}
