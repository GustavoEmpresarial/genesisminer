import { describe, expect, it } from 'vitest';
import { sanitizeEmailInput } from '../../../client/src/shared/auth/input.js';
import { validateAuthEmail } from '../../../client/src/shared/auth/validateEmail.js';
import { validateRegisterFields } from '../../../client/src/features/register/lib/registerValidation.js';
import { validateResendEmail } from '../../../client/src/features/login/lib/loginValidation.js';
import { validateRecoveryEmail } from '../../../client/src/features/password-reset/lib/passwordResetValidation.js';

describe('shared auth email validation', () => {
  it('sanitizeEmailInput lowercases and strips junk', () => {
    expect(sanitizeEmailInput('  Foo@Bar.COM ')).toBe('foo@bar.com');
    expect(sanitizeEmailInput('a<script>@x.com')).toBe('ascript@x.com');
  });

  it('validateAuthEmail rejects bad format', () => {
    expect(validateAuthEmail('')).toEqual({ ok: false, key: 'auth.errValidEmail' });
    expect(validateAuthEmail('not-an-email')).toEqual({ ok: false, key: 'auth.errValidEmail' });
    expect(validateAuthEmail('ok@ex.com')).toEqual({ ok: true, email: 'ok@ex.com' });
  });

  it('resend / recovery share the same gate', () => {
    expect(validateResendEmail('bad').ok).toBe(false);
    expect(validateRecoveryEmail('bad').ok).toBe(false);
    expect(validateResendEmail('a@b.co')).toMatchObject({ ok: true, email: 'a@b.co' });
    expect(validateRecoveryEmail('a@b.co')).toEqual({ ok: true, email: 'a@b.co' });
  });

  it('register requires valid email format', () => {
    const bad = validateRegisterFields({
      email: 'not-email',
      password: 'secret1',
      username: 'player',
      confirmPassword: 'secret1',
      referralInput: '',
      acceptedTerms: true,
      turnstileRequired: false,
      turnstileToken: ''
    });
    expect(bad).toEqual({ ok: false, key: 'auth.errValidEmail' });

    const good = validateRegisterFields({
      email: 'player@ex.com',
      password: 'secret1',
      username: 'player',
      confirmPassword: 'secret1',
      referralInput: '',
      acceptedTerms: true,
      turnstileRequired: false,
      turnstileToken: ''
    });
    expect(good).toEqual({ ok: true, email: 'player@ex.com', username: 'player' });
  });
});
