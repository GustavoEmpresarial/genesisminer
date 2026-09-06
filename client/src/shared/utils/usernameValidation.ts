import { AUTH_USERNAME_MAX, AUTH_USERNAME_MIN } from '../constants/authLimits';

/** Alinhado a `validateSignupUsername` no servidor (`registrationValidation.ts`). Hífen no fim da classe. */
const USERNAME_RE = new RegExp(`^[a-zA-Z0-9_ -]{${AUTH_USERNAME_MIN},${AUTH_USERNAME_MAX}}$`);

export type UsernameFormatResult =
  | { ok: true; username: string }
  | { ok: false; error: string };

export function validateAuthUsernameFormat(raw: unknown): UsernameFormatResult {
  if (raw == null || typeof raw !== 'string') {
    return { ok: false, error: 'Nome de utilizador é obrigatório.' };
  }
  const trimmed = raw.trim();
  if (trimmed.length < AUTH_USERNAME_MIN || trimmed.length > AUTH_USERNAME_MAX) {
    return {
      ok: false,
      error: `O nome de utilizador deve ter entre ${AUTH_USERNAME_MIN} e ${AUTH_USERNAME_MAX} caracteres.`
    };
  }
  if (/[<>'"&`{}\[\]\\/;]/.test(trimmed) || /script/i.test(trimmed)) {
    return { ok: false, error: 'O nome de utilizador contém caracteres não permitidos.' };
  }
  if (!USERNAME_RE.test(trimmed)) {
    return {
      ok: false,
      error: 'Use apenas letras (A–Z), números, espaços, underscore (_) e hífen (-).'
    };
  }
  return { ok: true, username: trimmed };
}
