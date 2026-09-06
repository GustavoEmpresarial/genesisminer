import { describe, expect, it } from 'vitest';
import { classifyLocation, pathForAuthMode, resolveSessionBoot } from '../../../client/src/app/pathRouting.js';

describe('password reset / email verify deep links', () => {
  it('classifies redefinir-senha (with or without token path) as recovery auth', () => {
    expect(classifyLocation('/redefinir-senha')).toEqual({ kind: 'auth', mode: 'recovery' });
    expect(classifyLocation('/redefinir-senha/abc.def')).toEqual({ kind: 'auth', mode: 'recovery' });
    expect(classifyLocation('/recovery')).toEqual({ kind: 'auth', mode: 'recovery' });
    expect(classifyLocation('/verificar-email')).toEqual({ kind: 'auth', mode: 'recovery' });
    expect(classifyLocation('/verificar-email/tok.en')).toEqual({ kind: 'auth', mode: 'recovery' });
  });

  it('session boot keeps reset links (does not rewrite to /)', () => {
    expect(resolveSessionBoot('/redefinir-senha', null)).toEqual({
      action: 'auth',
      mode: 'recovery'
    });
    expect(resolveSessionBoot('/redefinir-senha/eyJ0.abc', null)).toEqual({
      action: 'auth',
      mode: 'recovery'
    });
    expect(resolveSessionBoot('/verificar-email/tok', null)).toEqual({
      action: 'auth',
      mode: 'recovery'
    });
    // Logged-in user can still open reset / verify links
    expect(resolveSessionBoot('/redefinir-senha?token=x', { isAdmin: false })).toEqual({
      action: 'auth',
      mode: 'recovery'
    });
  });

  it('forgot-password navigation target matches email link prefix', () => {
    expect(pathForAuthMode('recovery')).toBe('/redefinir-senha');
  });
});
